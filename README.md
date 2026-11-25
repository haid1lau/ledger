# Ledger

A personal expense tracker: a FastAPI + SQLite server with the Ledger web app as its front end.

## Run it

```sh
./run.sh
```

Then open http://localhost:5178. The first run creates `.venv/` and installs dependencies.

Your data is stored in `data/ledger.db`, and receipts in `data/receipts/`. Back up the `data/` folder, or use **Import / export → Full backup**.

To use it from your phone on the same Wi-Fi, run `LEDGER_HOST=0.0.0.0 ./run.sh` and open `http://<your-mac's-ip>:5178`. There is no login, so only do this on a network you trust.

## Accounts

Everyone signs in with an email and password, and each account sees only its own data. That includes categories, expenses, income, recurring items and receipts. Sessions last 30 days, so closing the app doesn't sign you out.

- **Every new account starts empty.** No expenses, income, categories or recurring items carry over from other accounts, from data saved before accounts existed, or from the browser.
- Passwords are stored only as salted scrypt hashes. The session cookie is HttpOnly and SameSite=Lax, and it's marked Secure whenever the site is served over HTTPS.
- After 10 failed logins in 15 minutes, a person or IP has to wait.
- In the app, the account button (your initial, top right) lets you log out, change your password, or delete your account. Changing your password signs out every other device. Deleting the account removes all of its data and receipts.

## Deploying

Ledger is a single Python process with a SQLite file, so it needs a host with a **persistent disk**. A small VPS works, as do Fly.io, Railway or Render with a volume. Serverless platforms don't work, because files there are wiped between runs.

1. Put it behind HTTPS. Most hosts do this for you; otherwise use a reverse proxy such as Caddy or nginx.
2. Run `uvicorn server.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'` so the app knows requests arrived over HTTPS.
3. Point `LEDGER_DATA` at the persistent volume (for example `LEDGER_DATA=/data`), and back that folder up regularly.
4. Optional settings:
   - `LEDGER_SIGNUPS=closed` turns off new sign-ups after the first account, for a private instance.
   - `LEDGER_SECURE_COOKIES=1` forces the Secure cookie flag if your proxy doesn't pass the HTTPS scheme through.

Not built yet: password reset by email (it needs an email provider), and email verification.

## Features

- **Budgets** per category, plus the 3D budget orb, overview and monthly summary.
- **Income and net savings**: log pay and other income, then see the amount saved, the savings rate, and six months of income against spending.
- **Recurring**: rent, subscriptions and salary are added automatically on their dates. Set one up from Budgets → Recurring, or choose *Repeat* when you log an expense or income. A rule that starts in the past back-fills the missed entries. Rules can be paused.
- **Tags**: add tags like `#work` or `#trip-bali` to an expense. Search with `#tag`, and see totals by tag in Summary.
- **Receipts**: attach a photo or PDF (up to 10 MB) to any expense.
- **CSV import/export**: export a spreadsheet, or import a bank statement CSV. The importer detects Date, Description, and Amount or Debit/Credit columns, previews the rows, and skips duplicates.

Keyboard: `N` new expense · `⌘K` command palette · `1`–`5` switch views.

## Layout

```
server/   main.py (API routes) · auth.py (accounts, sessions) · db.py (schema + migrations) · recurring.py · csvio.py
web/      index.html · css/app.css · js/core.js (state + API) · js/orb.js · js/app.js
tests/    API tests: .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
legacy/   the original single-file version
```

## Moving from the single-file version

The old version kept its data in browser storage, and nothing is imported automatically. To bring it over, export it from the old version and use **Import / export** in your account.
