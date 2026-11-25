"""Accounts: email + password, scrypt hashes, and server-side sessions behind an HttpOnly cookie."""
import hashlib
import hmac
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response

from . import db

COOKIE = "ledger_session"
SESSION_DAYS = 30
MIN_PASSWORD = 8
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# LEDGER_SIGNUPS=closed stops new accounts after the first one (useful for a private deployment).
SIGNUPS_OPEN = os.environ.get("LEDGER_SIGNUPS", "open").lower() != "closed"
# LEDGER_SECURE_COOKIES: "auto" (default) marks the cookie Secure whenever the request came in over HTTPS.
SECURE_COOKIES = os.environ.get("LEDGER_SECURE_COOKIES", "auto").lower()

_N, _R, _P = 2 ** 14, 8, 1


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${h.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, want = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(want) // 2)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), want)


# A real hash to check against when the email doesn't exist, so a wrong email and a wrong
# password take the same time and can't be told apart.
_DUMMY = hash_password(secrets.token_hex(8))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def start_session(conn, uid: int, request: Request, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    expires = _now() + timedelta(days=SESSION_DAYS)
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (_now().isoformat(),))
    conn.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)",
                 (_token_hash(token), uid, expires.isoformat()))
    secure = SECURE_COOKIES in ("1", "true", "yes") or (SECURE_COOKIES == "auto" and request.url.scheme == "https")
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax",
                        secure=secure, path="/")


def end_session(conn, request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
    response.delete_cookie(COOKIE, path="/")


def current_user(request: Request, conn=Depends(db.get_db)):
    """Dependency for every data route: the signed-in user's row, or 401."""
    token = request.cookies.get(COOKIE)
    if token:
        r = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
            (_token_hash(token), _now().isoformat())).fetchone()
        if r:
            return r
    raise HTTPException(401, "Please log in.")


def user_id(user=Depends(current_user)) -> int:
    return user["id"]


def user_json(r) -> dict:
    return {"id": r["id"], "email": r["email"]}


def check_email(email: str) -> str:
    email = email.strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise HTTPException(422, "Enter a valid email address.")
    return email


def check_password(pw: str) -> str:
    if len(pw) < MIN_PASSWORD:
        raise HTTPException(422, f"Use at least {MIN_PASSWORD} characters for your password.")
    if len(pw) > 256:
        raise HTTPException(422, "That password is too long.")
    return pw


class Throttle:
    """Slows down password guessing: at most `limit` failures per key in `window` seconds."""

    def __init__(self, limit=10, window=15 * 60):
        self.limit, self.window, self.fails = limit, window, defaultdict(deque)

    def check(self, *keys):
        now = time.monotonic()
        for k in keys:
            q = self.fails[k]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                raise HTTPException(429, "Too many attempts. Wait a few minutes and try again.")

    def fail(self, *keys):
        now = time.monotonic()
        for k in keys:
            self.fails[k].append(now)

    def clear(self, *keys):
        for k in keys:
            self.fails.pop(k, None)


throttle = Throttle()
