"""Build agent_test/test.db: a FAKE Ledger database for trying out and testing agent.py.

It never reads or copies your real data/ledger.db. Instead it creates a brand-new file using
Ledger's own schema (server/db.py), so the tables and columns are exactly the real ones,
and then fills it with made-up but realistic spending from 1 Jan to 25 Nov 2026.

There are two fake accounts:
  user 1  me@example.com        - the account the agent answers questions about
  user 2  flatmate@example.com  - someone else's data, which the agent must NEVER count

Run it again any time to get the identical database back (the random numbers use a fixed seed):
    .venv/bin/python agent_test/seed_test_db.py
"""
import json
import random
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))          # so "from server import db" works
from server import db  # noqa: E402  (only used for the schema text; it opens nothing)

TEST_DB = HERE / "test.db"
START, END = date(2026, 1, 1), date(2026, 11, 25)
rng = random.Random(42)                       # fixed seed -> same data every run


def days():
    d = START
    while d <= END:
        yield d
        d += timedelta(days=1)


def money(lo, hi):
    return round(rng.uniform(lo, hi), 2)


def build():
    for p in (TEST_DB, TEST_DB.with_name("test.db-wal"), TEST_DB.with_name("test.db-shm")):
        p.unlink(missing_ok=True)
    conn = sqlite3.connect(TEST_DB)
    conn.executescript(db.SCHEMA + db.INDEXES)     # Ledger's real CREATE TABLE statements
    conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION}")  # what db.init() writes, so Ledger itself can open it

    # Fake accounts. The hashes are placeholders, not real password hashes.
    conn.execute("INSERT INTO users (id, email, pw_hash) VALUES (1, 'me@example.com', 'fake-hash-1')")
    conn.execute("INSERT INTO users (id, email, pw_hash) VALUES (2, 'flatmate@example.com', 'fake-hash-2')")
    conn.execute("INSERT INTO sessions VALUES ('fake-session-token-hash', 1, '2026-12-31 00:00:00')")

    cats = {}
    for name, budget, color in [("Food", 400, "#FF7A59"), ("Groceries", 250, "#7BD389"),
                                ("Transport", 120, "#5B8DEF"), ("Shopping", 200, "#C77DFF"),
                                ("Leisure", 150, "#FFC145"), ("Bills", 300, "#9AA0A6"),
                                ("Travel", 0, "#2EC4B6")]:
        cats[name] = conn.execute("INSERT INTO categories (user_id, name, budget, color) VALUES (1,?,?,?)",
                                  (name, budget, color)).lastrowid
    other_food = conn.execute("INSERT INTO categories (user_id, name, budget, color) "
                              "VALUES (2, 'Food', 500, '#FF7A59')").lastrowid
    other_tech = conn.execute("INSERT INTO categories (user_id, name, budget, color) "
                              "VALUES (2, 'Shopping', 0, '#C77DFF')").lastrowid

    phone_rule = conn.execute(
        "INSERT INTO rules (kind, cat_id, amount, note, tags, freq, anchor_day, next_date, active, user_id) "
        "VALUES ('expense', ?, 30.0, 'Phone plan', '[]', 'monthly', 5, '2026-12-05', 1, 1)",
        (cats["Bills"],)).lastrowid
    salary_rule = conn.execute(
        "INSERT INTO rules (kind, cat_id, amount, note, tags, freq, anchor_day, next_date, active, user_id) "
        "VALUES ('income', NULL, 3200.0, 'Salary', '[]', 'monthly', 25, '2026-12-25', 1, 1)").lastrowid

    rows = []                                    # (category, amount, date, note, tags, rule_id)

    def add(cat, amount, d, note, tags=(), rule=None):
        rows.append((cats[cat], amount, d.isoformat(), note, json.dumps(list(tags)), rule))

    lunches = ["Chicken Rice", "Basil Pork Rice", "Laksa", "Mee Pok", "Nasi Lemak", "Economy Rice",
               "Ban Mian", "Fishball Noodles", "Ramly Burger and Prata", "Yong Tau Foo"]
    dinners = ["Ramen", "Korean BBQ", "Pizza with friends", "Hotpot", "Sushi", "Mala Xiang Guo", "Thai food"]
    shops = [("Shopee order", 8, 60), ("Uniqlo", 30, 90), ("Daiso", 4, 20), ("Popular bookstore", 10, 45),
             ("Watsons", 8, 35), ("Decathlon", 20, 80)]
    fun = [("Movie", 12, 25), ("Bowling", 15, 30), ("Karaoke", 20, 45), ("Zouk", 40, 70), ("Escape room", 25, 35)]

    for d in days():
        weekend = d.weekday() >= 5
        if not weekend and rng.random() < 0.85:
            work = rng.random() < 0.08
            add("Food", money(4, 12) if not work else money(25, 60), d,
                "Client lunch" if work else rng.choice(lunches), ["#work"] if work else [])
        if rng.random() < (0.6 if weekend else 0.35):
            add("Food", money(8, 35), d, rng.choice(dinners))
        if d.weekday() == 5:
            add("Groceries", money(40, 110), d, rng.choice(["NTUC FairPrice", "Sheng Siong", "Cold Storage"]))
        if rng.random() < 0.08:
            add("Transport", money(12, 30), d, "Grab ride")
        if rng.random() < 0.25:
            note, lo, hi = rng.choice(shops)
            add("Shopping", money(lo, hi), d, note)
        if weekend and rng.random() < 0.3:
            note, lo, hi = rng.choice(fun)
            add("Leisure", money(lo, hi), d, note)
        if d.day == 1:
            add("Transport", 81.0, d, "Monthly concession pass")
            add("Bills", 98.0, d, "Gym membership")
        if d.day == 5:
            add("Bills", 30.0, d, "Phone plan", rule=phone_rule)
            add("Bills", 19.98, d, "Netflix", ["#subscription"])
            add("Bills", 11.98, d, "Spotify", ["#subscription"])
        if d.day == 15:
            add("Bills", money(45, 95), d, "Electricity (SP Group)")

    # A few big one-off purchases and two trips, so "most expensive" and tag questions are interesting.
    add("Shopping", 279.0, date(2026, 3, 14), "AirPods Pro")
    add("Shopping", 389.0, date(2026, 8, 2), "27-inch monitor")
    add("Shopping", 159.9, date(2026, 11, 11), "11.11 sale - running shoes")
    add("Travel", 420.0, date(2026, 6, 10), "Flight to Bali", ["#trip-bali"])
    add("Travel", 610.0, date(2026, 6, 12), "Bali villa (4 nights)", ["#trip-bali"])
    add("Food", 86.5, date(2026, 6, 13), "Seafood dinner in Jimbaran", ["#trip-bali"])
    add("Travel", 45.0, date(2026, 9, 19), "Bus to Kuala Lumpur", ["#trip-kl"])
    add("Travel", 180.0, date(2026, 9, 19), "KL hotel (2 nights)", ["#trip-kl"])
    add("Leisure", 168.0, date(2026, 10, 24), "Concert tickets")

    conn.executemany("INSERT INTO expenses (cat_id, amount, date, note, tags, rule_id, user_id) "
                     "VALUES (?,?,?,?,?,?,1)", rows)

    for m in range(1, 11):                       # salary Jan-Oct (Nov's lands on the 25th, included)
        conn.execute("INSERT INTO incomes (amount, date, note, rule_id, user_id) VALUES (3200, ?, 'Salary', ?, 1)",
                     (date(2026, m, 25).isoformat(), salary_rule))
    conn.execute("INSERT INTO incomes (amount, date, note, rule_id, user_id) VALUES (3200, '2026-11-25', 'Salary', ?, 1)",
                 (salary_rule,))
    conn.execute("INSERT INTO incomes (amount, date, note, user_id) VALUES (450, '2026-04-18', 'Freelance design job', 1)")

    # The flatmate's data: bigger numbers on purpose. If the agent ever mixed accounts up,
    # their 2,499 laptop would wrongly top "my most expensive purchases".
    flatmate = [(other_tech, 2499.0, "2026-10-03", "Laptop"), (other_food, 320.0, "2026-10-10", "Omakase dinner"),
                (other_food, 150.0, "2026-11-02", "Birthday dinner"), (other_tech, 899.0, "2026-11-20", "Phone")]
    conn.executemany("INSERT INTO expenses (cat_id, amount, date, note, user_id) VALUES (?,?,?,?,2)", flatmate)

    conn.commit()
    conn.execute("PRAGMA journal_mode = WAL")    # same journal mode as the real ledger.db
    n = conn.execute("SELECT COUNT(*) FROM expenses WHERE user_id = 1").fetchone()[0]
    conn.close()
    print(f"Built {TEST_DB} with {n} fake expenses for user 1 (+{len(flatmate)} for user 2).")


if __name__ == "__main__":
    build()
