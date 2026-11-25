# Graph Report - et  (2026-11-25)

## Corpus Check
- Corpus is ~31,435 words - fits in a single context window. You may not need a graph.

## Summary
- 283 nodes · 603 edges · 13 communities (8 shown, 5 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- API Routes & Models
- Web App Views
- Database & Test Fixtures
- Accounts & Sessions
- Front-End State & API
- CSV & Product Features
- Backup, Export & Sign-Up Status
- Recurring Rules
- Login Throttling
- Run Script
- Phone Access

## God Nodes (most connected - your core abstractions)
1. `one()` - 15 edges
2. `materialize()` - 14 edges
3. `render()` - 13 edges
4. `import_json()` - 12 edges
5. `cat()` - 12 edges
6. `signup()` - 11 edges
7. `palRender()` - 11 edges
8. `start_session()` - 10 edges
9. `parse_csv()` - 10 edges
10. `change_password()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `LEDGER_SIGNUPS=closed for a private instance` --references--> `signup()`  [INFERRED]
  README.md → server/main.py
- `Income and net savings` --references--> `renderSummary()`  [INFERRED]
  README.md → web/js/app.js
- `Scrypt hashes and 30-day HttpOnly session cookie` --references--> `hash_password()`  [INFERRED]
  README.md → server/auth.py
- `Scrypt hashes and 30-day HttpOnly session cookie` --references--> `start_session()`  [INFERRED]
  README.md → server/auth.py
- `Each account sees only its own data` --references--> `current_user()`  [INFERRED]
  README.md → server/auth.py

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Account security** — readme_scrypt_sessions, readme_login_throttle, readme_password_change_signs_out, readme_per_account_data [EXTRACTED 1.00]

## Communities (13 total, 5 thin omitted)

### Community 0 - "API Routes & Models"
Cohesion: 0.08
Nodes (37): Receipts (photo or PDF up to 10 MB), user_id(), cat_json(), exp_json(), inc_json(), rule_json(), state(), add_category() (+29 more)

### Community 1 - "Web App Views"
Cohesion: 0.08
Nodes (52): Keyboard shortcuts and ⌘K command palette, allTags(), banner(), busy(), closeSheet(), commitTagInput(), csvPreview(), csvSend() (+44 more)

### Community 2 - "Database & Test Fixtures"
Cohesion: 0.08
Nodes (21): connect(), get_db(), init(), lifespan(), anon(), cat(), client(), fresh_db() (+13 more)

### Community 3 - "Accounts & Sessions"
Cohesion: 0.09
Nodes (22): Deleting an account removes all its data and receipts, Deploy behind HTTPS with proxy headers, Changing password signs out other devices, Scrypt hashes and 30-day HttpOnly session cookie, check_email(), check_password(), current_user(), end_session() (+14 more)

### Community 4 - "Front-End State & API"
Cohesion: 0.09
Nodes (20): api(), ApiError, burst(), eTags, filt, flyCoin(), FREQ, ICON (+12 more)

### Community 5 - "CSV & Product Features"
Cohesion: 0.15
Nodes (12): 3D budget orb, Budgets per category, Income and net savings, Ledger (personal expense tracker), Tags like #work and #trip-bali, export_csv(), map_columns(), parse_amount() (+4 more)

### Community 6 - "Backup, Export & Sign-Up Status"
Cohesion: 0.18
Nodes (8): Original single-file version (legacy/), LEDGER_SIGNUPS=closed for a private instance, auth_status(), backup(), export_csv(), get_receipt(), get_state(), me()

### Community 7 - "Recurring Rules"
Cohesion: 0.31
Nodes (3): add_period(), materialize(), test_add_period_clamps_month_end()

## Knowledge Gaps
- **6 isolated node(s):** `Changing password signs out other devices`, `Deleting an account removes all its data and receipts`, `Deploy behind HTTPS with proxy headers`, `Open from a phone on the same Wi-Fi (LEDGER_HOST=0.0.0.0)`, `Keyboard shortcuts and ⌘K command palette` (+1 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 76 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Ledger (personal expense tracker)` connect `CSV & Product Features` to `API Routes & Models`, `Recurring Rules`?**
  _High betweenness centrality (0.430) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `render()` (e.g. with `renderBudgets()` and `renderCatPick()`) actually correct?**
  _`render()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Changing password signs out other devices`, `Deleting an account removes all its data and receipts`, `Deploy behind HTTPS with proxy headers` to the rest of the system?**
  _6 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API Routes & Models` be split into smaller, more focused modules?**
  _Cohesion score 0.07615018508725542 - nodes in this community are weakly interconnected._
- **Why does `Budgets per category` connect `CSV & Product Features` to `Web App Views`?**
  _High betweenness centrality (0.224) - this node is a cross-community bridge._
- **Should `Web App Views` be split into smaller, more focused modules?**
  _Cohesion score 0.08051948051948052 - nodes in this community are weakly interconnected._
- **Why does `renderBudgets()` connect `Web App Views` to `CSV & Product Features`?**
  _High betweenness centrality (0.207) - this node is a cross-community bridge._