import sqlite3

from fastapi.testclient import TestClient

from server import auth, db
from server.main import app
from tests.test_api import anon, cat, client, fresh_db  # noqa: F401  (fixtures)

ME = {"email": "me@example.com", "password": "correct horse"}


def other_user():
    c = TestClient(app)
    assert c.post("/api/auth/signup", json={"email": "them@example.com", "password": "battery staple"}).status_code == 201
    return c


def test_data_requires_login(anon):
    for method, url in [("get", "/api/state"), ("post", "/api/categories"), ("get", "/api/export.csv"),
                        ("get", "/api/backup.json"), ("get", "/api/auth/me")]:
        assert getattr(anon, method)(url).status_code == 401


def test_signup_login_logout(anon):
    assert anon.post("/api/auth/signup", json={"email": "bad", "password": "longenough"}).status_code == 422
    assert anon.post("/api/auth/signup", json={"email": "a@b.co", "password": "short"}).status_code == 422
    r = anon.post("/api/auth/signup", json={"email": " Me@Example.com ", "password": "correct horse"})
    assert r.status_code == 201 and r.json()["user"]["email"] == "me@example.com"
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" not in cookie  # plain http in tests
    assert anon.post("/api/auth/signup", json={"email": "ME@example.com", "password": "another one"}).status_code == 409
    assert anon.get("/api/auth/me").json()["user"]["email"] == "me@example.com"
    assert anon.post("/api/auth/logout").status_code == 204
    assert anon.get("/api/state").status_code == 401
    assert anon.post("/api/auth/login", json={**ME, "password": "wrong pass"}).status_code == 401
    assert anon.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong pass"}).status_code == 401
    assert anon.post("/api/auth/login", json={**ME, "email": "ME@example.com"}).status_code == 200
    assert anon.get("/api/state").status_code == 200


def test_password_is_hashed(client):
    stored = db.connect().execute("SELECT pw_hash FROM users").fetchone()[0]
    assert stored.startswith("scrypt$") and "correct horse" not in stored


def test_users_cannot_see_or_touch_each_others_data(client):
    k = cat(client)
    e = client.post("/api/expenses", json={"cat": k["id"], "amount": 5, "date": "2026-10-01", "note": "mine"}).json()
    receipt = client.post(f"/api/expenses/{e['id']}/receipt", files={"file": ("r.png", b"png", "image/png")}).json()["receipt"]
    them = other_user()
    s = them.get("/api/state").json()
    assert s["cats"] == [] and s["exps"] == []
    assert them.put(f"/api/expenses/{e['id']}", json={"cat": k["id"], "amount": 1, "date": "2026-10-01"}).status_code == 404
    assert them.delete(f"/api/expenses/{e['id']}").status_code == 404
    assert them.delete(f"/api/categories/{k['id']}").status_code == 404
    assert them.get(receipt).status_code == 404
    assert them.post("/api/expenses", json={"cat": k["id"], "amount": 1, "date": "2026-10-01"}).status_code == 400
    assert "mine" not in them.get("/api/export.csv").text
    assert cat(them)["name"] == "Dining"            # same category name is fine in another account
    assert len(client.get("/api/state").json()["exps"]) == 1
    assert client.get(receipt).status_code == 200


def test_throttles_password_guessing(client):
    client.post("/api/auth/logout")
    for _ in range(10):
        client.post("/api/auth/login", json={**ME, "password": "nope nope"})
    assert client.post("/api/auth/login", json=ME).status_code == 429


def test_change_password_signs_out_other_devices(client):
    laptop = TestClient(app)
    assert laptop.post("/api/auth/login", json=ME).status_code == 200
    assert client.post("/api/auth/password", json={"current": "wrong", "new": "new password!"}).status_code == 403
    assert client.post("/api/auth/password", json={"current": "correct horse", "new": "short"}).status_code == 422
    assert client.post("/api/auth/password", json={"current": "correct horse", "new": "new password!"}).status_code == 204
    assert client.get("/api/state").status_code == 200       # this device stays signed in
    assert laptop.get("/api/state").status_code == 401       # every other device is signed out
    assert laptop.post("/api/auth/login", json={**ME, "password": "new password!"}).status_code == 200


def test_delete_account_removes_everything(client):
    k = cat(client)
    e = client.post("/api/expenses", json={"cat": k["id"], "amount": 5, "date": "2026-10-01"}).json()
    e = client.post(f"/api/expenses/{e['id']}/receipt", files={"file": ("r.png", b"png", "image/png")}).json()
    client.post("/api/rules", json={"kind": "income", "amount": 9, "freq": "monthly", "next": "2030-01-01"})
    client.post("/api/incomes", json={"amount": 9, "date": "2026-10-01"})
    name = e["receipt"].rsplit("/", 1)[1]
    assert client.post("/api/auth/delete-account", json={"password": "wrong"}).status_code == 403
    assert client.post("/api/auth/delete-account", json={"password": "correct horse"}).status_code == 204
    conn = db.connect()
    for t in ("users", "sessions", "categories", "expenses", "incomes", "rules"):
        assert conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0, t
    assert not (db.RECEIPTS / name).exists()
    assert client.get("/api/state").status_code == 401


def test_cross_site_writes_refused(client):
    body = {"name": "X", "budget": 0, "color": "#FF7A59"}
    assert client.post("/api/categories", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/categories", json=body, headers={"Origin": "http://testserver"}).status_code == 201


def test_signups_can_be_closed(anon, monkeypatch):
    monkeypatch.setattr(auth, "SIGNUPS_OPEN", False)
    assert anon.get("/api/auth/status").json()["signups_open"] is True        # the first account is always allowed
    assert anon.post("/api/auth/signup", json={"email": "first@example.com", "password": "first user"}).status_code == 201
    assert anon.get("/api/auth/status").json()["signups_open"] is False
    r = TestClient(app).post("/api/auth/signup", json={"email": "second@example.com", "password": "second user"})
    assert r.status_code == 403


def test_new_accounts_start_empty_even_with_old_data_on_the_server(anon):
    fresh_db()
    old = sqlite3.connect(db.DB_PATH)
    old.executescript("""
      CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, budget REAL NOT NULL DEFAULT 0, color TEXT NOT NULL);
      CREATE TABLE rules (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, cat_id INTEGER REFERENCES categories(id), amount REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', freq TEXT NOT NULL, anchor_day INTEGER NOT NULL,
        next_date TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE expenses (id INTEGER PRIMARY KEY, cat_id INTEGER NOT NULL REFERENCES categories(id), amount REAL NOT NULL,
        date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', receipt TEXT,
        rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL);
      CREATE TABLE incomes (id INTEGER PRIMARY KEY, amount REAL NOT NULL, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL);
      INSERT INTO categories VALUES (1, 'Food', 200, '#FFA94D');
      INSERT INTO expenses (cat_id, amount, date, note) VALUES (1, 6.3, '2026-10-12', 'Lunch');
      INSERT INTO incomes (amount, date, note) VALUES (500, '2026-10-13', 'Card Sale');
    """)
    old.commit()
    old.close()
    db.init()
    db.init()   # running it again is harmless
    for c in (anon, other_user()):   # the first account and every later one
        if c is anon:
            assert anon.post("/api/auth/signup", json={"email": "owner@example.com", "password": "owner pass"}).status_code == 201
        s = c.get("/api/state").json()
        assert s["cats"] == s["exps"] == s["incs"] == s["rules"] == []
        assert c.get("/api/export.csv").text.strip() == "date,type,category,description,amount,tags"
    # the old rows are untouched in the database, just not part of any account
    conn = db.connect()
    assert conn.execute("SELECT COUNT(*) FROM expenses WHERE user_id IS NULL").fetchone()[0] == 1
