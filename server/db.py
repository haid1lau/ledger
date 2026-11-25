"""SQLite storage. One file at data/ledger.db; receipts live next to it in data/receipts/.
Every row of user data carries a user_id; all queries are scoped by it."""
import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("LEDGER_DATA", ROOT / "data"))
DB_PATH = DATA_DIR / "ledger.db"
RECEIPTS = DATA_DIR / "receipts"

SCHEMA_VERSION = 1

USERS = """
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,            -- sha256 of the cookie value; the raw token is never stored
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
"""

SCHEMA = USERS + """
CREATE TABLE IF NOT EXISTS categories (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL COLLATE NOCASE,
  budget  REAL NOT NULL DEFAULT 0,
  color   TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  cat_id     INTEGER REFERENCES categories(id),
  amount     REAL NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  freq       TEXT NOT NULL CHECK (freq IN ('weekly', 'monthly', 'yearly')),
  anchor_day INTEGER NOT NULL,            -- day of month to land on (clamped in short months)
  next_date  TEXT NOT NULL,               -- next occurrence still to be created
  active     INTEGER NOT NULL DEFAULT 1,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS expenses (
  id      INTEGER PRIMARY KEY,
  cat_id  INTEGER NOT NULL REFERENCES categories(id),
  amount  REAL NOT NULL,
  date    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  tags    TEXT NOT NULL DEFAULT '[]',
  receipt TEXT,
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS incomes (
  id      INTEGER PRIMARY KEY,
  amount  REAL NOT NULL,
  date    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS ix_exp_user_date ON expenses(user_id, date);
CREATE INDEX IF NOT EXISTS ix_inc_user_date ON incomes(user_id, date);
CREATE INDEX IF NOT EXISTS ix_rule_user ON rules(user_id);
CREATE INDEX IF NOT EXISTS ix_sess_user ON sessions(user_id);
DROP INDEX IF EXISTS ix_exp_date;
DROP INDEX IF EXISTS ix_inc_date;
"""

# Databases from before accounts existed: give every table a user_id. Existing rows keep
# user_id NULL; they belong to no account and are never shown to anyone.
MIGRATE_V1 = USERS + """
CREATE TABLE categories_new (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL COLLATE NOCASE,
  budget  REAL NOT NULL DEFAULT 0,
  color   TEXT NOT NULL,
  UNIQUE (user_id, name)
);
INSERT INTO categories_new (id, name, budget, color) SELECT id, name, budget, color FROM categories;
DROP TABLE categories;
ALTER TABLE categories_new RENAME TO categories;
ALTER TABLE rules    ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE expenses ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE incomes  ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
"""

DATA_TABLES = ("categories", "rules", "expenses", "incomes")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RECEIPTS.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)  # one connection per request; async routes run off-thread
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init() -> None:
    conn = connect()
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        has_data = conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'categories'").fetchone()
        if version < 1 and has_data:
            conn.execute("PRAGMA foreign_keys = OFF")   # table rebuild; must be outside a transaction
            conn.executescript("BEGIN;" + MIGRATE_V1 + "COMMIT;")
            conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA + INDEXES)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()
    finally:
        conn.close()


def get_db():
    """FastAPI dependency: one connection per request, committed on success."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------- row -> JSON (keys match what the front end has always used) ----------

def cat_json(r):
    return {"id": r["id"], "name": r["name"], "budget": r["budget"], "color": r["color"]}


def exp_json(r):
    return {
        "id": r["id"], "cat": r["cat_id"], "amount": r["amount"], "date": r["date"], "note": r["note"],
        "tags": json.loads(r["tags"]), "receipt": f"/api/receipts/{r['receipt']}" if r["receipt"] else None,
        "rule": r["rule_id"],
    }


def inc_json(r):
    return {"id": r["id"], "amount": r["amount"], "date": r["date"], "note": r["note"], "rule": r["rule_id"]}


def rule_json(r):
    return {
        "id": r["id"], "kind": r["kind"], "cat": r["cat_id"], "amount": r["amount"], "note": r["note"],
        "tags": json.loads(r["tags"]), "freq": r["freq"], "next": r["next_date"], "active": bool(r["active"]),
    }


def state(conn, uid: int) -> dict:
    q = lambda t: conn.execute(f"SELECT * FROM {t} WHERE user_id = ? ORDER BY id", (uid,)).fetchall()
    return {
        "cats": [cat_json(r) for r in q("categories")],
        "exps": [exp_json(r) for r in q("expenses")],
        "incs": [inc_json(r) for r in q("incomes")],
        "rules": [rule_json(r) for r in q("rules")],
    }
