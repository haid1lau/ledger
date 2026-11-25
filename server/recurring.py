"""Recurring rules: turn every occurrence that has come due into a real expense or income row."""
from calendar import monthrange
from datetime import date, timedelta

MAX_CATCH_UP = 1000  # guards against a rule dated decades back


def add_period(d: date, freq: str, anchor: int) -> date:
    if freq == "weekly":
        return d + timedelta(days=7)
    if freq == "monthly":
        y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    else:  # yearly
        y, m = d.year + 1, d.month
    return date(y, m, min(anchor, monthrange(y, m)[1]))


def materialize(conn, uid: int, today: date | None = None) -> int:
    """Create rows for every due occurrence of this user's rules and advance each one. Returns how many rows were added."""
    today = today or date.today()
    made = 0
    due = conn.execute(
        "SELECT * FROM rules WHERE user_id = ? AND active = 1 AND next_date <= ?", (uid, today.isoformat())
    ).fetchall()
    for r in due:
        d = date.fromisoformat(r["next_date"])
        n = 0
        while d <= today and n < MAX_CATCH_UP:
            if r["kind"] == "expense":
                conn.execute(
                    "INSERT INTO expenses (cat_id, amount, date, note, tags, rule_id, user_id) VALUES (?,?,?,?,?,?,?)",
                    (r["cat_id"], r["amount"], d.isoformat(), r["note"], r["tags"], r["id"], uid),
                )
            else:
                conn.execute(
                    "INSERT INTO incomes (amount, date, note, rule_id, user_id) VALUES (?,?,?,?,?)",
                    (r["amount"], d.isoformat(), r["note"], r["id"], uid),
                )
            d = add_period(d, r["freq"], r["anchor_day"])
            n += 1
        made += n
        conn.execute("UPDATE rules SET next_date = ? WHERE id = ?", (d.isoformat(), r["id"]))
    return made
