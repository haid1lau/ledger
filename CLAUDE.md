# Claude Code rules for the Expense Tracker (Ledger)

## Memory lives in the Obsidian vault
Long-term memory for this project is in my Obsidian vault at `/Users/claytonlau/Documents/Obsidian Vault`, in `Projects/Expense Tracker Graph/`.
Start from the hub: `Projects/Expense Tracker Graph/Expense Tracker Graph Hub.md`. It links to topic notes (what each part does and why) and module notes (what's in each file).
Topic notes are `Ledger – <Topic>.md`; module notes are `Ledger <file>.md` (e.g. `Ledger main.py.md`). The `Ledger` prefix keeps them apart from Squirrel's `auth.py` and `db.py` notes.

### At the start of every session
1. Read the hub, especially `## Status`: where the project stands and what's next. Pick up from there instead of asking me to re-explain.
2. For questions about the code, use the knowledge graph in `graphify-out/` first (see the graphify rules below, once installed), then open only the files it points to.
3. When you need the reason behind a design, read the matching topic note: its "Design decisions" section has it.

### At the end of every session
Do this before your final reply whenever the session changed files or made a decision. Skip it if the session only read files or answered questions.
1. **Update the hub's `## Status`.** Keep it short: one bullet per session, newest first, as `- YYYY-MM-DD: what changed`, keeping the last 5, then a final `- Next: …` line. Replace the placeholder line the first time.
2. **Write a session record** in the vault's `Records/` folder, following the "Session records" rules in the vault's own `CLAUDE.md` (read it first). List the project hub and any notes you changed under "Notes touched".
3. **Keep the map current.** If files were added, removed or renamed, or a design decision was made or changed, update the matching topic or module notes in `Projects/Expense Tracker Graph/` in the same format as the existing ones, and the hub's lists. Add a note only for a new module or topic, never one per function.
4. **Follow the vault's rules:** wikilinks by file name, never touch hidden folders or `copilot/`, don't rename, move or delete existing notes unless I ask, and ask before creating a new top-level folder.

## About this project
- `./run.sh` serves the app at http://localhost:5178; `.venv/bin/pytest` runs the tests.
- Never open or copy anything in `data/`: it holds real expenses and receipts.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
