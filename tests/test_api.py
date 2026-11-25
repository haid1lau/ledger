import os
import tempfile
from datetime import date

os.environ["LEDGER_DATA"] = tempfile.mkdtemp()  # must be set before the app is imported

import pytest
from fastapi.testclient import TestClient

from server import auth, db
from server.main import app
from server.recurring import add_period, materialize


def fresh_db():
    for p in (db.DB_PATH, db.DB_PATH.with_name("ledger.db-wal"), db.DB_PATH.with_name("ledger.db-shm")):
        p.unlink(missing_ok=True)


@pytest.fixture()
def anon():
    fresh_db()
    auth.throttle.fails.clear()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def client(anon):
    assert anon.post("/api/auth/signup", json={"email": "me@example.com", "password": "correct horse"}).status_code == 201
    return anon


def cat(c, name="Dining", budget=300):
    return c.post("/api/categories", json={"name": name, "budget": budget, "color": "#FF7A59"}).json()


def test_expense_crud_and_tags(client):
    k = cat(client)
    e = client.post("/api/expenses", json={"cat": k["id"], "amount": 12.345, "date": "2026-10-01",
                                           "note": "Lunch", "tags": ["#Work", "work", "Team Lunch"]}).json()
    assert e["amount"] == 12.35 and e["tags"] == ["work", "team-lunch"]
    client.put(f"/api/expenses/{e['id']}", json={"cat": k["id"], "amount": 20, "date": "2026-10-02", "note": "Dinner"})
    s = client.get("/api/state").json()
    assert s["exps"][0]["amount"] == 20 and s["exps"][0]["tags"] == []
    assert client.delete(f"/api/expenses/{e['id']}").status_code == 204
    assert client.get("/api/state").json()["exps"] == []


def test_validation_and_category_guards(client):
    k = cat(client)
    assert client.post("/api/expenses", json={"cat": k["id"], "amount": 0, "date": "2026-10-01"}).status_code == 422
    assert client.post("/api/expenses", json={"cat": 999, "amount": 5, "date": "2026-10-01"}).status_code == 400
    assert client.post("/api/categories", json={"name": "dining", "budget": 1, "color": "#FF7A59"}).status_code == 409
    client.post("/api/expenses", json={"cat": k["id"], "amount": 5, "date": "2026-10-01"})
    assert client.delete(f"/api/categories/{k['id']}").status_code == 409


def test_add_period_clamps_month_end():
    assert add_period(date(2026, 1, 31), "monthly", 31) == date(2026, 2, 28)
    assert add_period(date(2026, 2, 28), "monthly", 31) == date(2026, 3, 31)
    assert add_period(date(2026, 12, 15), "monthly", 15) == date(2027, 1, 15)
    assert add_period(date(2024, 2, 29), "yearly", 29) == date(2025, 2, 28)
    assert add_period(date(2026, 10, 1), "weekly", 1) == date(2026, 10, 8)


def test_recurring_backfills_and_pauses(client):
    k = cat(client)
    r = client.post("/api/rules", json={"kind": "expense", "cat": k["id"], "amount": 10, "note": "Gym",
                                        "freq": "monthly", "next": "2026-01-31"}).json()
    conn = db.connect()
    materialize(conn, 1, date(2026, 4, 30)); conn.commit()
    dates = [e["date"] for e in db.state(conn, 1)["exps"]]
    conn.close()
    assert set(dates) >= {"2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"}
    client.put(f"/api/rules/{r['id']}", json={**r, "active": False, "next": "2030-01-01"})
    client.delete(f"/api/rules/{r['id']}")
    s = client.get("/api/state").json()
    assert s["rules"] == [] and all(e["rule"] is None for e in s["exps"])


def test_repeat_on_create_and_income(client):
    k = cat(client)
    client.post("/api/expenses", json={"cat": k["id"], "amount": 9, "date": date.today().isoformat(), "repeat": "weekly"})
    client.post("/api/incomes", json={"amount": 5000, "date": date.today().isoformat(), "note": "Salary", "repeat": "monthly"})
    s = client.get("/api/state").json()
    assert len(s["exps"]) == 1 and len(s["incs"]) == 1 and len(s["rules"]) == 2
    assert s["exps"][0]["rule"] and s["incs"][0]["rule"]


def test_receipt_upload_and_cleanup(client):
    k = cat(client)
    e = client.post("/api/expenses", json={"cat": k["id"], "amount": 5, "date": "2026-10-01"}).json()
    bad = client.post(f"/api/expenses/{e['id']}/receipt", files={"file": ("x.txt", b"hi", "text/plain")})
    assert bad.status_code == 415
    e = client.post(f"/api/expenses/{e['id']}/receipt", files={"file": ("r.png", b"\x89PNG fake", "image/png")}).json()
    assert client.get(e["receipt"]).content == b"\x89PNG fake"
    name = e["receipt"].rsplit("/", 1)[1]
    client.delete(f"/api/expenses/{e['id']}")
    assert not (db.RECEIPTS / name).exists()
    assert client.get("/api/receipts/../ledger.db").status_code == 404


def test_csv_bank_statement_import(client):
    k = cat(client)
    csv = "Transaction Date,Description,Amount\n10/03/2026,Coffee,-4.50\n10/05/2026,Payroll,\"2,500.00\"\n10/06/2026,Groceries,(32.10)\n"
    files = {"file": ("bank.csv", csv, "text/csv")}
    p = client.post("/api/import/csv", files=files, data={"commit": "false"}).json()
    assert (p["expenses"], p["income"], p["needs_category"]) == (2, 1, True)
    r = client.post("/api/import/csv", files=files, data={"commit": "true", "default_cat": str(k["id"])}).json()
    assert r["imported"] == 3
    s = client.get("/api/state").json()
    assert sorted(e["amount"] for e in s["exps"]) == [4.5, 32.1] and s["incs"][0]["amount"] == 2500
    again = client.post("/api/import/csv", files=files, data={"commit": "false"}).json()
    assert again["duplicates"] == 3 and again["expenses"] == 0


def test_csv_round_trip(client):
    k = cat(client)
    client.post("/api/expenses", json={"cat": k["id"], "amount": 7.5, "date": "2026-10-01", "note": "Tea", "tags": ["work"]})
    client.post("/api/incomes", json={"amount": 100, "date": "2026-10-02", "note": "Gift"})
    out = client.get("/api/export.csv").text
    assert out.splitlines()[0] == "date,type,category,description,amount,tags"
    fresh_db()
    db.init()
    client.post("/api/auth/signup", json={"email": "me@example.com", "password": "correct horse"})
    r = client.post("/api/import/csv", files={"file": ("l.csv", out, "text/csv")}, data={"commit": "true"}).json()
    s = client.get("/api/state").json()
    assert r["imported"] == 2 and s["cats"][0]["name"] == "Dining" and s["exps"][0]["tags"] == ["work"]


def test_csv_bad_file(client):
    r = client.post("/api/import/csv", files={"file": ("x.csv", "foo,bar\n1,2\n", "text/csv")}, data={"commit": "false"})
    assert r.status_code == 422 and "date" in r.json()["detail"]


def test_json_import_merges_legacy_data(client):
    cat(client, "Dining", 100)
    legacy = {"cats": [{"id": 7, "name": "dining", "budget": 420, "color": "#8B7BFF"}, {"id": 8, "name": "Fun", "budget": 50}],
              "exps": [{"id": 1, "cat": 7, "amount": 5, "date": "2026-10-01", "note": "x"},
                       {"id": 2, "cat": 8, "amount": 6, "date": "2026-10-02"},
                       {"id": 3, "cat": 99, "amount": 6, "date": "2026-10-02"}]}
    assert client.post("/api/import/json", json=legacy).json()["imported"] == 2
    s = client.get("/api/state").json()
    assert len(s["cats"]) == 2 and s["cats"][0]["budget"] == 420


def test_serves_front_end(anon):
    assert "Ledger" in anon.get("/").text
