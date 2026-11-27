"""Run agent.py against 10 test questions on the fake test database and check its answers.

    .venv/bin/python agent_test/seed_test_db.py     # once, to build agent_test/test.db
    .venv/bin/python agent_test/eval.py             # uses LEDGER_AGENT_MODEL / LEDGER_AGENT_BASE_URL
    .venv/bin/python agent_test/eval.py --show 3    # watch question 3 in learning mode

Each test has:
  - the question, exactly as you'd type it;
  - reference SQL I wrote by hand, which reads the REAL tables and filters user_id = 1 itself
    (it doesn't go through the agent's views, so it's an independent check);
  - what a correct answer must mention. Each inner list is "any one of these"; every list must match.
    Numbers are compared after removing "$" and "," from the answer, so "$1,116.50" matches "1116.5".

"Today" is pinned to 2026-11-26 so "this month" and "last month" always mean the same thing.
The automatic check is a first pass: read the answers too, since a model can mention the right
number for the wrong reason.
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import agent  # noqa: E402

TEST_DB = HERE / "test.db"
TODAY = date(2026, 11, 26)

CASES = [
    {"q": "How much did I spend on food in October?",
     "sql": "SELECT ROUND(SUM(e.amount),2), COUNT(*) FROM expenses e JOIN categories c ON c.id = e.cat_id "
            "WHERE e.user_id = 1 AND c.name = 'Food' AND e.date BETWEEN '2026-10-01' AND '2026-10-31'",
     "expect": [["406.62"]]},
    {"q": "What's my biggest category this month vs last month?",
     "sql": "SELECT substr(e.date,1,7), c.name, ROUND(SUM(e.amount),2) t FROM expenses e JOIN categories c "
            "ON c.id = e.cat_id WHERE e.user_id = 1 AND substr(e.date,1,7) IN ('2026-10','2026-11') "
            "GROUP BY 1, 2 ORDER BY 1, 3 DESC",
     "expect": [["shopping"], ["359.48"], ["groceries"], ["424.64"]]},
    {"q": "List my 5 most expensive purchases",
     "sql": "SELECT date, note, amount FROM expenses WHERE user_id = 1 ORDER BY amount DESC LIMIT 5",
     "expect": [["villa"], ["flight"], ["monitor"], ["airpods"], ["kl hotel", "hotel (2"]],
     "forbid": ["laptop"]},  # the flatmate's 2,499 laptop must never appear
    {"q": "How many times did I buy chicken rice, and how much did it cost in total?",
     "sql": "SELECT COUNT(*), ROUND(SUM(amount),2) FROM expenses WHERE user_id = 1 AND note LIKE '%chicken rice%'",
     "expect": [["15"], ["125.16"]]},
    {"q": "How much did my Bali trip cost?",
     "sql": "SELECT COUNT(*), ROUND(SUM(e.amount),2) FROM expenses e, json_each(e.tags) t "
            "WHERE e.user_id = 1 AND t.value = '#trip-bali'",
     "expect": [["1116.5"]]},
    {"q": "Which month did I spend the most in, and how much?",
     "sql": "SELECT substr(date,1,7), ROUND(SUM(amount),2) FROM expenses WHERE user_id = 1 "
            "GROUP BY 1 ORDER BY 2 DESC LIMIT 1",
     "expect": [["june"], ["2740.61"]]},
    {"q": "Did I go over my food budget in October? By how much?",
     "sql": "SELECT c.budget, ROUND(SUM(e.amount),2), ROUND(SUM(e.amount) - c.budget, 2) FROM expenses e "
            "JOIN categories c ON c.id = e.cat_id WHERE e.user_id = 1 AND c.name = 'Food' AND e.date LIKE '2026-10-%'",
     "expect": [["6.62"], ["yes", "over", "exceeded"]]},
    {"q": "How much have I saved this year (income minus spending)?",
     "sql": "SELECT (SELECT SUM(amount) FROM incomes WHERE user_id = 1 AND date LIKE '2026-%'), "
            "(SELECT ROUND(SUM(amount),2) FROM expenses WHERE user_id = 1 AND date LIKE '2026-%'), "
            "ROUND((SELECT SUM(amount) FROM incomes WHERE user_id = 1 AND date LIKE '2026-%') - "
            "(SELECT SUM(amount) FROM expenses WHERE user_id = 1 AND date LIKE '2026-%'), 2)",
     "expect": [["17179.37"]]},
    {"q": "Which day of the week do I spend the most on food?",
     "sql": "SELECT strftime('%w', e.date) dow, ROUND(SUM(e.amount),2) FROM expenses e JOIN categories c "
            "ON c.id = e.cat_id WHERE e.user_id = 1 AND c.name = 'Food' GROUP BY 1 ORDER BY 2 DESC LIMIT 1",
     "expect": [["thursday"]]},
    {"q": "How much did I spend on travel in December?",  # = December 2025: there's no data then
     "sql": "SELECT COUNT(*) FROM expenses WHERE user_id = 1 AND date LIKE '2025-12-%'",
     "expect": [["no ", "didn't", "did not", "nothing", "none", "$0", "0.00", "zero"]],
     "forbid": ["1255", "1,255"]},  # the 2026 travel total, which would mean it ignored "December"
]


def check(answer, case):
    text = answer.lower().replace("$", "").replace(",", "")
    text_with_commas = answer.lower()
    missing = [group for group in case["expect"] if not any(opt in text for opt in group)]
    forbidden = [w for w in case.get("forbid", []) if w in text or w in text_with_commas]
    return not missing and not forbidden, missing, forbidden


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--show", type=int, help="run only this question number, in learning mode")
    parser.add_argument("--model", default=agent.MODEL)
    parser.add_argument("--base-url", default=agent.BASE_URL)
    opts = parser.parse_args()
    if not TEST_DB.exists():
        sys.exit("No test database yet. Run: .venv/bin/python agent_test/seed_test_db.py")

    reference = sqlite3.connect(f"{TEST_DB.as_uri()}?mode=ro", uri=True)
    conn, _ = agent.open_database(TEST_DB, user_id=1)
    client = agent.OpenAI(base_url=opts.base_url, api_key=agent.API_KEY, timeout=600)

    numbers = [opts.show] if opts.show else range(1, len(CASES) + 1)
    results = []
    print(f"model {opts.model} · {len(numbers)} question(s) · today pinned to {TODAY}\n")
    for n in numbers:
        case = CASES[n - 1]
        expected = reference.execute(case["sql"]).fetchall()
        print(f"Q{n}. {case['q']}")
        start = time.monotonic()
        out = agent.ask(case["q"], conn, client, opts.model, TODAY, trace=agent.Trace(quiet=not opts.show))
        seconds = time.monotonic() - start
        ok, missing, forbidden = check(out["answer"], case)
        bad_sql = sum(not q["ok"] for q in out["queries"])
        print(f"    agent:     {' '.join(out['answer'].split())}")
        print(f"    reference: {expected}")
        print(f"    {'PASS' if ok else 'FAIL'} · {out['steps']} steps · {len(out['queries'])} queries "
              f"({bad_sql} failed) · {seconds:.0f}s"
              + (f" · missing {missing}" if missing else "") + (f" · must not say {forbidden}" if forbidden else ""))
        print()
        results.append({"n": n, "question": case["q"], "answer": out["answer"], "reference": expected,
                        "pass": ok, "steps": out["steps"], "queries": out["queries"], "seconds": round(seconds)})

    passed = sum(r["pass"] for r in results)
    print(f"{passed}/{len(results)} passed · total {sum(r['seconds'] for r in results)}s")
    (HERE / "last_run.json").write_text(json.dumps({"model": opts.model, "results": results}, indent=2, default=str))
    print(f"Full details (every query the agent ran): {HERE / 'last_run.json'}")


if __name__ == "__main__":
    main()
