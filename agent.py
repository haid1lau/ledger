#!/usr/bin/env python3
"""
agent.py - ask questions about your Ledger spending in plain English.

    .venv/bin/python agent.py                                   # chat; type "exit" to quit
    .venv/bin/python agent.py "How much did I spend on food in October?"
    .venv/bin/python agent.py --quiet "..."                     # hide the learning-mode trace
    .venv/bin/python agent.py --db agent_test/test.db --user 1  # use the fake test data instead

It runs on a LOCAL model through any OpenAI-compatible server (Ollama by default), so nothing
leaves your Mac and nothing costs money. AGENT.md explains how the loop works, with a diagram.

Settings (environment variables; the command-line flags override them):
    LEDGER_AGENT_BASE_URL  model server  default http://localhost:11434/v1  (Ollama)
                                         LM Studio is http://localhost:1234/v1
    LEDGER_AGENT_MODEL     model name    default qwen3.8:27b
    LEDGER_AGENT_DB        database      default data/ledger.db (opened read-only)
    LEDGER_AGENT_USER_ID   account id    default: the only account in the database
    LEDGER_AGENT_TODAY     YYYY-MM-DD    default: today's real date (the tests pin it)
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import date
from pathlib import Path

from openai import APIConnectionError, APIStatusError, OpenAI

HERE = Path(__file__).resolve().parent

# ----------------------------------------------------------------------------------------------
# 1. Settings
# ----------------------------------------------------------------------------------------------
BASE_URL = os.environ.get("LEDGER_AGENT_BASE_URL", "http://localhost:11434/v1")
MODEL = os.environ.get("LEDGER_AGENT_MODEL", "qwen3.8:27b")
DB_PATH = os.environ.get("LEDGER_AGENT_DB", str(HERE / "data" / "ledger.db"))
# Local servers ignore the API key, but the openai package refuses to start without one.
# We deliberately do NOT read OPENAI_API_KEY, so a real OpenAI key in your shell is never used.
API_KEY = os.environ.get("LEDGER_AGENT_API_KEY", "not-needed-for-local-models")

MAX_STEPS = 8          # at most 8 trips to the model per question
MAX_ROWS = 50          # at most 50 result rows are sent back to the model
QUERY_TIMEOUT_S = 5    # a query running longer than this is stopped

# The tables the model may see, with a one-line description of each. users and sessions
# (emails, password hashes, login tokens) are deliberately missing: the model never sees them.
TABLES = {
    "expenses": "Each purchase: amount, date, note, tags, and the category it belongs to.",
    "categories": "Spending categories (e.g. Food, Transport) with an optional monthly budget.",
    "incomes": "Money received, such as salary.",
    "rules": "Recurring items (rent, subscriptions, salary) that Ledger adds automatically on their dates.",
}

# Hints about what columns mean. The column NAMES and TYPES still come from the database
# itself (see describe_table), so nothing here can drift out of date silently.
COLUMN_NOTES = {
    "expenses": {
        "cat_id": "category id; join categories ON categories.id = expenses.cat_id to get the name",
        "amount": "amount spent, a positive number in dollars",
        "date": "TEXT 'YYYY-MM-DD'",
        "note": "free-text description, e.g. 'Chicken Rice'",
        "tags": "JSON list stored as TEXT, e.g. '[\"#work\"]' or '[]'; use json_each(expenses.tags)",
        "receipt": "receipt file name, or NULL",
        "rule_id": "the recurring rule that created it (rules.id), or NULL if entered by hand",
    },
    "categories": {
        "name": "category name; comparisons ignore upper/lower case",
        "budget": "monthly budget in dollars; 0 means no budget",
    },
    "incomes": {"amount": "amount received, in dollars", "date": "TEXT 'YYYY-MM-DD'"},
    "rules": {
        "kind": "'expense' or 'income'",
        "cat_id": "categories.id for expense rules, NULL for income",
        "freq": "'weekly', 'monthly' or 'yearly'",
        "next_date": "TEXT 'YYYY-MM-DD': the next date it will be added",
        "active": "1 = active, 0 = paused",
    },
}


# ----------------------------------------------------------------------------------------------
# 2. The database, and the safety rules around it
#
#    Four independent layers, so that one mistake can't cause harm on its own:
#      a) the file is opened READ-ONLY, so SQLite itself refuses any write;
#      b) check_sql() rejects anything that doesn't start with SELECT (or WITH ... SELECT);
#      c) Python's sqlite3 runs only ONE statement per execute(), so "SELECT 1; DROP ..." fails;
#      d) an "authorizer" callback approves every single thing a query wants to touch.
#    On top of that, the model only ever sees per-account VIEWS, never the real tables.
# ----------------------------------------------------------------------------------------------
class SetupError(Exception):
    """A problem to show the person (no database, unclear account), not a crash."""


def open_database(path, user_id=None):
    """Open the database read-only and set up one view per table for a single account."""
    path = Path(path).expanduser().resolve()
    if not path.exists():
        raise SetupError(f"Database not found: {path}")
    # mode=ro in the URI = read-only. as_uri() turns spaces in the path into %20 for us.
    # check_same_thread=False: the web app may run one question's steps on different threads
    # (one at a time), which is safe; SQLite would otherwise refuse.
    conn = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, check_same_thread=False)
    try:
        return conn, _set_up_views(conn, path, user_id)
    except SetupError:
        conn.close()
        raise
    except sqlite3.DatabaseError as e:  # not SQLite at all, or a much older Ledger file
        conn.close()
        raise SetupError(f"{path} doesn't look like a current Ledger database ({e}).") from e


def _set_up_views(conn, path, user_id):
    # Check the file has the tables and the per-account user_id column this relies on.
    for table in ("users", *TABLES):
        cols = {row[1] for row in conn.execute(f"PRAGMA main.table_info({table})")}
        if not cols or (table != "users" and "user_id" not in cols):
            raise SetupError(f"{path} doesn't look like a current Ledger database "
                             f"(table {table!r} is missing or has no accounts). Open it in Ledger once to upgrade it.")

    if user_id is None:  # pick the only account, or ask which one
        ids = [row[0] for row in conn.execute("SELECT id FROM users ORDER BY id")]
        if len(ids) != 1:
            raise SetupError(f"This database has {len(ids)} accounts. Choose one with --user ID "
                             f"(or LEDGER_AGENT_USER_ID). Account ids: {ids}")
        user_id = ids[0]
    user_id = int(user_id)  # an int, so it's safe to put straight into the SQL below

    # Ledger keeps every account in the same tables, told apart by a user_id column. A TEMP VIEW
    # is a saved query that lives only in memory for this connection (so it works even though
    # the file is read-only). Each view has the same name as the real table, shows only this
    # account's rows, and leaves out user_id. The model's "SELECT ... FROM expenses" therefore
    # reads the view, and it can't add up another account's spending even by accident.
    for table in TABLES:
        columns = [row[1] for row in conn.execute(f"PRAGMA main.table_info({table})")
                   if row[1] != "user_id"]
        conn.execute(f"CREATE TEMP VIEW {table} AS SELECT {', '.join(columns)} "
                     f"FROM main.{table} WHERE user_id = {user_id}")
    return user_id


SQLITE_RECURSIVE = getattr(sqlite3, "SQLITE_RECURSIVE", 33)
JSON_FUNCTIONS = {"json_each", "json_tree"}  # table-valued functions used to unpack the tags list


def authorizer(action, arg1, arg2, db_name, source):
    """SQLite calls this while preparing a query, once for every action the query would take.
    We answer SQLITE_OK (allowed) or SQLITE_DENY (the whole query fails). It's an allowlist:
    anything not explicitly allowed here is denied, including INSERT, UPDATE, DELETE, ATTACH,
    PRAGMA, and reading sqlite_master, users or sessions."""
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION, SQLITE_RECURSIVE):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_READ:
        # arg1 = table, arg2 = column, db_name = "main" (the file) or "temp" (our views),
        # source = the view doing the reading, or None if the query reads it directly.
        if db_name == "temp" and arg1 in TABLES:      # the query reads one of our views: fine
            return sqlite3.SQLITE_OK
        if db_name == "main" and source in TABLES:    # ...and the view reads the real table: fine
            return sqlite3.SQLITE_OK
        if db_name is None:                           # a WITH/CTE result the query built itself
            return sqlite3.SQLITE_OK
        if arg1 in JSON_FUNCTIONS:                    # json_each(tags) to unpack the tags list
            return sqlite3.SQLITE_OK
        # Anything else is going around the views, e.g. "SELECT * FROM main.expenses" (all
        # accounts), "SELECT * FROM users", or sqlite_master: refused.
    return sqlite3.SQLITE_DENY


def check_sql(sql):
    """Return a reason to reject the SQL, or None if it looks like a single SELECT."""
    # Skip leading spaces and comments, then look at the first word.
    body = re.sub(r"^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+", "", sql, flags=re.S)
    first_word = body.split(None, 1)[0].upper() if body.strip() else ""
    if first_word not in ("SELECT", "WITH"):
        return "Only a single SELECT statement is allowed (WITH ... SELECT is fine too)."
    return None


def round_floats(row):
    # Money is stored as REAL, so sums come out like 198.85000000000002. Rounding to cents
    # keeps the numbers the model reads (and repeats to you) tidy.
    return [round(v, 2) if isinstance(v, float) else v for v in row]


# ----------------------------------------------------------------------------------------------
# 3. The tools. Each is an ordinary Python function that returns a dict; the loop turns the
#    dict into JSON text for the model. Errors are returned (not raised) so the model can read
#    them and fix its query.
# ----------------------------------------------------------------------------------------------
def list_tables(conn):
    return {"tables": [{"name": name, "description": text} for name, text in TABLES.items()]}


def describe_table(conn, name):
    if name not in TABLES:
        return {"error": f"Unknown table {name!r}. Tables you can use: {', '.join(TABLES)}."}
    notes = COLUMN_NOTES.get(name, {})
    # PRAGMA table_info lists each column as (position, name, type, notnull, default, is_pk).
    columns = [{"name": col[1], "type": col[2], **({"note": notes[col[1]]} if col[1] in notes else {})}
               for col in conn.execute(f"PRAGMA temp.table_info({name})")]
    # Three real rows make formats obvious (dates, tags...) in a way column types can't.
    cur = conn.execute(f"SELECT * FROM {name} ORDER BY id DESC LIMIT 3")
    sample = [dict(zip([d[0] for d in cur.description], round_floats(r))) for r in cur.fetchall()]
    return {"table": name, "columns": columns, "example_rows": sample}


def run_query(conn, sql):
    problem = check_sql(sql)
    if problem:
        return {"error": problem}

    # The progress handler is called every 10,000 SQLite steps; returning 1 cancels the query.
    deadline = time.monotonic() + QUERY_TIMEOUT_S
    conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
    conn.set_authorizer(authorizer)  # only for the model's SQL, not for our own queries above
    try:
        cur = conn.execute(sql.strip().rstrip(";"))
        rows = cur.fetchmany(MAX_ROWS + 1)  # ask for one extra row to find out if there are more
        columns = [d[0] for d in cur.description] if cur.description else []
    except sqlite3.Error as e:
        message = str(e)
        if "interrupted" in message:
            message = f"The query took longer than {QUERY_TIMEOUT_S} seconds and was stopped."
        elif "one statement at a time" in message:
            message = "Only one statement is allowed per query."
        elif "prohibited" in message or "not authorized" in message:
            message += f". Only these tables can be read: {', '.join(TABLES)}."
        return {"error": f"SQL error: {message}"}
    finally:
        conn.set_authorizer(None)
        conn.set_progress_handler(None, 0)

    result = {"columns": columns, "rows": [round_floats(r) for r in rows[:MAX_ROWS]]}
    if len(rows) > MAX_ROWS:
        result["truncated"] = True
        result["note"] = (f"Only the first {MAX_ROWS} rows are shown; the query returned more. "
                          "If you need a total or a count, use SUM/COUNT/GROUP BY instead.")
    elif not rows:
        result["note"] = "The query returned no rows."
    return result


# What the model is told about the tools. This is the "function calling" part: a name, a
# description saying when to use it, and a JSON Schema for the arguments. The model never runs
# anything itself; it can only ASK us to run one of these, and our code decides what happens.
TOOLS = [
    {"type": "function", "function": {
        "name": "list_tables",
        "description": "List the tables in the spending database, with a short description of each.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "describe_table",
        "description": "Show a table's columns, their types, notes on what they mean, and 3 example rows. "
                       "Call this before writing SQL that uses the table.",
        "parameters": {"type": "object",
                       "properties": {"name": {"type": "string", "description": "Table name, e.g. 'expenses'"}},
                       "required": ["name"]},
    }},
    {"type": "function", "function": {
        "name": "run_query",
        "description": f"Run ONE read-only SQLite SELECT query and get the rows back (at most {MAX_ROWS}). "
                       "If it returns an error, fix the SQL and try again.",
        "parameters": {"type": "object",
                       "properties": {"sql": {"type": "string", "description": "A single SQLite SELECT statement"}},
                       "required": ["sql"]},
    }},
]


def parse_arguments(arguments_json):
    """The model sends a tool's arguments as JSON text. Returns a dict, or None if it isn't valid."""
    try:
        args = json.loads(arguments_json or "{}")
    except json.JSONDecodeError:
        return None
    return args if isinstance(args, dict) else None


def call_tool(conn, name, args, arguments_json=""):
    """Run the tool the model asked for. Always returns a dict, never raises: whatever goes
    wrong becomes an error message the model can read and react to."""
    if args is None:
        return {"error": f"Your arguments were not valid JSON: {arguments_json!r}"}
    try:
        if name == "list_tables":
            return list_tables(conn)
        if name == "describe_table":
            return describe_table(conn, str(args.get("name", "")))
        if name == "run_query":
            return run_query(conn, str(args.get("sql", "")))
    except Exception as e:  # e.g. text SQLite can't encode; run_query has already reset its guards
        return {"error": f"{type(e).__name__}: {e}"}
    return {"error": f"There is no tool called {name!r}. Use list_tables, describe_table or run_query."}


# ----------------------------------------------------------------------------------------------
# 4. Learning mode: print what the agent does, in colour. --quiet turns all of this off.
# ----------------------------------------------------------------------------------------------
USE_COLOUR = sys.stdout.isatty() and "NO_COLOR" not in os.environ
COLOURS = {"dim": "2", "cyan": "36", "yellow": "33", "red": "31", "green": "32", "bold": "1"}


def paint(text, colour):
    return f"\033[{COLOURS[colour]}m{text}\033[0m" if USE_COLOUR else text


class Trace:
    """Prints the agent's events (see agent_steps below) in the terminal."""
    def __init__(self, quiet=False):
        self.quiet = quiet

    def show(self, text, colour="dim"):
        if not self.quiet:
            print(paint(text, colour))

    def handle(self, event):
        kind = event["type"]
        if kind == "step":
            self.show(f"step {event['n']}/{event['max']}", "bold")
        elif kind == "thinking":
            text = " ".join(event["text"].split())
            self.show(f"  thinking: {text[:240]}{'…' if len(text) > 240 else ''}", "dim")
        elif kind == "tool_call":
            self.tool_call(event["name"], event["args"])
        elif kind == "tool_result":
            self.tool_result(event["result"])

    def tool_call(self, name, args):
        if name == "run_query" and isinstance(args, dict) and "sql" in args:
            self.show(f"  → run_query", "cyan")
            for line in str(args["sql"]).strip().splitlines():
                self.show(f"      {line}", "yellow")
        else:
            shown = ", ".join(f"{k}={v!r}" for k, v in args.items()) if isinstance(args, dict) else args
            self.show(f"  → {name}({shown})", "cyan")

    def tool_result(self, result):
        if "error" in result:
            self.show(f"    ✗ {result['error']}", "red")
        elif "rows" in result:
            n, more = len(result["rows"]), " (cut off; there were more)" if result.get("truncated") else ""
            self.show(f"    ← {n} row{'s' * (n != 1)}{more}: {', '.join(result['columns'])}", "dim")
            for row in result["rows"][:5]:
                self.show(f"      {row}", "dim")
            if n > 5:
                self.show(f"      … {n - 5} more", "dim")
        elif "tables" in result:
            self.show(f"    ← {', '.join(t['name'] for t in result['tables'])}", "dim")
        elif "columns" in result:
            self.show(f"    ← {', '.join(c['name'] + ' ' + c['type'] for c in result['columns'])}", "dim")


# ----------------------------------------------------------------------------------------------
# 5. The agent loop: the heart of the whole thing. Read this part slowly.
# ----------------------------------------------------------------------------------------------
def system_prompt(today):
    return f"""You answer questions about the user's personal spending, stored in a SQLite database.
Today is {today.isoformat()} ({today:%A}).

How to work:
- First use list_tables and describe_table to learn the tables and columns. Never guess column names.
- Then use run_query to run a SQLite SELECT. Read the result. If there's an error, or the result looks
  wrong or empty, fix the query and run it again.
- Every number in your answer must come from a query result. Never estimate or invent numbers.

Dates:
- Dates are TEXT in 'YYYY-MM-DD' form. For a whole month use, e.g.,
  date >= '2026-10-01' AND date < '2026-11-01'   (or strftime('%Y-%m', date) = '2026-10').
- "This month" is the month containing today (so far); "last month" is the calendar month before it.
- A month named without a year means its most recent occurrence that isn't after today.

Answering:
- Reply in plain English, briefly, with amounts to 2 decimal places (e.g. $1,234.50).
- Mention the period you used (e.g. "October 2026") so the user can check it.
- Don't show the SQL in your answer. If there's no matching data, say so plainly."""


def agent_steps(question, conn, client, model, today, history=()):
    """The agent loop. It's a GENERATOR: each `yield` hands back one event (a small dict) the
    moment it happens, then carries on from that line when asked for the next one. The terminal
    prints the events (see ask() below); the web app streams them to the browser. The events:
        {"type": "step", "n": 1, "max": 8}                   a new trip to the model begins
        {"type": "thinking", "text": "..."}                  the model's reasoning, if it shares it
        {"type": "tool_call", "name": "run_query", "args": {"sql": "..."}}
        {"type": "tool_result", "name": "run_query", "result": {"columns": [...], "rows": [...]}}
        {"type": "answer", "text": "...", "steps": 4}        the final answer; always the last event
    """
    # `messages` is the conversation so far: a plain Python list that we send IN FULL on every
    # step. The model remembers nothing between calls; everything it knows is in this list.
    #   system    = standing instructions        user = the question
    #   assistant = the model's replies (some are tool requests)
    #   tool      = the results we send back, each tagged with the request it answers
    messages = [{"role": "system", "content": system_prompt(today)}]
    for old_question, old_answer in history:  # earlier Q&A, so follow-ups like "and in May?" work
        messages += [{"role": "user", "content": old_question}, {"role": "assistant", "content": old_answer}]
    messages.append({"role": "user", "content": question})

    for step in range(1, MAX_STEPS + 1):
        last_step = step == MAX_STEPS
        yield {"type": "step", "n": step, "max": MAX_STEPS}

        # On the last step we don't offer tools at all, so the model has to answer with
        # what it has found so far, instead of being cut off mid-search with nothing.
        if last_step:
            messages.append({"role": "user", "content": "That was your last tool step. Answer now using "
                             "the results you already have, and say so if you couldn't find the answer."})

        # ---- (1) Send the whole conversation, plus the tool menu, to the model. ----
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            **({} if last_step else {"tools": TOOLS}),
            temperature=0,  # always pick the most likely next word: same question, same answer
        )
        reply = response.choices[0].message
        # Thinking models (like Qwen) return their reasoning separately; show it, don't keep it.
        reasoning = (reply.model_extra or {}).get("reasoning") or ""
        if reasoning.strip():
            yield {"type": "thinking", "text": reasoning}

        # ---- (2) Add the model's reply to the conversation, so the next step can see it. ----
        content = re.sub(r"<think>.*?</think>", "", reply.content or "", flags=re.S).strip()
        assistant_message = {"role": "assistant", "content": content}
        if reply.tool_calls:
            assistant_message["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in reply.tool_calls]
        messages.append(assistant_message)

        # ---- (3) No tool requested? Then this reply is the final answer: we're done. ----
        if not reply.tool_calls:
            yield {"type": "answer", "text": content or "(The model gave an empty answer.)", "steps": step}
            return

        # ---- (4) Otherwise run every tool it asked for and add each result to the conversation.
        #      Errors go back too: "no such column: categry" is exactly what the model needs to
        #      see in order to fix its query on the next step. ----
        for call in reply.tool_calls:
            name, arguments = call.function.name, call.function.arguments
            args = parse_arguments(arguments)
            yield {"type": "tool_call", "name": name, "args": args if args is not None else arguments}
            result = call_tool(conn, name, args, arguments)
            yield {"type": "tool_result", "name": name, "result": result}
            messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result, default=str)})
        # ---- (5) ...and loop: the model reads the results and decides what to do next. ----

    yield {"type": "answer", "steps": MAX_STEPS,
           "text": f"I stopped after {MAX_STEPS} steps without a final answer. Try asking more specifically."}


def ask(question, conn, client, model, today, history=(), trace=None):
    """Run the loop to the end and return {"answer", "steps", "queries"}. Used by the terminal and
    the tests; `trace` prints each event as it arrives (pass none to stay silent)."""
    trace = trace or Trace(quiet=True)
    queries, last_args = [], None
    for event in agent_steps(question, conn, client, model, today, history):
        trace.handle(event)
        if event["type"] == "tool_call":
            last_args = event["args"]
        elif event["type"] == "tool_result" and event["name"] == "run_query":
            queries.append({"arguments": last_args, "ok": "error" not in event["result"]})
        elif event["type"] == "answer":
            return {"answer": event["text"], "steps": event["steps"], "queries": queries}


def make_client(base_url=None):
    return OpenAI(base_url=base_url or BASE_URL, api_key=API_KEY, timeout=600)


def todays_date():
    """Today, unless LEDGER_AGENT_TODAY pins it (the tests do, so "this month" never changes)."""
    pinned = os.environ.get("LEDGER_AGENT_TODAY")
    return date.fromisoformat(pinned) if pinned else date.today()


# ----------------------------------------------------------------------------------------------
# 6. Command line
# ----------------------------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Ask questions about your Ledger spending.")
    parser.add_argument("question", nargs="*", help="ask one question and exit (leave out to chat)")
    parser.add_argument("--quiet", action="store_true", help="hide tool calls and SQL")
    parser.add_argument("--db", default=DB_PATH, help=f"database file (default {DB_PATH})")
    parser.add_argument("--user", type=int, default=os.environ.get("LEDGER_AGENT_USER_ID"),
                        help="account id to answer for (default: the only account)")
    parser.add_argument("--model", default=MODEL, help=f"model name (default {MODEL})")
    parser.add_argument("--base-url", default=BASE_URL, help=f"model server (default {BASE_URL})")
    opts = parser.parse_args()

    today = todays_date()
    try:
        conn, user_id = open_database(opts.db, opts.user)
    except SetupError as e:
        sys.exit(paint(str(e), "red"))
    client = make_client(opts.base_url)
    trace = Trace(quiet=opts.quiet)
    trace.show(f"model {opts.model} at {opts.base_url} · {opts.db} (read-only, account {user_id})"
               " · learning mode on (--quiet hides it)")

    def answer(question, history):
        try:
            result = ask(question, conn, client, opts.model, today, history, trace)
        except APIConnectionError:
            sys.exit(paint(f"Can't reach a model server at {opts.base_url}. Is Ollama running? "
                           "Open the Ollama app, or run `ollama serve`.", "red"))
        except APIStatusError as e:
            hint = f" Is the model downloaded? Try: ollama pull {opts.model}" if e.status_code == 404 else ""
            sys.exit(paint(f"The model server returned an error: {e.message}.{hint}", "red"))
        print(paint(result["answer"], "green"))
        return result["answer"]

    if opts.question:  # one-shot mode
        answer(" ".join(opts.question), [])
        return

    print("Ask about your spending. Type 'new' to start a fresh conversation, 'exit' to quit.")
    history = []
    while True:
        try:
            question = input(paint("\nyou › ", "bold")).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if question.lower() in ("exit", "quit", "q"):
            return
        if question.lower() == "new":
            history = []
            print("(started a fresh conversation)")
            continue
        if question:
            history.append((question, answer(question, history[-6:])))  # remember the last 6 Q&As


if __name__ == "__main__":
    main()
