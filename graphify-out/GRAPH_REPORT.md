# Graph Report - Expense Tracker  (2026-11-26)

## Corpus Check
- 23 files · ~40,515 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 2, .css 1)

## Summary
- 384 nodes · 804 edges · 20 communities (10 shown, 10 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ff7063c9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- main.py
- app.js
- test_api.py
- auth.py
- core.js
- csvio.py
- agent.py
- Claude Code rules for the Expense Tracker (Ledger)
- FrontEnd
- run.sh
- Open from a phone on the same Wi-Fi (LEDGER_HOST=0.0.0.0)
- test_ask.py
- seed_test_db.py
- Throttle
- ask.js

## God Nodes (most connected - your core abstractions)
1. `one()` - 15 edges
2. `materialize()` - 14 edges
3. `render()` - 13 edges
4. `cat()` - 13 edges
5. `import_json()` - 12 edges
6. `signup()` - 11 edges
7. `palRender()` - 11 edges
8. `Trace` - 10 edges
9. `main()` - 10 edges
10. `change_password()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `LEDGER_SIGNUPS=closed for a private instance` --references--> `signup()`  [INFERRED]
  README.md → server/main.py
- `Income and net savings` --references--> `renderSummary()`  [INFERRED]
  README.md → web/js/app.js
- `Deploy behind HTTPS with proxy headers` --references--> `same_origin_writes()`  [INFERRED]
  README.md → server/main.py
- `Tags like #work and #trip-bali` --references--> `clean_tags()`  [INFERRED]
  README.md → server/main.py
- `New accounts start empty` --references--> `signup()`  [INFERRED]
  README.md → server/main.py

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Account security** — readme_scrypt_sessions, readme_login_throttle, readme_password_change_signs_out, readme_per_account_data [EXTRACTED 1.00]

## Communities (20 total, 10 thin omitted)

### Community 0 - "main.py"
Cohesion: 0.07
Nodes (44): Deleting an account removes all its data and receipts, Original single-file version (legacy/), Receipts (photo or PDF up to 10 MB), user_id(), cat_json(), exp_json(), inc_json(), rule_json() (+36 more)

### Community 1 - "app.js"
Cohesion: 0.08
Nodes (52): Keyboard shortcuts and ⌘K command palette, allTags(), banner(), busy(), closeSheet(), commitTagInput(), csvPreview(), csvSend() (+44 more)

### Community 2 - "test_api.py"
Cohesion: 0.07
Nodes (24): connect(), get_db(), init(), lifespan(), add_period(), materialize(), anon(), cat() (+16 more)

### Community 3 - "auth.py"
Cohesion: 0.10
Nodes (20): Deploy behind HTTPS with proxy headers, Changing password signs out other devices, Scrypt hashes and 30-day HttpOnly session cookie, check_email(), check_password(), current_user(), end_session(), hash_password() (+12 more)

### Community 4 - "core.js"
Cohesion: 0.09
Nodes (20): api(), ApiError, burst(), eTags, filt, flyCoin(), FREQ, ICON (+12 more)

### Community 5 - "csvio.py"
Cohesion: 0.11
Nodes (17): 3D budget orb, Budgets per category, Income and net savings, Ledger (personal expense tracker), LEDGER_SIGNUPS=closed for a private instance, Tags like #work and #trip-bali, export_csv(), map_columns() (+9 more)

### Community 6 - "agent.py"
Cohesion: 0.07
Nodes (30): agent_steps(), ask(), authorizer(), call_tool(), check_sql(), describe_table(), Files, In the web app: the Ask tab (+22 more)

### Community 7 - "Claude Code rules for the Expense Tracker (Ledger)"
Cohesion: 0.29
Nodes (6): About this project, At the end of every session, At the start of every session, Claude Code rules for the Expense Tracker (Ledger), graphify, Memory lives in the Obsidian vault

### Community 13 - "test_ask.py"
Cohesion: 0.15
Nodes (11): answer(), events(), FakeModel, model(), use(), spend(), test_agent_only_sees_the_signed_in_account(), test_ask_explains_when_the_model_is_not_running() (+3 more)

### Community 14 - "seed_test_db.py"
Cohesion: 0.32
Nodes (3): build(), days(), money()

## Knowledge Gaps
- **6 isolated node(s):** `Deleting an account removes all its data and receipts`, `Original single-file version (legacy/)`, `Keyboard shortcuts and ⌘K command palette`, `Open from a phone on the same Wi-Fi (LEDGER_HOST=0.0.0.0)`, `Deploy behind HTTPS with proxy headers` (+1 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 118 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Ledger (personal expense tracker)` connect `csvio.py` to `main.py`, `test_api.py`?**
  _High betweenness centrality (0.344) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `render()` (e.g. with `renderBudgets()` and `renderCatPick()`) actually correct?**
  _`render()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Deleting an account removes all its data and receipts`, `Original single-file version (legacy/)`, `Keyboard shortcuts and ⌘K command palette` to the rest of the system?**
  _6 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.py` be split into smaller, more focused modules?**
  _Cohesion score 0.06749482401656315 - nodes in this community are weakly interconnected._
- **Why does `Budgets per category` connect `csvio.py` to `app.js`?**
  _High betweenness centrality (0.177) - this node is a cross-community bridge._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08051948051948052 - nodes in this community are weakly interconnected._
- **Why does `renderBudgets()` connect `app.js` to `csvio.py`?**
  _High betweenness centrality (0.163) - this node is a cross-community bridge._