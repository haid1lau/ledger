#!/bin/sh
# Start Ledger at http://localhost:5178  (set LEDGER_HOST=0.0.0.0 to open it from your phone on the same Wi-Fi)
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
exec .venv/bin/uvicorn server.main:app --host "${LEDGER_HOST:-127.0.0.1}" --port "${LEDGER_PORT:-5178}"
