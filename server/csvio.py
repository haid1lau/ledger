"""CSV export, and import of bank statements or Ledger's own export."""
import csv
import io
import json
import re
from datetime import datetime

EXPORT_COLS = ["date", "type", "category", "description", "amount", "tags"]

DATE_FORMATS = ["%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%m/%d/%y", "%d/%m/%y",
                "%d-%m-%Y", "%m-%d-%Y", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y", "%d-%b-%Y"]

# header name -> role. First match wins, so the more specific names come first.
ROLES = [
    ("date", ["date", "transaction date", "posted date", "posting date", "value date"]),
    ("type", ["type", "kind"]),
    ("category", ["category"]),
    ("tags", ["tags", "tag"]),
    ("debit", ["debit", "withdrawal", "withdrawals", "money out", "paid out", "debit amount"]),
    ("credit", ["credit", "deposit", "deposits", "money in", "paid in", "credit amount"]),
    ("amount", ["amount", "value", "transaction amount"]),
    ("description", ["description", "memo", "payee", "details", "narrative", "merchant", "name", "note", "reference", "transaction"]),
]


def export_csv(conn, uid: int) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(EXPORT_COLS)
    rows = conn.execute("""
        SELECT e.date, 'expense' AS type, c.name AS category, e.note, e.amount, e.tags
          FROM expenses e JOIN categories c ON c.id = e.cat_id WHERE e.user_id = ?
        UNION ALL
        SELECT i.date, 'income', '', i.note, i.amount, '[]' FROM incomes i WHERE i.user_id = ?
        ORDER BY 1 DESC""", (uid, uid)).fetchall()
    for r in rows:
        w.writerow([r[0], r[1], r[2], r[3], f"{r[4]:.2f}", " ".join("#" + t for t in json.loads(r[5]))])
    return out.getvalue()


def parse_amount(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")") or s.startswith("-") or s.endswith("-") or s.upper().endswith(" DR")
    s = re.sub(r"[^\d.,]", "", s)
    if not s:
        return None
    if "," in s and "." in s:            # 1,234.56  or  1.234,56
        s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
    elif "," in s:                       # 1,234  or  12,50
        s = s.replace(",", ".") if re.fullmatch(r"\d+,\d{1,2}", s) else s.replace(",", "")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def pick_date_format(values: list[str]) -> str | None:
    vals = [v.strip() for v in values if v and v.strip()]
    for fmt in DATE_FORMATS:
        try:
            for v in vals:
                datetime.strptime(v, fmt)
            return fmt
        except ValueError:
            continue
    return None


def map_columns(header: list[str]) -> dict[str, int]:
    norm = [h.strip().lower() for h in header]
    cols: dict[str, int] = {}
    for role, names in ROLES:
        for i, h in enumerate(norm):
            if i in cols.values():
                continue
            if h in names or (role in ("date", "description") and any(n in h for n in names)):
                cols[role] = i
                break
    return cols


def parse_tags(s: str) -> list[str]:
    return [t for t in re.split(r"[\s,;]+", (s or "").replace("#", " ")) if t]


def parse_csv(text: str) -> dict:
    """Returns {"rows": [...], "error": str|None, "columns": {...}}. Each row is
    {kind, date, note, amount, category, tags}; amounts are always positive."""
    text = text.lstrip("﻿")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    table = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)]
    if len(table) < 2:
        return {"rows": [], "error": "The file has no data rows.", "columns": {}}
    cols = map_columns(table[0])
    body = table[1:]
    if "date" not in cols:
        return {"rows": [], "error": "Couldn't find a date column. Name it \"Date\".", "columns": cols}
    if not ({"amount"} <= cols.keys() or {"debit", "credit"} & cols.keys()):
        return {"rows": [], "error": "Couldn't find an amount column (\"Amount\", or \"Debit\"/\"Credit\").", "columns": cols}

    cell = lambda r, k: r[cols[k]].strip() if k in cols and cols[k] < len(r) else ""
    fmt = pick_date_format([cell(r, "date") for r in body])
    if not fmt:
        return {"rows": [], "error": "Couldn't read the dates. Use a format like 2026-10-09 or 10/09/2026.", "columns": cols}

    amounts = [parse_amount(cell(r, "amount")) for r in body] if "amount" in cols else []
    signed = any(a is not None and a < 0 for a in amounts)   # bank style: negative = money out

    rows = []
    for i, r in enumerate(body):
        if not cell(r, "date"):
            continue
        d = datetime.strptime(cell(r, "date"), fmt).date().isoformat()
        typ = cell(r, "type").lower()
        if "debit" in cols or "credit" in cols:
            out, inn = parse_amount(cell(r, "debit")), parse_amount(cell(r, "credit"))
            if out:
                kind, amt = "expense", abs(out)
            elif inn:
                kind, amt = "income", abs(inn)
            else:
                continue
        else:
            a = amounts[i]
            if not a:
                continue
            if typ in ("expense", "income"):
                kind = typ
            else:
                kind = ("expense" if a < 0 else "income") if signed else "expense"
            amt = abs(a)
        rows.append({
            "kind": kind, "date": d, "note": cell(r, "description")[:200], "amount": round(amt, 2),
            "category": cell(r, "category"), "tags": parse_tags(cell(r, "tags")),
        })
    return {"rows": rows, "error": None, "columns": cols}
