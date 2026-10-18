---
name: watch-run
description: Follow a FrictionSwarm run until it needs a decision. Use with /watch-run <runId> after analyze_flow or start_fix.
---

Follow the FrictionSwarm run `$ARGUMENTS` (a run id) with the `frictionswarm` MCP tools.

1. Call `get_run` once and give the dashboard link a single time.
2. Wait about 25 seconds (Claude Code: the Monitor tool, or a background `sleep 25` via Bash with `run_in_background`; if neither is available, call `get_run` again each turn), then call `get_run` again. Repeat.
3. Post one short line only when the phase or a status changed. Say nothing otherwise.
4. Stop at:
   - `awaiting-decision`: call `get_decision`, show the whole package, and ask the user to accept or reject.
   - `done` or `failed`: report the outcome (and the error, if failed).
5. After the user decides, keep polling `get_run` until `done`, because accept and reject are asynchronous.
6. Never call `accept_fix` without an explicit yes from the user in this conversation. `reject_fix` also needs the user's call. If the verdict is `not-proven`, say so before asking.
