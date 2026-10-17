# FrictionSwarm MCP for Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Product Owner configure flows, analyze them, fix chosen findings, follow the run and accept (merge) or reject (close) the PR from Claude Code, through an MCP server backed by the dashboard API.

**Architecture:** A stdio MCP server (`apps/mcp`) is a thin client of the dashboard HTTP API (bearer token). The dashboard only writes requests into the `RunStore` (`flows/`, `fix-request.json`, `decision.json`); the orchestrator daemon picks them up, runs the fix loop for chosen findings, parks the run in `awaiting-decision` (freeing its slot), and later applies the PO's decision through the fix-loop module (real: `gh` in `orchestrator/pr.ts`; rehearsal: `fakeFix.ts`).

**Tech Stack:** TypeScript (ESM, tsx), npm workspaces, vitest, Next.js 16 route handlers, `@frictionswarm/store` (fs / Netlify Blobs / memory), `@modelcontextprotocol/sdk` ^1.32 + `zod` ^4 (already root deps), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-17-claude-code-mcp-design.md`

**Base:** start after PR #40 (`p3/posthog-app`) merges to main (#22 is already on main). If #40 is still open, branch from `origin/p3/posthog-app` merged with `origin/main`. All paths below are as on that tree.

## Global Constraints

- The MCP never imports pipeline/store code or reads `runs/`; it only calls the dashboard API.
- The dashboard never runs `gh` and holds no GitHub token; every GitHub action runs in the orchestrator daemon.
- Dashboard ↔ daemon only through `RunStore` keys (`packages/store/src/control.ts` `KEYS`).
- A run in `awaiting-decision` holds no concurrency slot (`ORCHESTRATOR_MAX_CONCURRENT=1` default).
- Accept merges with `gh pr merge <n> --repo FrissA/demo-ecommerce --squash --delete-branch`. Reject comments the reason (if any) and `gh pr close`.
- Accepting a not-proven fix requires `override: true`.
- Never call `save_flow` or `accept_fix` without first showing the review card / decision package and getting an explicit yes (tool description text).
- Before = real users (segments, production `build_sha`); after = constrained persona agents (preview `build_sha`). Every decision package says so and shows N next to every number.
- Protected storefront files (`src/lib/analytics.ts`, `build-sha` meta, `data-echo` markers) and a flow's `required` steps/fields stay hard constraints for the coding agent.
- Rehearsal (`FIX_LOOP=fake`) must work end to end; its replies say "(rehearsal — no PR merged)".
- Default fix targets: top 1–3 findings by `rankFindings`.
- Default analysis window: current production release, last 28 days (`defaultWindow()`).

## Review Focus

1. **Daemon restart while a run awaits a decision** — `Orchestrator.recover()` marks every non-terminal run failed; a parked run must survive a restart and still accept a decision. (Test in Task 6.)
2. **Two decisions racing** (dashboard button + MCP, or a double call) — the second gets 409 and nothing is merged twice; the daemon deletes `decision.json` only after applying. (Tests in Tasks 6 and 7.)
3. **Orchestrator offline when the PO acts** — the request persists in the store and is applied when the daemon is back; MCP replies say the orchestrator is offline instead of implying progress. (Tests in Tasks 7 and 9.)
4. **Flow edited while a run uses it** — the run keeps its `config.flow` snapshot; the retest and coding agent use the snapshot, not the edited flow. (Test in Task 3.)
5. **GitHub merge fails** (conflict, branch protection) — run stays `awaiting-decision` with `status.error`, `decision.json` is removed so the PO can retry, and the MCP shows the error. (Test in Task 6.)

---

### Task 1: Contracts for the decision gate, flows and history

**Files:**
- Modify: `shared/contracts.ts` (`RunPhase`, `FixStatus`, `FixAttempt`, `RunStatus`, `RunConfig`, new types)
- Modify: `packages/store/src/control.ts` (`KEYS`)
- Modify: `apps/dashboard/lib/control-types.ts` (re-export new request types next to `CancelRequest`)
- Test: `shared/contracts.test.ts`, `packages/store/src/store.test.ts`

**Interfaces:**
- Produces:
  - `RunPhase` adds `"awaiting-decision"` between `"comparing"` and `"done"`.
  - `FixStatus` adds `"merged" | "rejected"`.
  - `FixAttempt` adds `decision?: { decision: "accept" | "reject"; reason?: string; override?: boolean; decidedAt: string; mergeSha?: string; rehearsal?: boolean }`.
  - `RunStatus` adds `history?: { phase: RunPhase; at: string; message?: string }[]`.
  - `RunConfig` adds `flow?: Flow` (snapshot) and `fixFindingIds?: string[]`.
  - `export type FixRequest = { runId: string; findingIds?: string[]; seedsPerPersona?: number; requestedAt: string }`
  - `export type DecisionRequest = { runId: string; decision: "accept" | "reject"; reason?: string; override?: boolean; requestedAt: string }`
  - `KEYS.flow(id) = "flows/<id>.json"`, `KEYS.flows = "flows/"`, `KEYS.fixRequest(runId) = "runs/<runId>/fix-request.json"`, `KEYS.decision(runId) = "runs/<runId>/decision.json"`, `KEYS.prDiff(runId) = "runs/<runId>/fix/pr.diff"`.

- [ ] **Step 1: Write failing tests** — `KEYS` test: `expect(KEYS.flow("buy-tshirt")).toBe("flows/buy-tshirt.json")`, `expect(KEYS.decision("r1")).toBe("runs/r1/decision.json")`, `expect(KEYS.fixRequest("r1")).toBe("runs/r1/fix-request.json")`, `expect(KEYS.prDiff("r1")).toBe("runs/r1/fix/pr.diff")`; and `assertKey` accepts each.
- [ ] **Step 2: Run** `npx vitest run packages/store shared` — Expected: FAIL (`KEYS.flow is not a function`).
- [ ] **Step 3: Add the types and keys** listed above. Grep for exhaustive `switch`/`Record<RunPhase, …>` / `Record<FixStatus, …>` maps (`apps/dashboard/lib/derive.ts`, `format.ts`, `components/run/phase-stepper.tsx`, `fix-panel.tsx`) and add entries: `awaiting-decision` label "Awaiting decision"; `merged` "Merged"; `rejected` "Rejected".
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Contracts: awaiting-decision, merged/rejected, flow snapshot, decision and fix requests"`

### Task 2: Flow store and validation

**Files:**
- Create: `packages/store/src/flows.ts`
- Modify: `packages/store/src/index.ts` (export), `packages/store/package.json` (dep `@frictionswarm/shared` if missing)
- Test: `packages/store/src/flows.test.ts`

**Interfaces:**
- Consumes: `KEYS.flow`, `KEYS.flows` (Task 1); `FLOWS`, `Flow`, `RequiredField` from `@frictionswarm/shared`.
- Produces:
  - `validateFlow(input: unknown): { ok: true; flow: Flow } | { ok: false; missing: string[]; errors: string[] }`
  - `flowHash(flow: Flow): string` — sha256 hex of canonical JSON (keys sorted recursively).
  - `diffFlows(before: Flow | undefined, after: Flow): string[]` — human lines like `"steps: + /cart/coupon → Coupon"`, `"success.visibleText: \"Payment confirmed\" → \"Thanks!\""`.
  - `listFlows(store: RunStore): Promise<Flow[]>` — seed flows (from `FLOWS`) overlaid by stored ones, sorted by id.
  - `getFlow(store: RunStore, id: string): Promise<Flow | undefined>` — stored, else seed.
  - `putFlow(store: RunStore, flow: Flow): Promise<void>`

- [ ] **Step 1: Write failing tests**:
  - `validateFlow({})` → `ok:false`, `missing` equals `["id","goal","startUrl","success","steps","required"]`.
  - `validateFlow({...buyTshirt, id: "Bad Id"})` → errors contain `"id must be a lowercase slug (a-z, 0-9, -)"`.
  - `startUrl: "ftp://x"` → `"startUrl must be an http(s) URL"`.
  - `success: {}` → `"success needs urlPattern or visibleText"`.
  - duplicate step name → `"step names must be unique"`; duplicate route → `"step routes must be unique"`.
  - `required.steps: ["Nope"]` → `"required step \"Nope\" is not in steps"`.
  - `required.fields: ["shoeSize"]` → `"unknown required field \"shoeSize\""`.
  - `validateFlow(buyTshirt)` → `ok:true`.
  - `flowHash` equal for the same flow with keys in different order; different when one step name changes.
  - `listFlows(new MemoryStore())` returns `[buyTshirt]`; after `putFlow` of an edited `buy-tshirt` and a new `coupon` flow, returns both with the edit.
  - `diffFlows(buyTshirt, withExtraStep)` contains `"steps: + /cart/coupon → Coupon"`.
- [ ] **Step 2: Run** `npx vitest run packages/store/src/flows.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `packages/store/src/flows.ts`. Valid `RequiredField` values come from the `RequiredField` union — export a `REQUIRED_FIELDS` const array from `shared/contracts.ts` (the union becomes `typeof REQUIRED_FIELDS[number]`) so validation and type share one list.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Store: flows in the run store, validation, hash and diff"`

### Task 3: Runs snapshot their flow

**Files:**
- Modify: `packages/pipeline/src/pipeline.ts` (`validateRequest`, `analysisConfig`)
- Modify: `packages/pipeline/src/daemon.ts` (`take`)
- Modify: `packages/pipeline/src/offline.ts:123`, `packages/pipeline/src/fixLoop.ts` (`retestConfig` copies `flow`)
- Modify: `orchestrator/fix-loop.ts:90`, `orchestrator/cli.ts:41`
- Modify: `apps/dashboard/lib/runs.ts:159,193,245`, `apps/dashboard/lib/orchestrator.ts` inline path if it calls `validateRequest`
- Test: `packages/pipeline/src/daemon.test.ts`, `packages/pipeline/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `getFlow` (Task 2), `RunConfig.flow` (Task 1).
- Produces:
  - `flowOf(config: RunConfig): Flow | undefined` in `shared/flows.ts` — `config.flow ?? FLOWS[config.flowId]`. Every reader of a run's flow uses it.
  - `validateRequest(req: StartRunRequest, flow: Flow | undefined): void` — throws `Unknown flow "<id>"` when `flow` is undefined.
  - `analysisConfig(runId, req, now?, flow?)` sets `config.flow = flow`.

- [ ] **Step 1: Write failing tests** (daemon, `MemoryStore`, fake deps):
  - `putFlow(store, couponFlow)`, queue `{flowId: "coupon", autoFix:false}` → after `take`, `config.json` has `flow` deep-equal `couponFlow`.
  - Then `putFlow(store, {...couponFlow, goal: "changed"})` → the run's `config.json` `flow.goal` is unchanged, and a retest config produced by `retestConfig(analysis, …)` carries the original `flow`.
  - Queue `{flowId: "missing"}` → run ends `failed` with `error` `Unknown flow "missing"`.
- [ ] **Step 2: Run** `npx vitest run packages/pipeline` — Expected: FAIL.
- [ ] **Step 3: Implement**: `take()` loads `await getFlow(this.store, req.flowId)` and passes it to `validateRequest`/`analysisConfig`; `startPipeline` (CLI path) uses `FLOWS[req.flowId]`. Replace each `FLOWS[config.flowId]` listed above with `flowOf(config)`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Runs snapshot their flow in config.json"`

### Task 4: Pipeline history and the awaiting-decision stop

**Files:**
- Modify: `packages/pipeline/src/pipeline.ts` (`runPipeline`, `ORDER`, `set`)
- Test: `packages/pipeline/src/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - Every `set()` appends `{phase, at, message}` to `status.history` (skipped when phase and message are unchanged, same as today's early return).
  - `ORDER` = `["analyzing","fixing","waiting-preview","retesting","collecting","comparing","awaiting-decision","done"]`.
  - After the fix loop: if the last attempt's status is `ready` or `not-proven`, the run ends in `awaiting-decision` with message `Improved: PR #<n> ready, awaiting your decision` / `Not proven: PR #<n> labelled not-proven, awaiting your decision` (rehearsal: `(rehearsal)` in place of `PR #<n>`). `runPipeline` resolves there. Other statuses end `done` as today.
  - `export const PARKED = new Set<RunPhase>(["awaiting-decision"])`.

- [ ] **Step 1: Write failing tests** (existing fake-deps harness in `pipeline.test.ts`):
  - autoFix run with a fake fix loop returning `ready` → final `status.phase === "awaiting-decision"`, `status.history.map(h => h.phase)` equals `["analyzing","fixing","retesting","collecting","comparing","awaiting-decision"]` (plus `waiting-preview` when the watcher sees `draft`; assert with `toEqual(expect.arrayContaining(...))` and order via indices).
  - fix loop returning `not-proven` → `awaiting-decision`, message contains `"not-proven"`.
  - `autoFix:false` → `done`, history `["analyzing","done"]`.
- [ ] **Step 2: Run** `npx vitest run packages/pipeline/src/pipeline.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Pipeline: phase history; fixed runs park in awaiting-decision"`

### Task 5: Fix chosen findings; decision hook in both fix loops

**Files:**
- Modify: `packages/pipeline/src/fixLoop.ts` (`FixLoopOptions.findingIds`, `ApplyDecision`, `realApplyDecision`)
- Modify: `packages/pipeline/src/fakeFix.ts` (honor `findingIds`, write fixture diff, `fakeApplyDecision`)
- Modify: `packages/pipeline/src/pipeline.ts` (`RunOptions.findingIds` passed through; `PipelineDeps.applyDecision`; `buildDeps` wires fake/real)
- Modify: `orchestrator/fix-loop.ts` (honor `findingIds`; save PR diff; export `applyDecision`)
- Modify: `orchestrator/pr.ts` (`finalizePr` stops closing; `mergePr`, `closePr`, `prDiff`)
- Test: `packages/pipeline/src/pipeline.test.ts` (fake loop), `orchestrator/pr.test.ts`, `orchestrator/fix-loop.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `KEYS.prDiff` path shape (`fix/pr.diff` inside the run folder).
- Produces:
  - `FixLoopOptions.findingIds?: string[]` — when set, the loop fixes exactly these (order kept), no re-ranking, no trap mapping; unknown ids throw `Unknown finding "<id>"`.
  - `export type ApplyDecision = (o: { runsDir: string; runId: string; request: DecisionRequest; log: (l: string) => void }) => Promise<FixAttempt>` — updates the last attempt in `fix.json` (`status` → `merged`/`rejected`, `decision` filled) and returns it.
  - `realApplyDecision(modulePath?): ApplyDecision` — same guarded dynamic import as `realFixLoop`, calls the module's `applyDecision`.
  - `fakeApplyDecision: ApplyDecision` — no GitHub; `decision.rehearsal = true`.
  - `PipelineDeps.applyDecision: ApplyDecision`.
  - `RunOptions.findingIds?: string[]` — `runPipeline` passes it to the fix loop as `FixLoopOptions.findingIds`.
  - `orchestrator/pr.ts`: `mergePr(repo: string, prNumber: number, ghImpl?: Gh): Promise<string>` (returns merge commit sha via `gh pr view <n> --json mergeCommit -q .mergeCommit.oid`), `closePr(repo, prNumber, reason?: string, ghImpl?): Promise<void>`, `prDiff(repo, prNumber, ghImpl?): Promise<string>`.
  - `orchestrator/fix-loop.ts`: `export const applyDecision: ApplyDecision`.

- [ ] **Step 1: Write failing tests**:
  - `pr.test.ts`: `finalizePr` with `improved:false` records calls `pr comment`, `label create`, `pr edit --add-label not-proven` and **no** `pr close`. `mergePr("FrissA/demo-ecommerce", 12, rec)` records `["pr","merge","12","--repo","FrissA/demo-ecommerce","--squash","--delete-branch"]` and returns the stubbed oid. `closePr(repo, 12, "too risky", rec)` records a `pr comment` with body containing `too risky` then `pr close 12`; with no reason, only `pr close`.
  - `fix-loop.test.ts`: with `findingIds: ["f3","f1"]` the stub coding agent receives findings `[f3, f1]`; after the PR opens, `runs/<id>/fix/pr.diff` contains the stubbed `gh pr diff` output; `findingIds: ["nope"]` rejects `Unknown finding "nope"`.
  - `pipeline.test.ts` (fake loop): `findingIds: ["<id of a low finding>"]` → `fix.json` `attempts[0].findingIds` equals exactly that; `fix/pr.diff` exists. `fakeApplyDecision` accept → attempt `status:"merged"`, `decision.rehearsal:true`; reject with reason → `status:"rejected"`, `decision.reason` kept.
- [ ] **Step 2: Run** `npx vitest run orchestrator packages/pipeline` — Expected: FAIL.
- [ ] **Step 3: Implement.** P1's `applyDecision` reads `fix.json`, takes the last attempt's `prNumber`; accept → `mergePr`, reject → `closePr`; writes `fix.json`. `topFindings` is skipped when `findingIds` is set. The fixture diff in `fakeFix.ts` is a short unified diff touching `src/app/checkout/page.tsx` that names the targeted findings in a comment line.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Fix loops: chosen findings, saved PR diff, merge/close on decision; finalizePr no longer closes"` — mention in the PR that this touches P1's `orchestrator/` and needs its owner's review.

### Task 6: Daemon picks up fix and decision requests

**Files:**
- Modify: `packages/pipeline/src/daemon.ts` (`#tick`, `recover`, new `takeFix`, `applyDecisionRequest`)
- Modify: `packages/pipeline/src/pipeline.ts` (export `resumeFix(runId, opts, deps)`: like `runPipeline` from `fixing` onward on an analysis run whose `metrics.json`/`findings.json` exist)
- Test: `packages/pipeline/src/daemon.test.ts`

**Interfaces:**
- Consumes: `FixRequest`, `DecisionRequest`, `KEYS.fixRequest`, `KEYS.decision` (Task 1); `PARKED` (Task 4); `ApplyDecision`, `RunOptions.findingIds` (Task 5).
- Produces:
  - `resumeFix(runId: string, opts: RunOptions, deps: PipelineDeps): Promise<RunStatus>` — never rejects; same phase/history semantics as `runPipeline`.
  - Daemon behavior: each tick, for each run dir in the store with `fix-request.json` and no active entry → if slot free, allocate seeds as `take()` does, delete the request, start `resumeFix` as an active run. For each run with `decision.json` whose status is `awaiting-decision` → call `deps.applyDecision`; on success set phase `done` with message `Merged PR #<n> (<sha7>)` / `Rejected: PR #<n> closed` / rehearsal equivalents, and delete `decision.json`; on error keep `awaiting-decision`, set `status.error`, delete `decision.json`. Decisions do not count against `maxConcurrent`.
  - `recover()` skips runs in `PARKED`.

- [ ] **Step 1: Write failing tests** (`MemoryStore`, fake deps, existing helpers):
  - Analysis run `done` + `fix-request.json {findingIds:["f2"]}` → after ticks, phase reaches `awaiting-decision`, `fix.json.attempts[0].findingIds` `["f2"]`, `fix-request.json` gone, and `o.active.size === 0` after it parks.
  - While parked, a queued run starts with `maxConcurrent: 1` (the parked run holds no slot).
  - `decision.json {decision:"accept"}` → phase `done`, `fix.json` last attempt `merged`, `decision.json` gone; `applyDecision` called once even across 3 ticks.
  - `applyDecision` throwing `"merge conflict"` → phase stays `awaiting-decision`, `status.error === "merge conflict"`, `decision.json` gone.
  - `recover()` on a store with a run in `awaiting-decision` → still `awaiting-decision`.
  - `decision.json` on a run that is `done` → ignored and deleted, status unchanged.
- [ ] **Step 2: Run** `npx vitest run packages/pipeline/src/daemon.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Discover candidates with `store.list("runs/")` filtered to `*/fix-request.json` and `*/decision.json` (one list per tick; Blobs list is cheap). Mirror the run after each status change (`#sync`).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Daemon: fix requests on finished analyses, decisions on parked runs"`

### Task 7: Dashboard API — bearer auth, flows, fix, decision

**Files:**
- Modify: `apps/dashboard/lib/auth.ts` (`gate` signature), `apps/dashboard/proxy.ts`
- Modify: `apps/dashboard/lib/validate.ts` (`parseStartRunRequest` async, checks store flows)
- Modify: `apps/dashboard/lib/control.ts` (`requestFix`, `requestDecision`)
- Create: `apps/dashboard/app/api/flows/route.ts` (GET), `apps/dashboard/app/api/flows/[id]/route.ts` (GET, PUT), `apps/dashboard/app/api/flows/validate/route.ts` (POST), `apps/dashboard/app/api/runs/[id]/fix/route.ts` (POST), `apps/dashboard/app/api/runs/[id]/decision/route.ts` (POST), `apps/dashboard/app/api/personas/route.ts` (GET)
- Modify: `apps/dashboard/lib/runs.ts` (`runFileKey` allows `fix/pr.diff` with `text/x-diff`)
- Modify: `apps/dashboard/.env.example`, `.env.example` (`DASHBOARD_API_TOKEN=`)
- Test: `apps/dashboard/lib/auth.test.ts`, `apps/dashboard/lib/api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`validateFlow`, `flowHash`, `diffFlows`, `listFlows`, `getFlow`, `putFlow`, request types, `KEYS`).
- Produces (HTTP, all JSON, errors as `errorJson`):
  - `gate(path, cookie, env, authorization?: string)` → `"allow"` when `env.DASHBOARD_API_TOKEN` is set, path starts with `/api/`, and `authorization === "Bearer " + token` (`safeEqual`).
  - `GET /api/flows` → `Flow[]`. `GET /api/flows/:id` → `Flow` | 404.
  - `POST /api/flows/validate` body `{flow, baseFlowId?}` → `200 {ok:true, flow, draftHash, changes: string[], isNew: boolean}` | `200 {ok:false, missing, errors}`.
  - `PUT /api/flows/:id` body `{flow, draftHash}` → 400 if `flow.id !== :id` or invalid; 409 `"Flow changed since it was reviewed"` if `flowHash(flow) !== draftHash`; 200 `{flow}`.
  - `GET /api/personas` → `{id, name, oneLiner, segmentId, control}[]` from `PERSONAS`/`SEGMENTS`.
  - `POST /api/runs/:id/fix` body `{findingIds?, seedsPerPersona?}` → 404 unknown run; 409 unless `config.kind==="analysis"`, phase `done`, no `fix.json`, no `fix-request.json`; 400 `Unknown finding "<id>"`; 202 `{ok:true, findingIds}` (resolved default: top 3 by `rankFindings` when omitted).
  - `POST /api/runs/:id/decision` body `{decision, reason?, override?}` → 409 unless phase `awaiting-decision`; 409 `"A decision is already pending"` if `decision.json` exists; 409 `"Fix not proven: pass override to accept anyway"` when accepting a `not-proven` attempt without `override`; 202 `{ok:true}`.
  - `GET /api/runs/:id/files/fix/pr.diff` serves the diff.

- [ ] **Step 1: Write failing tests**:
  - `auth.test.ts`: with `DASHBOARD_PASSWORD` and `DASHBOARD_API_TOKEN="t0k"`, `gate("/api/runs", undefined, env, "Bearer t0k")` → `"allow"`; `"Bearer nope"` → `"unauthorized"`; `gate("/runs/x", undefined, env, "Bearer t0k")` → `"login"` (token only opens the API); token unset → bearer ignored.
  - `api.test.ts` (MemoryStore): validate → put → get round trip for a new `coupon` flow; PUT with stale `draftHash` → 409; POST `/api/runs` with `flowId:"coupon"` now 201 and unknown flow 400.
  - fix route: on a seeded `done` analysis with findings `f1,f2` → 202 and `fix-request.json` `findingIds:["f1"]` when asked for `["f1"]`; second call → 409; `["zzz"]` → 400.
  - decision route: seeded `awaiting-decision` + `not-proven` attempt → accept without override 409, with override 202 and `decision.json` written; second POST 409; on `done` run → 409.
- [ ] **Step 2: Run** `npx vitest run apps/dashboard` — Expected: FAIL.
- [ ] **Step 3: Implement** routes following `cancel/route.ts` (`touchOrchestrator`, `readBody`, `json`/`errorJson`). `proxy.ts` passes `req.headers.get("authorization") ?? undefined` to `gate`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Dashboard API: bearer token, flows, fix requests, decisions"`

### Task 8: Dashboard UI parity

**Files:**
- Modify: `apps/dashboard/components/run/fix-panel.tsx` (Accept / Reject when `awaiting-decision`; merged/rejected states)
- Modify: `apps/dashboard/components/run/phase-stepper.tsx` (`awaiting-decision` step)
- Create: `apps/dashboard/app/flows/[id]/page.tsx` (read-only flow page), link from run page header
- Modify: `apps/dashboard/app/runs/new/new-run-form.tsx` (flow list from `GET /api/flows`)
- Test: `apps/dashboard/lib/derive.test.ts` if derive logic changes; otherwise manual check below.

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: `/flows/<id>` page (link target used by the MCP).

- [ ] **Step 1: Implement** Accept (confirm dialog: "Merge PR #n into production main?") and Reject (optional reason textarea) calling `POST /api/runs/:id/decision`; on not-proven, Accept reads "Accept anyway" and sends `override:true`. Flow page shows goal, start URL, success rule, numbered steps with 🔒 on required, required fields — same order the MCP card uses.
- [ ] **Step 2: Verify** with `npm run dashboard`, `FIX_LOOP=fake`: start an analysis on `buy-tshirt`, POST `/api/runs/<id>/fix`, wait for `awaiting-decision`, click Reject with a reason → phase `done`, fix panel shows "Rejected (rehearsal)" and the reason. Open `/flows/buy-tshirt`.
- [ ] **Step 3: Run** `npm run typecheck` — Expected: PASS.
- [ ] **Step 4: Commit** `git commit -m "Dashboard: accept/reject, awaiting-decision step, flow page"`

### Task 9: MCP server

**Files:**
- Create: `apps/mcp/package.json` (`@frictionswarm/mcp`, `"type":"module"`, deps `@frictionswarm/shared`, `@modelcontextprotocol/sdk`, `zod`; script `"start": "tsx src/index.ts"`)
- Create: `apps/mcp/src/client.ts`, `apps/mcp/src/format.ts`, `apps/mcp/src/tools.ts`, `apps/mcp/src/index.ts`
- Test: `apps/mcp/src/format.test.ts`, `apps/mcp/src/tools.test.ts`

**Interfaces:**
- Consumes: Task 7 HTTP API; types only from `@frictionswarm/shared` and `apps/dashboard/lib/types.ts` (`RunDetail`) — type imports, no runtime code.
- Produces:
  - `class ApiClient { constructor(o: { baseUrl: string; token?: string; fetch?: typeof fetch }); get<T>(path): Promise<T>; post<T>(path, body?): Promise<T> }` — throws `ApiError { status: number; message: string }` with the route's `error` text; network failure → message `Can't reach the dashboard at <baseUrl>`.
  - `format.ts`:
    - `flowCard(flow: Flow, changes?: string[]): string`
    - `analysisReport(run: RunDetail, links: Links): string` — segment table (step, conversion %, drop-off %, N), top findings (id, severity, step, title, sessions/users, `sinceRelease.name`, ≤3 replay links when `replayBase`).
    - `story(run: RunDetail, swarm?: SwarmTopology): string[]` — one line per `status.history` entry, then fix attempt lines (`PR #n opened (draft)`, `preview live (sha7)`), live `… re-test <done>/<total> agents done` while `retesting`.
    - `decisionPackage(run: RunDetail, diff: string | undefined, links: Links): string` — sections 1–7 of the spec, diff truncated at 300 lines with `… <k> more lines; files: a, b`.
    - `type Links = { dashboard: (path: string) => string }`.
  - `tools.ts`: `registerTools(server: McpServer, api: ApiClient, links: Links): void` registering exactly: `list_flows`, `get_flow`, `draft_flow`, `save_flow`, `list_personas`, `analyze_flow`, `start_fix`, `get_run`, `get_decision`, `accept_fix`, `reject_fix`, `cancel_run` (inputs as in the spec table). Each returns `{ content: [{type:"text", text: markdown}], structuredContent: json }`. `isError: true` on `ApiError`.
  - `index.ts`: reads `FS_API_URL` (default `http://localhost:3000`), `FS_API_TOKEN`; `StdioServerTransport`.

- [ ] **Step 1: Write failing tests**:
  - `format.test.ts` with fixtures built from `runs/fixture-baseline` shapes:
    - `flowCard(buyTshirt)` contains `"1. / → Home"`, `"🔒 Cart"`, `"Success: URL matches /checkout/success"` and lists `cardNumber`.
    - `story` for history `[analyzing, fixing, waiting-preview, retesting, awaiting-decision]` with attempt `prNumber:12, commitSha:"abc1234ff"` contains, in order, `"PR #12 opened (draft)"`, `"preview live (abc1234)"`, `"awaiting your decision"`.
    - `decisionPackage` contains `"before = real users"`, `"after = constrained persona agents"`, a row with `"Δ +"` and `"N "` for each comparison, `"Accept merges to production main; reject closes the PR."`; with a 400-line diff, output has ≤ 300 diff lines and `"… 100 more lines"`.
    - Rehearsal attempt (`prNumber: 0`) → package contains `"(rehearsal — no PR merged)"`.
    - `analysisReport` for a run whose segments all have N = 0 → `"No real-user sessions for this flow in the window"` and no funnel table.
  - `tools.test.ts` (fake `fetch`, `McpServer` + in-memory transport from the SDK or direct handler calls):
    - `draft_flow` with `{goal}` only → text lists the missing fields and no `draftHash`.
    - `save_flow` → PUT body includes the `draftHash` passed in; 409 → `isError` with `"Flow changed since it was reviewed"`.
    - `accept_fix` on a not-proven run without `override` → `isError` text `"Fix not proven: pass override to accept anyway"`.
    - `get_run` when `GET /api/control` reports a stale heartbeat → text starts with `"⚠ Orchestrator offline"`.
    - every successful reply contains a `http://localhost:3000/runs/` or `/flows/` link.
    - tool descriptions of `save_flow` and `accept_fix` contain `"Only after the user has seen"`.
- [ ] **Step 2: Run** `npx vitest run apps/mcp` — Expected: FAIL.
- [ ] **Step 3: Implement.** `analyze_flow` posts `/api/runs` `{flowId, window?, source?, autoFix:false}`, polls `GET /api/runs/:id` every 2 s up to 60 s; when not finished it replies with the run link and "follow with get_run". `get_decision` refuses (`isError`) unless phase is `awaiting-decision` (or `done` with a decision, which it shows read-only). `accept_fix`/`reject_fix` reply "Merge requested" / "Close requested" and tell Claude to follow with `get_run`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS. Add `apps/mcp` to root `tsconfig.json` include if needed.
- [ ] **Step 5: Smoke**: `npm run dashboard` (rehearsal), then `claude mcp add frictionswarm -e FS_API_URL=http://localhost:3000 -- npx tsx apps/mcp/src/index.ts`; in Claude Code: list flows, analyze `buy-tshirt`, start fix, follow, reject. Confirm the dashboard shows the same run and outcome.
- [ ] **Step 6: Commit** `git commit -m "MCP: Claude Code front door for flows, analysis, fixes and decisions"`

### Task 10: watch-run skill, SPEC and docs

**Files:**
- Create: `.claude/skills/watch-run/SKILL.md`
- Modify: `SPEC.md` (stories 16/17, "After re-test" bullet, phases, run folder files, `RunConfig.flow`, MCP section), `ARCHITECTURE.md` (MCP box → dashboard API), `README.md` (install + env: `DASHBOARD_API_TOKEN`, `FS_API_URL`, `FS_API_TOKEN`)

**Interfaces:**
- Consumes: tool names from Task 9.

- [ ] **Step 1: Write the skill**: name `watch-run`, description "Follow a FrictionSwarm run until it needs a decision". Body: call `get_run` every ~25 s; post one short line only when something changed; stop at `awaiting-decision` (then call `get_decision` and show it in full, ask accept/reject), `done` or `failed`; never call `accept_fix` without an explicit yes; include the dashboard link once at the start.
- [ ] **Step 2: Update SPEC/ARCHITECTURE/README** per the spec's "SPEC.md is updated" bullet.
- [ ] **Step 3: Verify** `/watch-run <runId>` in Claude Code against a rehearsal run reaches `awaiting-decision` and shows the package.
- [ ] **Step 4: Commit** `git commit -m "watch-run skill; SPEC and docs for the decision gate and MCP"`
