# The "ask my spending" agent

`agent.py` answers questions like *"How much did I spend on food in October?"* by writing SQL, running it against Ledger's database, checking the result and replying in plain English. It runs on a local model through Ollama (or LM Studio), so nothing leaves your Mac and nothing costs money.

It's in two places: the terminal (`agent.py`) and the **Ask** tab in Ledger's web app (key `6`). Both use the same loop.

```sh
.venv/bin/pip install -r requirements.txt            # once: includes the openai package (free; no account needed)
.venv/bin/python agent.py                             # chat with your real data (read-only)
.venv/bin/python agent.py "List my 5 most expensive purchases"
.venv/bin/python agent.py --quiet "..."               # answer only, no trace

.venv/bin/python agent_test/seed_test_db.py           # build fake test data in agent_test/test.db
.venv/bin/python agent.py --db agent_test/test.db --user 1
.venv/bin/python agent_test/eval.py                   # 10 test questions with known answers
```

## What an "agent" is

A language model on its own can only produce text. It can't open your database. An **agent** is a model plus a loop in ordinary code:

1. The code sends the model your question **and a menu of tools** (name, description and arguments).
2. The model either answers, or replies "please call `run_query` with this SQL".
3. The code runs that tool itself, sends the result back, and asks again.
4. Repeat until the model answers.

The model never touches the database. It can only *ask*, and `agent.py` decides what actually runs. That's why the safety rules live in the code, not in the prompt.

## The loop

```
   you: "How much did I spend on food in October?"
                         │
                         ▼
   ┌─────────────────────────────────────────────┐
   │ messages = [system prompt, your question]   │
   └─────────────────────────────────────────────┘
                         │
                         ▼
   ┌──────────────────────────────────────────────┐
┌─►│ step N: send ALL messages + tool menu to the │
│  │ model  (client.chat.completions.create)      │
│  └──────────────────────────────────────────────┘
│                        │
│                        ▼
│            ┌───────────────────────┐   no tool call
│            │ did it ask for tools? │─────────────────► final answer, printed in green
│            └───────────────────────┘
│                        │ yes
│                        ▼
│  ┌──────────────────────────────────────────────┐
│  │ run each tool in Python (call_tool):         │
│  │   list_tables()       → table names          │
│  │   describe_table(x)   → columns + 3 examples │
│  │   run_query(sql)      → rows (max 50) or the │
│  │                         SQL error text       │
│  └──────────────────────────────────────────────┘
│                        │
│                        ▼
│  ┌──────────────────────────────────────────────┐
│  │ append the model's request and each result   │
│  │ to messages (role "assistant", role "tool")  │
│  └──────────────────────────────────────────────┘
│                        │
│        step < 8 ───────┘          step 8: tools are taken away,
└──────────────────────                    so the model must answer
```

The loop is `agent_steps()` in `agent.py`, about 50 lines. It's a Python **generator**: each `yield` hands back one event (`step`, `thinking`, `tool_call`, `tool_result`, `answer`) the moment it happens. The terminal prints these events, and the web app streams them to your browser. Key ideas to look for there:

- **The model has no memory.** Every step sends the whole `messages` list again. The "conversation" is just a Python list that grows by one or two entries per step.
- **Four roles.** `system` (standing instructions), `user` (you), `assistant` (the model, including its tool requests) and `tool` (results we send back). Each result carries the `tool_call_id` of the request it answers.
- **Errors are results too.** If the SQL fails, the error text (`no such column: categry`) goes back as the tool result. The model reads it and fixes its query on the next step. That retry is where the "agent" earns its name.
- **A step limit.** Eight trips to the model per question at most. On the last one no tools are offered, so you get the best answer so far instead of nothing.

A typical run uses 4 steps: `list_tables` → `describe_table` (often for two tables at once) → `run_query` → answer.

## Learning mode

By default the trace is printed: **cyan** for tool calls, **yellow** for SQL, red for errors, dim grey for results and the model's own "thinking", and **green** for the answer. Use `--quiet` to see just the answer. Reading the yellow SQL is a good way to learn: try running the same query yourself with `sqlite3 -readonly agent_test/test.db`.

## In the web app: the Ask tab

Open Ledger (`./run.sh`, then http://localhost:5178) and choose **Ask** (or press `6`). Type a question or click a suggestion. While the agent works, you see the same trace as the terminal: thinking, tool calls in cyan, SQL in yellow, and the result rows. Once it answers, the trace folds into "Show how · 4 steps · 2 queries". Follow-up questions keep their context. "New conversation" starts fresh, and logging out clears it.

How it's wired:

```
 browser (web/js/ask.js)            server (server/main.py)            agent.py
 ───────────────────────            ───────────────────────            ────────
 POST /api/ask {question, history} ─► checks login → open_database(
                                      ledger.db, signed-in user's id) ─► agent_steps(...)
   draws each line as it arrives  ◄── one JSON event per line   ◄────── yield event, event, ...
```

- It answers for the **signed-in account**, so each person can only ask about their own spending.
- Questions are capped at 500 characters, and the last 6 Q&As are sent for follow-ups.
- If Ollama isn't running, the page says so instead of failing.
- The model's answer is shown as text, with only bold and lists allowed, so it can't inject HTML into the page.
- `tests/test_ask.py` checks all of this using a fake model, so the tests don't need Ollama.

## Safety

The model writes the SQL, so `agent.py` treats it as untrusted. There are four layers, and any one of them alone would stop a write:

| Layer | What it does |
|---|---|
| Read-only file | The database is opened with `?mode=ro`, so SQLite refuses every write. |
| SELECT check | `check_sql()` rejects anything not starting with `SELECT` or `WITH`. |
| One statement | Python's `execute()` refuses `SELECT 1; DROP TABLE ...`. |
| Authorizer | SQLite asks `authorizer()` about every table, column and action a query touches. Anything not on the allowlist is denied. |

The model also only ever sees **views**, never the real tables. Ledger keeps every account in the same tables, so at start-up `agent.py` creates in-memory views named `expenses`, `categories`, `incomes` and `rules`. Each view shows **one account's** rows and hides the `user_id` column. The `users` and `sessions` tables (emails, password hashes, login tokens) are not offered at all, and the authorizer blocks any query that tries to go around the views (`main.expenses`, `users`, `sqlite_master`).

Two more limits: results are capped at **50 rows** (the model is told when rows were cut off), and a query running over **5 seconds** is stopped.

## Settings and switching models

| Environment variable | Flag | Default |
|---|---|---|
| `LEDGER_AGENT_BASE_URL` | `--base-url` | `http://localhost:11434/v1` (Ollama) |
| `LEDGER_AGENT_MODEL` | `--model` | `qwen3.8:27b` |
| `LEDGER_AGENT_DB` | `--db` | `data/ledger.db` |
| `LEDGER_AGENT_USER_ID` | `--user` | the only account in the database |
| `LEDGER_AGENT_TODAY` | | today (the tests pin it to 2026-11-26) |

```sh
ollama pull gemma4:26b                                   # download another model (free, ~15-20 GB disk)
LEDGER_AGENT_MODEL=gemma4:26b .venv/bin/python agent.py  # use it for one run
export LEDGER_AGENT_MODEL=gemma4:26b                     # ...or for this terminal session
ollama list                                              # what you have; `ollama rm NAME` frees disk

# LM Studio instead: load a model, start its server (Developer tab), then
LEDGER_AGENT_BASE_URL=http://localhost:1234/v1 LEDGER_AGENT_MODEL=<name shown in LM Studio> .venv/bin/python agent.py
```

To compare models fairly, run `agent_test/eval.py --model NAME` for each one.

### Models worth trying (fit in about 30 GB, support tool calling)

| Model (Ollama) | Memory | Notes |
|---|---|---|
| `qwen3.8:27b` | ~20 GB | The default and already installed. Strong at tool calling; it "thinks" before each step, so it's thorough but not fast. |
| `qwen3.6:35b-a3b` | ~22-24 GB | Mixture-of-experts: only about 3B parameters work per word, so it's much faster. Some reports of tool-calling bugs in Ollama, so test it. |
| `gemma4:26b` | ~16-18 GB | Google's model, with tool calling and vision. |
| `gpt-oss:20b` | ~14 GB | OpenAI's open-weights model. Smaller and quicker, a good speed comparison. |

Check the exact tag on [ollama.com/library](https://ollama.com/library) before pulling. Avoid tags ending in `-cloud` or `:cloud`: those run on Ollama's servers, not your Mac, and can need a paid plan. Small models (under ~8B) tend to forget the tools, invent columns or stop after one query.

## Files

- `agent.py`: the agent (settings, safety, tools, learning-mode printing, the loop, command line).
- `server/main.py` (`POST /api/ask`) and `web/js/ask.js`: the Ask tab in the web app.
- `tests/test_ask.py`: tests for the Ask route (login, streaming, account isolation, validation, Ollama down).
- `agent_test/seed_test_db.py`: builds `agent_test/test.db` from Ledger's own schema with about 600 fake expenses, plus a second fake account the agent must never count.
- `agent_test/eval.py`: 10 questions, each with hand-written reference SQL. Writes every query the agent ran to `agent_test/last_run.json`.
