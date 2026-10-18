# build101_grupo16: FrictionSwarm

See `SPEC.md` and `ARCHITECTURE.md`.

## Demo (offline, dashboard)

```bash
npm install
npm run posthog:generate     # data/posthog/events.jsonl: six months of fake PostHog history (gitignored)
# optional, for model-written findings (otherwise the heuristic is used):
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' > .env.local
npm run dashboard            # http://localhost:3000  (PORT=3123 npm run dashboard for another port)
```

Click **Analyze**, keep the default window (current release, last 28 days), the
**File export** source and **Auto-fix** on, then press **Analyze, fix and re-test**.
The orchestrator runs inside the Next server (`ORCHESTRATOR=inline`):

| Phase | What happens | Rehearsal time |
|---|---|---|
| analyzing | real users from PostHog → segment funnels, trend, findings (Sonnet, else heuristic) | ~25 s with Sonnet, ~2 s heuristic |
| fixing | rehearsal coding agent "fixes" the T1 + T2 findings (no PR) | 1.5 s (`FIX_STAGE_DELAY_MS`) |
| waiting-preview | draft PR stand-in, waiting for the preview | 1.5 s |
| retesting | offline swarm: 30 agents (Rosa, Kai, Typical × 10 fresh seeds) on the "fixed" store, live grid | ~32 s |
| collecting | waiting for the swarm's events to land in PostHog (`waitForSwarm`) | ~4 s |
| comparing | analyzer on the swarm's tracks, persona vs segment verdict | ~13 s with Sonnet |

The offline swarm (`packages/pipeline/src/offline.ts`) simulates each agent with
`tools/posthog-sim` on the store with the fixed traps removed, writes
`runs/<id>/screenshots/<agentId>.png` from the real storefront captures as agents move,
and appends their PostHog events to `data/posthog/swarm-<runId>.jsonl` after an
ingestion lag. Every run snapshots what it analyzed in `runs/<id>/posthog.jsonl`;
a re-test can be replayed from it (**Replay re-test**).

The fix loop is a rehearsal by default (`FIX_LOOP=fake`): same `fix.json` transitions,
a real re-test and the analyzer's verdict, no coding agent and no PR. `FIX_LOOP=real`
loads P1's `runFixLoop` from `orchestrator/fix-loop.ts` (or `FIX_LOOP_MODULE`) and fails
with "P1 fix loop not available" until it exists. P2's tenki swarm plugs in through
`registerTenkiSwarmRunner` (`SWARM_RUNNER=tenki`).

Environment variables are documented in [`apps/dashboard/.env.example`](apps/dashboard/.env.example).
Generated run folders (`runs/20*/`, `runs/.control/`) are gitignored; the `runs/fixture-*`
folders are tracked: `fixture-proven` (verdict ready), `fixture-not-proven` (a fix of T3
only) and `fixture-live` (re-test caught mid-swarm), each with its `-retest1` folder.

Screenshots: [`docs/dashboard/posthog/`](docs/dashboard/posthog/).

## Claude Code MCP

Drive FrictionSwarm from Claude Code: list and draft flows, analyze, fix, and accept or reject the PR.

```bash
claude mcp add frictionswarm -e FS_API_URL=http://localhost:3000 -e FS_API_TOKEN=<token> -- npx tsx apps/mcp/src/index.ts
```

| Variable | Where | Meaning |
|---|---|---|
| `DASHBOARD_API_TOKEN` | dashboard | bearer token that gates `/api/*` (works without `DASHBOARD_PASSWORD`) |
| `FS_API_URL` | MCP server | dashboard base URL, default `http://localhost:3000` |
| `FS_API_TOKEN` | MCP server | the same token as `DASHBOARD_API_TOKEN` |

These three should also be added to `.env.example` .

Example conversation (numbers are illustrative):

```
You:    Which flows do we have? Analyze checkout for the last 28 days.
Claude: (list_flows, analyze_flow) Run 2026-... started. /watch-run 2026-...
You:    Fix the top two findings.
Claude: (start_fix) ... awaiting-decision: verdict ready, +34 pts for Rosa. Accept?
You:    Yes, accept.   (accept_fix merges the PR to production main)
```

`/watch-run <runId>` (`.claude/skills/watch-run`) polls the run, posts a line per change,
and stops at `awaiting-decision` to show the decision package. It never accepts without your yes.

## Deploy

Dashboard on Netlify, orchestrator in a tenki sandbox, linked only by Netlify Blobs:
see [`docs/DEPLOY.md`](docs/DEPLOY.md) for the architecture, env vars and the setup checklist.

## Other entry points

```bash
npm run pipeline -- --auto-fix                 # same pipeline in the terminal (SWARM_SPEED=5 for a quick run)
npm run orchestrator                           # daemon: takes queued runs from the run store (dashboard with ORCHESTRATOR=queue)
npm run orchestrator:tenki -- up|status|logs|stop  # the same daemon in a tenki sandbox, against Netlify Blobs
npm run analyze -- runs/<id>                   # analyzer on one run folder
npm run typecheck && npm test
npx tsx apps/dashboard/scripts/gen-fixtures.mts          # regenerate the runs/fixture-* demo folders
node apps/dashboard/scripts/capture-screenshots.mjs     # re-capture the storefront screenshots (Playwright)
```
