"""Ledger API + static front end.  Run:  uvicorn server.main:app --port 5178"""
import json
import re
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import auth, csvio, db
from .auth import user_id
from .recurring import add_period, materialize

PALETTE = ["#FF7A59", "#D7FF3D", "#8B7BFF", "#7CF3FF", "#FFD166", "#FF8FD1", "#6AF0A8", "#FFA94D"]
RECEIPT_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic",
                 "image/gif": ".gif", "application/pdf": ".pdf"}
MAX_RECEIPT = 10 * 1024 * 1024
MAX_CSV = 5 * 1024 * 1024


@asynccontextmanager
async def lifespan(_):
    db.init()
    yield


app = FastAPI(title="Ledger", lifespan=lifespan)
Freq = Literal["weekly", "monthly", "yearly"]


@app.middleware("http")
async def same_origin_writes(request: Request, call_next):
    """Refuse API writes sent from another website (the session cookie is SameSite=Lax too)."""
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/") and origin:
        if urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-site request refused."}, status_code=403)
    return await call_next(request)


# ---------- models ----------

def clean_tags(v: list[str]) -> list[str]:
    out = []
    for t in v:
        t = re.sub(r"\s+", "-", t.strip().lstrip("#").lower())[:32]
        if t and t not in out:
            out.append(t)
    return out[:12]


class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)


class PasswordChange(BaseModel):
    current: str
    new: str


class PasswordConfirm(BaseModel):
    password: str


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    budget: float = Field(0, ge=0)
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def strip(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("Name can't be empty.")
        return v


class ExpenseIn(BaseModel):
    cat: int
    amount: float = Field(gt=0)
    date: date
    note: str = Field("", max_length=200)
    tags: list[str] = []
    repeat: Freq | None = None   # only honoured on create

    @field_validator("tags")
    @classmethod
    def norm_tags(cls, v):
        return clean_tags(v)


class IncomeIn(BaseModel):
    amount: float = Field(gt=0)
    date: date
    note: str = Field("", max_length=200)
    repeat: Freq | None = None


class RuleIn(BaseModel):
    kind: Literal["expense", "income"]
    cat: int | None = None
    amount: float = Field(gt=0)
    note: str = Field("", max_length=200)
    tags: list[str] = []
    freq: Freq
    next: date
    active: bool = True

    @field_validator("tags")
    @classmethod
    def norm_tags(cls, v):
        return clean_tags(v)


class ImportJSON(BaseModel):
    cats: list[dict] = []
    exps: list[dict] = []
    incs: list[dict] = []
    rules: list[dict] = []


# ---------- helpers (every lookup is scoped to the signed-in user) ----------

def one(conn, table, id_, uid):
    r = conn.execute(f"SELECT * FROM {table} WHERE id = ? AND user_id = ?", (id_, uid)).fetchone()
    if not r:
        raise HTTPException(404, "Not found.")
    return r


def need_cat(conn, cat_id, uid):
    if cat_id is None or not conn.execute("SELECT 1 FROM categories WHERE id = ? AND user_id = ?", (cat_id, uid)).fetchone():
        raise HTTPException(400, "Pick a category first.")


def new_rule(conn, uid, kind, cat_id, amount, note, tags, freq, start: date) -> int:
    nxt = add_period(start, freq, start.day)
    return conn.execute(
        "INSERT INTO rules (kind, cat_id, amount, note, tags, freq, anchor_day, next_date, user_id) VALUES (?,?,?,?,?,?,?,?,?)",
        (kind, cat_id, amount, note, json.dumps(tags), freq, start.day, nxt.isoformat(), uid),
    ).lastrowid


def drop_receipt(name):
    if name:
        (db.RECEIPTS / name).unlink(missing_ok=True)


def category_for(conn, uid, name: str, cache: dict) -> int:
    key = name.strip().lower()
    if key in cache:
        return cache[key]
    r = conn.execute("SELECT id FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE", (uid, name.strip())).fetchone()
    if r:
        cache[key] = r["id"]
    else:
        n = conn.execute("SELECT COUNT(*) FROM categories WHERE user_id = ?", (uid,)).fetchone()[0]
        cache[key] = conn.execute("INSERT INTO categories (name, budget, color, user_id) VALUES (?, 0, ?, ?)",
                                  (name.strip()[:60], PALETTE[n % len(PALETTE)], uid)).lastrowid
    return cache[key]


# ---------- accounts ----------

@app.post("/api/auth/signup", status_code=201)
def signup(body: Credentials, request: Request, response: Response, conn=Depends(db.get_db)):
    email, pw = auth.check_email(body.email), auth.check_password(body.password)
    first = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    if not first and not auth.SIGNUPS_OPEN:
        raise HTTPException(403, "New sign-ups are closed on this server.")
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        raise HTTPException(409, "An account with that email already exists. Log in instead.")
    uid = conn.execute("INSERT INTO users (email, pw_hash) VALUES (?,?)", (email, auth.hash_password(pw))).lastrowid
    auth.start_session(conn, uid, request, response)   # a new account always starts with no records
    return {"user": {"id": uid, "email": email}}


@app.post("/api/auth/login")
def login(body: Credentials, request: Request, response: Response, conn=Depends(db.get_db)):
    email = body.email.strip().lower()
    ip = request.client.host if request.client else "?"
    auth.throttle.check(ip, email)
    r = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not auth.verify_password(body.password, r["pw_hash"] if r else auth._DUMMY) or not r:
        auth.throttle.fail(ip, email)
        raise HTTPException(401, "That email and password don't match.")
    auth.throttle.clear(email)
    auth.start_session(conn, r["id"], request, response)
    return {"user": auth.user_json(r)}


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response, conn=Depends(db.get_db)):
    auth.end_session(conn, request, response)


@app.get("/api/auth/me")
def me(user=Depends(auth.current_user)):
    return {"user": auth.user_json(user), "signups_open": auth.SIGNUPS_OPEN}


@app.get("/api/auth/status")
def auth_status(conn=Depends(db.get_db)):
    """Lets the login screen say whether creating an account is possible."""
    has_users = conn.execute("SELECT 1 FROM users").fetchone() is not None
    return {"signups_open": auth.SIGNUPS_OPEN or not has_users, "has_users": has_users}


@app.post("/api/auth/password", status_code=204)
def change_password(body: PasswordChange, request: Request, response: Response,
                    user=Depends(auth.current_user), conn=Depends(db.get_db)):
    if not auth.verify_password(body.current, user["pw_hash"]):
        raise HTTPException(403, "Your current password isn't right.")
    conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (auth.hash_password(auth.check_password(body.new)), user["id"]))
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))   # sign out every other device
    auth.start_session(conn, user["id"], request, response)


@app.post("/api/auth/delete-account", status_code=204)
def delete_account(body: PasswordConfirm, request: Request, response: Response,
                   user=Depends(auth.current_user), conn=Depends(db.get_db)):
    if not auth.verify_password(body.password, user["pw_hash"]):
        raise HTTPException(403, "That password isn't right.")
    uid = user["id"]
    receipts = [r["receipt"] for r in conn.execute("SELECT receipt FROM expenses WHERE user_id = ? AND receipt IS NOT NULL", (uid,))]
    for t in ("expenses", "incomes", "rules", "categories", "sessions"):   # children before parents
        conn.execute(f"DELETE FROM {t} WHERE user_id = ?", (uid,))
    conn.execute("DELETE FROM users WHERE id = ?", (uid,))
    conn.commit()
    for name in receipts:
        drop_receipt(name)
    response.delete_cookie(auth.COOKIE, path="/")


# ---------- state ----------

@app.get("/api/state")
def get_state(uid=Depends(user_id), conn=Depends(db.get_db)):
    materialize(conn, uid)
    return {**db.state(conn, uid), "today": date.today().isoformat()}


# ---------- categories ----------

@app.post("/api/categories", status_code=201)
def add_category(body: CategoryIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    if conn.execute("SELECT 1 FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE", (uid, body.name)).fetchone():
        raise HTTPException(409, "That category already exists.")
    cid = conn.execute("INSERT INTO categories (name, budget, color, user_id) VALUES (?,?,?,?)",
                       (body.name, body.budget, body.color, uid)).lastrowid
    return db.cat_json(one(conn, "categories", cid, uid))


@app.put("/api/categories/{cid}")
def edit_category(cid: int, body: CategoryIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "categories", cid, uid)
    if conn.execute("SELECT 1 FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?",
                    (uid, body.name, cid)).fetchone():
        raise HTTPException(409, "That category already exists.")
    conn.execute("UPDATE categories SET name=?, budget=?, color=? WHERE id=?", (body.name, body.budget, body.color, cid))
    return db.cat_json(one(conn, "categories", cid, uid))


@app.delete("/api/categories/{cid}", status_code=204)
def delete_category(cid: int, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "categories", cid, uid)
    if conn.execute("SELECT 1 FROM expenses WHERE cat_id = ?", (cid,)).fetchone():
        raise HTTPException(409, "This category still has expenses. Move or delete them first.")
    if conn.execute("SELECT 1 FROM rules WHERE cat_id = ?", (cid,)).fetchone():
        raise HTTPException(409, "A recurring expense uses this category. Delete it first.")
    conn.execute("DELETE FROM categories WHERE id = ?", (cid,))


# ---------- expenses ----------

@app.post("/api/expenses", status_code=201)
def add_expense(body: ExpenseIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    need_cat(conn, body.cat, uid)
    amt = round(body.amount, 2)
    rule = new_rule(conn, uid, "expense", body.cat, amt, body.note.strip(), body.tags, body.repeat, body.date) if body.repeat else None
    eid = conn.execute(
        "INSERT INTO expenses (cat_id, amount, date, note, tags, rule_id, user_id) VALUES (?,?,?,?,?,?,?)",
        (body.cat, amt, body.date.isoformat(), body.note.strip(), json.dumps(body.tags), rule, uid),
    ).lastrowid
    materialize(conn, uid)   # a repeat started in the past catches up right away
    return db.exp_json(one(conn, "expenses", eid, uid))


@app.put("/api/expenses/{eid}")
def edit_expense(eid: int, body: ExpenseIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "expenses", eid, uid)
    need_cat(conn, body.cat, uid)
    conn.execute("UPDATE expenses SET cat_id=?, amount=?, date=?, note=?, tags=? WHERE id=?",
                 (body.cat, round(body.amount, 2), body.date.isoformat(), body.note.strip(), json.dumps(body.tags), eid))
    return db.exp_json(one(conn, "expenses", eid, uid))


@app.delete("/api/expenses/{eid}", status_code=204)
def delete_expense(eid: int, uid=Depends(user_id), conn=Depends(db.get_db)):
    r = one(conn, "expenses", eid, uid)
    conn.execute("DELETE FROM expenses WHERE id = ?", (eid,))
    drop_receipt(r["receipt"])


@app.post("/api/expenses/{eid}/receipt")
async def upload_receipt(eid: int, file: UploadFile = File(...), uid=Depends(user_id), conn=Depends(db.get_db)):
    r = one(conn, "expenses", eid, uid)
    ext = RECEIPT_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(415, "Receipts can be a photo (JPG, PNG, WebP, HEIC) or a PDF.")
    data = await file.read(MAX_RECEIPT + 1)
    if len(data) > MAX_RECEIPT:
        raise HTTPException(413, "That file is over 10 MB.")
    name = uuid.uuid4().hex + ext
    (db.RECEIPTS / name).write_bytes(data)
    conn.execute("UPDATE expenses SET receipt = ? WHERE id = ?", (name, eid))
    drop_receipt(r["receipt"])
    return db.exp_json(one(conn, "expenses", eid, uid))


@app.delete("/api/expenses/{eid}/receipt")
def delete_receipt(eid: int, uid=Depends(user_id), conn=Depends(db.get_db)):
    r = one(conn, "expenses", eid, uid)
    conn.execute("UPDATE expenses SET receipt = NULL WHERE id = ?", (eid,))
    drop_receipt(r["receipt"])
    return db.exp_json(one(conn, "expenses", eid, uid))


@app.get("/api/receipts/{name}")
def get_receipt(name: str, uid=Depends(user_id), conn=Depends(db.get_db)):
    owned = conn.execute("SELECT 1 FROM expenses WHERE receipt = ? AND user_id = ?", (name, uid)).fetchone()
    if not owned or not re.fullmatch(r"[0-9a-f]{32}\.[a-z]{3,4}", name) or not (db.RECEIPTS / name).is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(db.RECEIPTS / name, headers={"Cache-Control": "private, max-age=3600"})


# ---------- income ----------

@app.post("/api/incomes", status_code=201)
def add_income(body: IncomeIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    amt = round(body.amount, 2)
    rule = new_rule(conn, uid, "income", None, amt, body.note.strip(), [], body.repeat, body.date) if body.repeat else None
    iid = conn.execute("INSERT INTO incomes (amount, date, note, rule_id, user_id) VALUES (?,?,?,?,?)",
                       (amt, body.date.isoformat(), body.note.strip(), rule, uid)).lastrowid
    materialize(conn, uid)
    return db.inc_json(one(conn, "incomes", iid, uid))


@app.put("/api/incomes/{iid}")
def edit_income(iid: int, body: IncomeIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "incomes", iid, uid)
    conn.execute("UPDATE incomes SET amount=?, date=?, note=? WHERE id=?",
                 (round(body.amount, 2), body.date.isoformat(), body.note.strip(), iid))
    return db.inc_json(one(conn, "incomes", iid, uid))


@app.delete("/api/incomes/{iid}", status_code=204)
def delete_income(iid: int, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "incomes", iid, uid)
    conn.execute("DELETE FROM incomes WHERE id = ?", (iid,))


# ---------- recurring rules ----------

def rule_values(conn, uid, body: RuleIn):
    if body.kind == "expense":
        need_cat(conn, body.cat, uid)
    return (body.kind, body.cat if body.kind == "expense" else None, round(body.amount, 2), body.note.strip(),
            json.dumps(body.tags), body.freq, body.next.day, body.next.isoformat(), int(body.active))


@app.post("/api/rules", status_code=201)
def add_rule(body: RuleIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    rid = conn.execute(
        "INSERT INTO rules (kind, cat_id, amount, note, tags, freq, anchor_day, next_date, active, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (*rule_values(conn, uid, body), uid)).lastrowid
    materialize(conn, uid)
    return db.rule_json(one(conn, "rules", rid, uid))


@app.put("/api/rules/{rid}")
def edit_rule(rid: int, body: RuleIn, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "rules", rid, uid)
    conn.execute(
        "UPDATE rules SET kind=?, cat_id=?, amount=?, note=?, tags=?, freq=?, anchor_day=?, next_date=?, active=? WHERE id=?",
        (*rule_values(conn, uid, body), rid))
    materialize(conn, uid)
    return db.rule_json(one(conn, "rules", rid, uid))


@app.delete("/api/rules/{rid}", status_code=204)
def delete_rule(rid: int, uid=Depends(user_id), conn=Depends(db.get_db)):
    one(conn, "rules", rid, uid)   # rows it already created stay; their rule link is cleared
    conn.execute("DELETE FROM rules WHERE id = ?", (rid,))


# ---------- import / export ----------

@app.get("/api/export.csv")
def export_csv(uid=Depends(user_id), conn=Depends(db.get_db)):
    return Response(csvio.export_csv(conn, uid), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="ledger-{date.today()}.csv"'})


@app.get("/api/backup.json")
def backup(uid=Depends(user_id), conn=Depends(db.get_db)):
    return JSONResponse(db.state(conn, uid),
                        headers={"Content-Disposition": f'attachment; filename="ledger-backup-{date.today()}.json"'})


@app.post("/api/import/csv")
async def import_csv(file: UploadFile = File(...), default_cat: int | None = Form(None),
                     commit: bool = Form(False), uid=Depends(user_id), conn=Depends(db.get_db)):
    raw = await file.read(MAX_CSV + 1)
    if len(raw) > MAX_CSV:
        raise HTTPException(413, "That CSV is over 5 MB.")
    text = raw.decode("utf-8-sig", errors="replace")
    parsed = csvio.parse_csv(text)
    if parsed["error"]:
        raise HTTPException(422, parsed["error"])

    seen = {(r["date"], round(r["amount"], 2), r["note"].lower(), "expense")
            for r in conn.execute("SELECT date, amount, note FROM expenses WHERE user_id = ?", (uid,))}
    seen |= {(r["date"], round(r["amount"], 2), r["note"].lower(), "income")
             for r in conn.execute("SELECT date, amount, note FROM incomes WHERE user_id = ?", (uid,))}
    fresh, dupes = [], 0
    for r in parsed["rows"]:
        k = (r["date"], r["amount"], r["note"].lower(), r["kind"])
        if k in seen:
            dupes += 1
        else:
            seen.add(k)
            fresh.append(r)

    summary = {
        "expenses": sum(r["kind"] == "expense" for r in fresh),
        "income": sum(r["kind"] == "income" for r in fresh),
        "duplicates": dupes,
        "needs_category": any(r["kind"] == "expense" and not r["category"] for r in fresh),
        "new_categories": sorted({r["category"] for r in fresh if r["category"]} -
                                 {c["name"] for c in conn.execute("SELECT name FROM categories WHERE user_id = ?", (uid,))},
                                 key=str.lower),
        "preview": fresh[:8],
    }
    if not commit:
        return summary

    if summary["needs_category"] and default_cat is not None:
        need_cat(conn, default_cat, uid)
    cache: dict = {}
    for r in fresh:
        if r["kind"] == "income":
            conn.execute("INSERT INTO incomes (amount, date, note, user_id) VALUES (?,?,?,?)",
                         (r["amount"], r["date"], r["note"], uid))
            continue
        cid = category_for(conn, uid, r["category"], cache) if r["category"] else (
            default_cat if default_cat is not None else category_for(conn, uid, "Imported", cache))
        conn.execute("INSERT INTO expenses (cat_id, amount, date, note, tags, user_id) VALUES (?,?,?,?,?,?)",
                     (cid, r["amount"], r["date"], r["note"], json.dumps(clean_tags(r["tags"])), uid))
    return {**summary, "imported": len(fresh)}


@app.post("/api/import/json")
def import_json(body: ImportJSON, uid=Depends(user_id), conn=Depends(db.get_db)):
    """Merge a backup or the old browser-only data ({cats, exps, incs?, rules?}). Categories match by name."""
    cache, ids = {}, {}
    for c in body.cats:
        name = str(c.get("name", "")).strip()
        if not name:
            continue
        cid = category_for(conn, uid, name, cache)
        ids[c.get("id")] = cid
        if c.get("budget") is not None or c.get("color"):
            color = c.get("color") if re.fullmatch(r"#[0-9A-Fa-f]{6}", str(c.get("color", ""))) else None
            conn.execute("UPDATE categories SET budget = COALESCE(?, budget), color = COALESCE(?, color) WHERE id = ?",
                         (max(0.0, float(c["budget"])) if c.get("budget") is not None else None, color, cid))
    n = 0
    for e in body.exps:
        cid = ids.get(e.get("cat"))
        try:
            amt, d = round(float(e["amount"]), 2), date.fromisoformat(str(e["date"])).isoformat()
        except (KeyError, ValueError, TypeError):
            continue
        if cid is None or amt <= 0:
            continue
        conn.execute("INSERT INTO expenses (cat_id, amount, date, note, tags, user_id) VALUES (?,?,?,?,?,?)",
                     (cid, amt, d, str(e.get("note") or "")[:200], json.dumps(clean_tags(e.get("tags") or [])), uid))
        n += 1
    for i in body.incs:
        try:
            amt, d = round(float(i["amount"]), 2), date.fromisoformat(str(i["date"])).isoformat()
        except (KeyError, ValueError, TypeError):
            continue
        if amt > 0:
            conn.execute("INSERT INTO incomes (amount, date, note, user_id) VALUES (?,?,?,?)",
                         (amt, d, str(i.get("note") or "")[:200], uid))
            n += 1
    for r in body.rules:
        try:
            vals = rule_values(conn, uid, RuleIn(**{**r, "cat": ids.get(r.get("cat")) if r.get("kind") == "expense" else None}))
        except (ValueError, HTTPException):
            continue
        conn.execute(
            "INSERT INTO rules (kind, cat_id, amount, note, tags, freq, anchor_day, next_date, active, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (*vals, uid))
    materialize(conn, uid)
    return {"imported": n}


# ---------- front end ----------

class FrontEnd(StaticFiles):
    """Without this, browsers may reuse an old cached app.js against a newer index.html after an edit,
    which breaks rendering and makes saved data look lost."""
    async def get_response(self, path, scope):
        res = await super().get_response(path, scope)
        res.headers["Cache-Control"] = "no-cache"
        return res


app.mount("/", FrontEnd(directory=db.ROOT / "web", html=True), name="web")
