# FrictionSwarm MCP for Claude Code — design

Date: 2026-10-17 · Status: approved in brainstorming, pending plan
Builds on: PR #40 (`p3/posthog-app` — PostHog pipeline, dashboard, store, daemon) and PR #22 (`p1/fix-loop` — coding agent, preview wait, verdict, PR lifecycle). Neither is on main yet; implementation starts after both merge, or branches from #40 with #22 merged in.

## Intent

The Product Owner (PO) of an e-commerce product lives in Claude Code. They're looking at PostHog data — say 40% of sessions drop off at checkout shipping — and want to act on it right there: analyze that flow, have our workflow fix and re-test it, watch it progress, and decide whether the proposed change ships. Today the only front door is the dashboard. This adds a second front door, an MCP server, so the whole story can happen inside a Claude Code conversation. The dashboard stays; the MCP is not a replacement.

Success: from "I see a drop in PostHog" to "verified fix merged to the storefront's main" in one Claude Code conversation, with progress that reads like a story, not logs, and the PO making the final call on evidence (metrics diff + code diff).

## Goals

1. PO can list, create and edit flows from Claude Code, with an explicit approval step before anything is saved. Saved flows are runnable end to end.
2. PO can analyze a flow over a window: segment funnels, where real users drop and by how much, top findings with evidence and PostHog replay links.
3. PO can say "fix these" about the analysis they just saw: the coding agent fixes exactly those findings, Netlify builds a preview, the persona swarm re-tests it, and a verdict is computed — end to end without stopping.
4. Claude reports progress during the run in plain language, until it finishes.
5. At the end, Claude presents a **decision package**: before (real-user segments) / after (persona swarm) metrics with N, the PR's code diff, findings addressed, and the verdict as a recommendation.
6. PO accepts → the PR is merged into `FrissA/demo-ecommerce` main (production redeploys). PO rejects (optional reason) → the PR is closed.
7. Every response carries links: dashboard run/flow page, PR, preview, PostHog replays where relevant.

## Non-goals

- Rendering the live screenshot grid in the terminal. Claude describes progress and links to the dashboard's live grid; the visual moment stays in the dashboard.
- Replacing the PostHog MCP. The PO may also have PostHog's own MCP connected; ours speaks in our terms (flows, segments, personas, findings, runs).
- Persona builder from Claude (personas stay presets in `shared/personas.ts`).
- Multiple flows per run (same as SPEC).
- Editing flows in the dashboard UI (read-only flow page only).

## Anti-goals (failure even if it "works")

- A flow saved, or a PR merged, without the PO having seen and approved exactly what's being saved/merged.
- The MCP and the dashboard disagreeing about a run's state (two sources of truth).
- Progress updates that are raw JSON or log dumps instead of a readable narrative.
- Auto-merging on a positive verdict. The verdict is a recommendation; the human decides.
- The fix targeting different findings than the ones the PO picked.

## Constraints

- TypeScript, npm workspaces (matches repo).
- **The dashboard HTTP API is the MCP's only backend.** The MCP never imports pipeline/store code or reads `runs/` directly.
- **The dashboard and the orchestrator meet only through the `RunStore`** (`@frictionswarm/store`: fs locally, Netlify Blobs when deployed). The deployed dashboard is a Netlify function with no `gh` CLI and no GitHub token; every GitHub action (merge, close, diff) runs in the orchestrator daemon. Requests flow dashboard → store → daemon, like `cancel.json` does today.
- Dashboard is password-gated (`DASHBOARD_PASSWORD`, cookie session, `proxy.ts` → `gate()`). The MCP needs a non-interactive credential.
- Protected storefront files (`src/lib/analytics.ts`, `build-sha` meta, `data-echo` markers) are unchanged; a flow's `required` steps/fields remain a hard constraint for the coding agent.
- Must work in offline rehearsal (`FIX_LOOP=fake`, `POSTHOG_SOURCE=file`) so the demo can be rehearsed without real PRs, and with the real fix loop from #22.
- Daemon concurrency defaults to 1 (`ORCHESTRATOR_MAX_CONCURRENT=1`). A run waiting on the PO must not hold that slot.

## Decisions made (by the PO)

- Audience: Product Owner in **Claude Code**.
- The run goes end to end without per-step approvals; the **only human gate is the final accept/reject**, made by looking at the metrics difference and the proposed code changes.
- Accept **merges** the PR into the storefront's main.
- Claude Code can be the whole show; the dashboard need not be on screen. Claude includes links to the dashboard (run id, flow pages).
- PO can **configure flows** from Claude: Claude asks for the basic information the flow needs, then shows it for approval in a layout similar to how the dashboard would display it, before saving.

## Design (my calls unless marked above)

### Shape

- New workspace `apps/mcp` (package `@frictionswarm/mcp`), a **stdio** MCP server using `@modelcontextprotocol/sdk`. Installed with:
  `claude mcp add frictionswarm -e FS_API_URL=... -e FS_API_TOKEN=... -- npx tsx apps/mcp/src/index.ts`
- Thin client: each tool = validate input → call dashboard API → reply with readable markdown (`content`) plus the raw JSON (`structuredContent`).
- `FS_API_URL` defaults to `http://localhost:3000`; dashboard links are built from it.
- If `GET /api/control` reports the orchestrator offline (stale heartbeat), tools that need the daemon say so plainly instead of queueing silently.

### Auth

- New env `DASHBOARD_API_TOKEN`. `gate()` in `apps/dashboard/lib/auth.ts` allows `/api/*` when `Authorization: Bearer <token>` matches (constant-time via the existing `safeEqual`). Cookie flow unchanged. No token configured → bearer auth disabled.

### Tools

| Tool | Input | Calls | Returns |
|---|---|---|---|
| `list_flows` | — | `GET /api/flows` | Flows (id, goal, start URL, step count) + links |
| `get_flow` | `flowId` | `GET /api/flows/:id` | Flow review card |
| `draft_flow` | full or partial `Flow` (+ `baseFlowId` when editing) | `POST /api/flows/validate` | `missing`/`errors` (what Claude must still ask for), or a **review card** + `draftHash` |
| `save_flow` | `Flow` + `draftHash` | `PUT /api/flows/:id` | Saved flow + link. Refused if `draftHash` doesn't match the body (anything changed since the card the PO saw) |
| `list_personas` | — | `GET /api/personas` | Persona ids, one-liners, the segment each stands in for |
| `analyze_flow` | `flowId`, optional `window` (default: current production release, last 28 days), optional `source` | `POST /api/runs` with `autoFix:false`, then waits/polls up to ~60 s; if not done, returns `runId` and tells Claude to follow with `get_run` | Segment funnels (per-step conversion, drop-off %, N), trend with releases, top findings (id, severity, step, evidence counts, `sinceRelease`, replay links), run link |
| `start_fix` | `runId` (a finished analysis), optional `findingIds` (default: top 1–3 by `rankFindings`), optional `seedsPerPersona` | `POST /api/runs/:id/fix` | Ack: which findings, what happens next, run link |
| `get_run` | `runId` | `GET /api/runs/:id` (+ `/swarm` during re-test) | Phase, `message`, **story** so far, links |
| `get_decision` | `runId` | `GET /api/runs/:id` + `GET /api/runs/:id/files/fix/pr.diff` | Decision package. Polite error before `awaiting-decision` |
| `accept_fix` | `runId`, optional `override` (required when the verdict is not-proven) | `POST /api/runs/:id/decision {decision:"accept"}` | "Merge requested"; Claude follows with `get_run` until `merged` (shows merge SHA, notes production redeploys) |
| `reject_fix` | `runId`, optional `reason` | `POST /api/runs/:id/decision {decision:"reject", reason}` | "Close requested"; `get_run` shows `rejected` |
| `cancel_run` | `runId` | `POST /api/runs/:id/cancel` | Ack |

Tool descriptions instruct Claude: never call `save_flow` or `accept_fix` without first showing the review card / decision package in this conversation and getting an explicit yes.

### Flows: stored, approved, runnable

- Flows move from the hard-coded `FLOWS` in `shared/flows.ts` to the store under `flows/<flowId>.json` (new `KEYS.flow`). On first read the store is seeded from `shared/flows.ts`, which stays as the seed.
- **Runs snapshot their flow:** when a run is queued, the dashboard copies the full `Flow` into the queue request, and the daemon writes it to `RunConfig.flow`. The pipeline, analyzer (`resolveStep`, completion validity), coding-agent prompt and retest read `config.flow`, falling back to `FLOWS[flowId]` for old runs. This makes stored flows runnable even when the daemon runs on another machine, and editing a flow never changes a run in flight.
- `parseStartRunRequest` validates `flowId` against the store, not `FLOWS`.
- New dashboard routes: `GET /api/flows`, `GET/PUT /api/flows/:id`, `POST /api/flows/validate`. Validation: id slug; `startUrl` http(s); at least one of `success.urlPattern`/`visibleText`; steps non-empty with unique names and routes; every `required.steps` name exists in `steps`; `required.fields` ⊆ `RequiredField`. Overwriting a seed flow is allowed (it's an edit, shown as a diff).
- Conversation: Claude collects goal, start URL, success condition, route→step map, required steps/fields, asking only for what `draft_flow` reports missing. Claude may propose a step map (e.g. from the storefront's routes); the PO confirms it in the card.
- **Review card** (markdown, mirrors the dashboard's flow page): name + goal, start URL, success rule, numbered steps `route → name` with 🔒 on required ones, required fields, and for edits a "changed" section. `draftHash` = sha256 of canonical JSON.
- Read-only dashboard page `/flows/:id` (link target).
- **Offline data:** the fake dataset (`tools/posthog-sim`) only covers the demo store's routes. Analyzing a new flow in `file` mode with no matching sessions returns an honest "no real-user sessions for this flow in the window" (N = 0) instead of empty charts; `api` mode works against real PostHog. Extending the generator to arbitrary flows is out of scope.

### Fixing an existing analysis

- `analyze_flow` always runs with `autoFix:false`, so the PO sees findings first.
- New `POST /api/runs/:id/fix {findingIds?, seedsPerPersona?}`: accepted only for an analysis run in `done` with no fix yet. Validates `findingIds` against that run's `findings.json`. Writes `runs/<id>/fix-request.json` (new `KEYS.fixRequest`).
- Daemon: polling picks up fix requests like queued work (respecting concurrency). It reopens the run at `fixing`, loads its `metrics.json`/`findings.json`, and calls the configured `FixLoop` with the selected findings. `FixLoopOptions` gains `findingIds?: string[]`. When present, both `fakeFixLoop` and P1's `runFixLoop` (#22, `orchestrator/fix-loop.ts`) fix exactly those, without re-ranking.
- `autoFix:true` from the dashboard keeps working unchanged (top findings, same run).

### Progress

- MCP tools are request/response; Claude follows a run by calling `get_run` repeatedly. `get_run`'s description says to poll every ~20–30 s and post only what's new.
- Add a repo skill `.claude/skills/watch-run` (`/watch-run <runId>`) telling Claude to loop on `get_run` until `awaiting-decision`, `done` or `failed`, posting one short line per change, then call `get_decision`.
- **Story** = timeline from `RunStatus.history` (new: `{phase, at, message}[]`, appended by the pipeline on every phase change) plus `fix.json` attempts and, during re-test, `/swarm` counts. Example:
  `✓ analyzed · 3 findings (top: surprise shipping cost, −38% at Shipping, since release "v1.4")` → `✓ fixing 2 findings` → `✓ PR #12 opened (draft)` → `✓ preview live (sha abc123)` → `… re-test 18/30 agents done` → `… waiting for PostHog ingestion` → `✓ verdict: improved — awaiting your decision`.

### Decision gate (SPEC change)

Today P1's `finalizePr` (`orchestrator/pr.ts`) marks the PR ready, or labels it `not-proven` and **closes** it, on its own. That changes:

- **Phases:** `RunPhase` gains `awaiting-decision` (after `comparing`) and the run ends in `done` only after the decision. `FixStatus` gains `merged` and `rejected`; `ready`/`not-proven` remain as the verdict's recommendation.
- **P1 (#22) changes, coordinated with its owner:**
  - `finalizePr` still uploads evidence, rewrites the PR body with the before/after table and marks it ready (improved), or comments and adds the `not-proven` label (not improved). It **no longer closes** the PR.
  - After opening the PR, the fix loop saves `gh pr diff` to `runs/<id>/fix/pr.diff` (store), so the deployed dashboard can serve it without GitHub access.
  - New `mergePr(prNumber)` (`gh pr merge --squash --delete-branch`) and `closePr(prNumber, comment)` in `orchestrator/pr.ts`, exposed through the `FixLoop` module as an `applyDecision` hook.
  - `fakeFixLoop` implements the same hook by recording the decision in `fix.json` with no GitHub call. It writes a fixture `pr.diff`, and replies are marked "(rehearsal — no PR merged)".
- **Freeing the slot:** when the pipeline reaches `awaiting-decision` it writes status and **ends** its in-process work, freeing the concurrency slot. The decision is a separate, short daemon job.
- **Decision flow:** `POST /api/runs/:id/decision {decision, reason?, override?}` (dashboard), accepted only in `awaiting-decision`, writes `runs/<id>/decision.json` (new `KEYS.decision`). It refuses a second decision, and refuses accept on not-proven without `override`. The daemon picks it up on its next poll, calls `applyDecision`, sets `FixStatus` to `merged` (with merge SHA) or `rejected`, and moves the phase to `done`. GitHub failure → stays in `awaiting-decision` with the error on the status, so the PO can retry.
- **Dashboard parity:** the fix panel gets Accept / Reject buttons calling the same route.
- **Decision package** (markdown):
  1. Verdict + `Verdict.reasons`, and the plain statement that before = real users (segments, production `build_sha`), after = constrained persona agents (preview `build_sha`).
  2. Table per targeted segment ↔ persona: completion before → after (Δ pts), N before/after, regressions (from `PersonaComparison`). Control persona included.
  3. Per-step conversion for targeted personas.
  4. Findings addressed (title, step, evidence, replay links).
  5. Coding agent's `summary`, changed files, and diff (truncated past ~300 lines, with file list).
  6. Links: PR, preview, dashboard run page.
  7. "Accept merges to production main; reject closes the PR."
- SPEC.md is updated in the implementation PR: user stories 16/17 and the "After re-test" bullet become the human decision; the phase list gains `awaiting-decision`; the run folder gains `fix-request.json`, `decision.json`, `fix/pr.diff`; `RunConfig` gains `flow`.

## Left to the builder

- Exact markdown formatting of cards and the package, as long as it scans well in a terminal.
- Whether `analyze_flow` reuses a recent finished run for the same flow + window (prefer reuse if < 1 h old).
- Error messages and retries for API/network failures (readable message, never a stack).
- Tests: flow validation and `draftHash`; story builder; fix-request and decision state machines in the daemon (rehearsal mode, `MemoryStore`); `findingIds` honored by `fakeFixLoop`; MCP tool handlers against a mocked API; bearer auth in `gate()`.

## Calls made without the PO (check these)

- Retargeted from `p3/deploy` to #40 + #22.
- GitHub actions run in the daemon via store requests, not in the dashboard; accept/reject are asynchronous ("requested" → `merged`/`rejected`).
- A run waiting for a decision releases its concurrency slot.
- Real merge/close is implemented in P1's code (#22), with the change coordinated with its owner; rehearsal mode fakes it.
- "Fix it" fixes exactly the findings from the analysis the PO saw (new fix-request path), not a fresh analysis.
- Flows created from Claude are runnable end to end (runs snapshot the flow); offline data for brand-new flows is out of scope.
