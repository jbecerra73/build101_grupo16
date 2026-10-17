# build101_grupo16: FrictionSwarm

See `SPEC.md` and `ARCHITECTURE.md`.

## Demo (offline, dashboard)

```bash
npm install
# optional, for model-written findings (otherwise the heuristic is used):
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' > .env.local
npm run dashboard            # http://localhost:3000  (PORT=3123 npm run dashboard for another port)
```

Open **New run**, pick personas (rosa, kai, typical), seeds, keep **Auto-fix** on and
press **Start swarm**. The pipeline runs inside the Next server process:
verify build, swarm (replayed from `runs/fixture-baseline`, ~30 s), analyze,
fix (rehearsal, no PR), preview, retest (replayed from `runs/fixture-retest`),
compare, done, in about 80 s. The run page polls `runs/<runId>/` and ends with a before/after.
Every run can be replayed afterwards (**Replay**).

The server log shows each phase and which findings path the analyzer used
(`analyzed <run>: N findings via agent-sdk | messages-api | heuristic`).

Environment variables (swarm runner, replay folders and speed, fix loop, caps)
are documented in [`apps/dashboard/.env.example`](apps/dashboard/.env.example).
Generated run folders (`runs/20*/`, `runs/.usage.json`) are gitignored; the
`runs/fixture-*` folders are tracked.

Rehearsal screenshots: [`docs/dashboard/rehearsal/`](docs/dashboard/rehearsal/).

## Other entry points

```bash
npm run pipeline -- --personas rosa,kai,typical --seeds 2 --auto-fix   # same pipeline, in the terminal
npm run analyze -- runs/<id>                                            # metrics.json + findings.json
npm run fix -- ...                                                      # P1 fix loop (orchestrator/cli.ts)
npm run typecheck && npm test
```
