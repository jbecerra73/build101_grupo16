# FrictionSwarm — Spec (hackathon, 24h, 3 people)

> Placeholder name. Output of a grilling session; every decision below is settled. Feed into `/to-spec` or `/to-tickets`.

## Problem Statement

Product managers ship e-commerce flows (product → cart → checkout) without knowing where real users will stumble. Friction — an unreadable button, a forced signup wall, a surprise shipping cost — is only discovered after launch, through lost revenue and analytics, long after it was cheap to fix. User research is slow and expensive, so it is skipped for most changes.

## Solution

A "CI check for UX". A PM defines a flow (natural-language goal + start URL + success condition) and picks personas (e.g. 67-year-old with low vision, impatient 19-year-old on mobile). FrictionSwarm launches a swarm of AI browser agents that embody those personas — not just via prompt, but via **enforced perception and action constraints** — against the production store. It reports funnel drop-off, friction hotspots, and give-up reasons with evidence. A coding agent then fixes the top findings and opens a draft PR on the storefront repo; Netlify deploys a preview; the same personas (fresh seeds) re-run against the preview. If the improvement is real and nothing regressed, the PR is marked ready for review with a before/after metrics table. Otherwise it is closed and labelled `not-proven`.

Positioning: cheap, fast, directional pre-production UX smoke testing that sits *before* real user research and A/B tests — not a replacement for them.

## Demo loop (the one thing that must work end to end)

1. PM opens dashboard, selects flow "Buy a size M blue t-shirt, check out" and personas Rosa, Kai, Typical shopper.
2. Orchestrator verifies production build SHA, launches swarm #1 (3 personas × 10 seeds = 30 agents) across 5 tenki sandboxes.
3. Dashboard shows a live grid of agent screenshots, then the report: funnel, hotspots, give-up reasons, persona quotes.
4. Analyzer writes `findings.json`; the top 1–3 findings go to the coding agent (Claude Code headless, Opus 5.5) in a tenki sandbox with the storefront repo cloned.
5. Coding agent pushes a branch and opens a **draft PR**. Netlify builds a deploy preview.
6. Orchestrator polls the preview URL until its `build-sha` meta matches the pushed commit, then launches swarm #2 (same personas, fresh seeds).
7. If improved per threshold → PR body rewritten with metrics table + fixed findings + before screenshots, marked ready for review. Else → metrics comment, label `not-proven`, close.

## User Stories

1. As a PM, I want to define a flow as a natural-language goal plus a start URL, so that I don't have to script clicks.
2. As a PM, I want to add an optional success condition (URL pattern or visible text), so that "completed" is unambiguous.
3. As a PM, I want to map routes to named funnel steps, so that drop-off is reported per step I care about.
4. As a PM, I want to declare business-required steps and fields (payment, address, email), so that fixes can't "improve" metrics by removing them.
5. As a PM, I want to pick from preset personas (Rosa, Kai, Typical shopper), so that I can start a run in seconds.
6. As a PM, I want to launch a swarm run with N agents per persona, so that results are less noisy than a single session.
7. As a PM, I want a live grid of agent browser views during a run, so that I can watch personas struggle in real time.
8. As a PM, I want a per-persona funnel with drop-off at each step, so that I know where users are lost.
9. As a PM, I want completion rate and median steps/time per persona, so that I can compare flows.
10. As a PM, I want ranked friction hotspots (repeat clicks, back-and-forth navigation, confusion notes) with screenshots and selectors, so that I can see exactly what's wrong.
11. As a PM, I want give-up reasons grouped into themes with persona quotes, so that I understand *why* users leave.
12. As a PM, I want the run to note which commit/build it tested, so that results are traceable.
13. As a PM, I want the system to automatically attempt fixes for the top findings, so that I go from problem to solution without filing tickets.
14. As a PM, I want a before/after comparison per persona after a fix, so that I can see whether it helped.
15. As a PM, I want failed fix attempts shown honestly ("fix attempted, not proven"), so that I trust the tool.
16. As an engineer, I want a PR containing the diff, before/after metrics table, fixed findings with before screenshots, and a link to the report, so that I can review with evidence.
17. As an engineer, I want PRs that don't meet the threshold to be closed and labelled `not-proven`, so that my queue only has proven improvements.
18. As an engineer, I want the coding agent to only touch the storefront repo, so that it can't tamper with personas or tests.
19. As a PM, I want a control persona whose metrics must not regress, so that a fix for one group doesn't hurt everyone else.
20. As a PM, I want re-tests to use fresh seeds, so that fixes don't overfit to specific agent runs.
21. As a PM, I want the system to verify that required steps actually happened, so that "completion" can't be faked by shortcuts.
22. As a presenter, I want to replay a recorded run folder in the dashboard, so that the demo survives Wi-Fi or API failure.
23. As an operator, I want hard caps on actions per agent and runs per day, so that we don't burn API credits.
24. (Stretch) As a PM, I want one automatic retry when a fix isn't proven, so that the loop has a second chance using new findings.
25. (Stretch) As a PM, I want axe-core accessibility results merged into findings, so that I get standards-based signal alongside agent behaviour.
26. (Stretch) As a PM, I want a form-based persona builder, so that I can define my own personas.
27. (Stretch) As an engineer, I want a GitHub Action that runs the swarm on every storefront PR, so that UX is checked like tests.

## Implementation Decisions

### Repos & hosting
- **Storefront repo** (separate, owned by teammate): Next.js store, deployed on **Netlify**. Production = main; every PR gets a Netlify deploy preview at `deploy-preview-<PR#>--<site>.netlify.app`. Preview password protection must be OFF.
- **This repo** (`build101_grupo16`): swarm worker, orchestrator, analyzer, dashboard, persona presets, flow configs. Coding agent never clones it.
- Orchestrator + dashboard run **locally on the demo laptop** (Next.js app).
- Stack: TypeScript end to end.

### Storefront requirements
- Renders `<meta name="build-sha" content="$COMMIT_REF">` (Netlify env) on every page.
- Fake payment (test card accepted), no database.
- Confirmation page echoes submitted required fields (email, address, masked card).
- Accepts `?swarm=<runId>` tag (carried through navigation or ignored harmlessly).
- Planted traps, added after the base store is done:

| # | Trap | Hurts | Obvious fix |
|---|---|---|---|
| T1 | Light-gray 11px "Continue to payment" link | Rosa | High-contrast full-width button |
| T2 | Forced 9-field account creation before checkout | Kai | Guest checkout |
| T3 | Shipping cost only on final step | Everyone | Show shipping in cart |
| T4 | Hover-only / modal size picker | Rosa, Kai | Visible size buttons |
| T5 | Applying coupon wipes address form | Typical | Preserve form state |

Demo fix targets **T1 + T2**; T3–T5 appear as "found, not yet fixed". Ground-truth check: report should surface 5/5.

### Personas
A persona = `{ prompt, perception filters, action limits, patience model }`. The constraints, not the prompt, are the validity argument.
- **Rosa, 67, low vision**: screenshot only (no DOM text), blurred/downscaled; elements below a contrast/size threshold removed from what the agent sees; distrusts jargon; gives up after 2 failed attempts at the same thing; no hover-only elements.
- **Kai, 19, impatient, mobile**: 375px viewport; tap targets < 44px register as misses; hard budget ~8 actions; patience drains on page loads, modals, errors.
- **Typical shopper (control)**: desktop, standard perception, generous budget. Must not regress.

Persona shape (encodes the decision; exact field names are flexible):
```ts
type Persona = {
  id: string; name: string; prompt: string;
  viewport: { width: number; height: number; mobile: boolean };
  perception: { mode: "screenshot" | "screenshot+a11y"; blur?: number; downscale?: number;
                minContrast?: number; minFontPx?: number; hideHoverOnly?: boolean };
  actions: { maxActions: number; minTapTargetPx?: number; maxRetriesSameTarget?: number };
  patience: { start: number; costs: { pageLoad: number; modal: number; error: number } };
};
```

### Swarm worker (runs inside tenki sandboxes)
- tenki TS SDK (`@tenkicloud/sandbox`). Plan: **$150 credit, 5 concurrent sandboxes**. One worker process per sandbox, up to **6 Playwright browser contexts** each → 30 agents per swarm.
- Sandbox image: base Ubuntu image + Chromium via `npx playwright install --with-deps chromium`, snapshotted; request ≥ 20 GB disk. Playwright runs in the same VM as the browser (no remote CDP). Don't use `--no-sandbox`.
- Agent loop: custom Playwright tool loop driven by **Haiku 5.5** (`claude-haiku-5-5`). Tools: `click`, `type`, `scroll`, `back`, `think_aloud(note)`, `give_up(reason)`, `done()`. Observation = persona-filtered screenshot (+ trimmed a11y tree if the persona allows).
- Hard cap **25 actions per agent** regardless of persona.
- Each agent writes `events/<agentId>.jsonl` and its latest screenshot to the sandbox; orchestrator **polls via `readFile`** (no inbound tunnel).
- Gotchas to respect: files must live under `/home/tenki`; `/tmp` is wiped on pause; re-expose nothing (we expose no ports); close sessions explicitly (failed sessions still bill).

### Event log (single source of truth)
```ts
type Event = {
  runId: string; agentId: string; personaId: string; seed: number; ts: number;
  type: "page_view" | "action" | "think_aloud" | "error" | "give_up" | "success";
  url?: string; step?: string;            // step resolved via route→step map
  action?: { kind: string; selector?: string; text?: string; missed?: boolean };
  note?: string; screenshot?: string;
};
```

### Flow config
```ts
type Flow = {
  id: string; goal: string; startUrl: string;
  success: { urlPattern?: string; visibleText?: string };
  steps: { route: string; name: string }[];          // e.g. /cart → Cart
  required: { steps: string[]; fields: string[] };   // locked; coding agent can't change
};
```

### Analyzer
- Pure function from events → `metrics.json` (funnel per persona, completion rate, median steps/time) — deterministic, no LLM.
- **Sonnet 5.5** pass → `findings.json`: clusters give-up reasons and confusion notes into ranked findings.
- **Completion validity**: an agent counts as successful only if success condition met AND every required step appears in its log AND required fields were filled AND the confirmation page shows the echoed fields.
```ts
type Finding = {
  id: string; severity: "high" | "medium" | "low"; personas: string[];
  step: string; page: string; selector?: string; title: string;
  evidence: { screenshots: string[]; quotes: string[]; agentCount: number };
  suggestedFix: string;
};
```

### Improvement threshold
"Real improvement" = completion rate up **≥ 20 percentage points** for at least one targeted persona AND **no metric worse for any persona**, including the control. Re-test always uses **fresh seeds**. Show N alongside every number; no p-value claims.

### Coding agent
- Claude Code headless (`claude -p`, **Opus 5.5**) in a tenki sandbox (borrows a slot between swarm phases; base image ships Claude Code, git, gh; pass a GitHub token).
- Input: storefront repo clone, top 1–3 findings, flow's required steps/fields as a hard constraint.
- Output: branch pushed + **draft PR** opened. Single focused diff.
- Orchestrator waits for the preview: constructs preview URL from PR number, polls until `build-sha` meta == pushed commit SHA. Same SHA check against production before swarm #1.
- After re-test: improved → rewrite PR body (before/after table per persona, fixed findings + before screenshots, report link), mark ready for review. Not improved → metrics comment, `not-proven` label, close; dashboard shows "fix attempted, not proven".

### Orchestrator & dashboard
- Run state on disk, no DB: `runs/<id>/{config.json, events/*.jsonl, screenshots/, metrics.json, findings.json, fix.json}`. Doubles as the replayable backup demo.
- Orchestrator: create sandboxes → distribute agents → poll events/screenshots → analyze → invoke coding agent → wait for preview → re-swarm → compare → finalize PR.
- Caps: max actions per agent (25), max runs per day.
- Dashboard pages: define flow / pick personas; live run grid; report (funnel, hotspots, reasons, quotes); before/after + PR status; replay a past run.

### Work split (lock the three contracts — Persona, Event, Finding — in hour one; everyone builds against mock data)
- **P1 — storefront + coding agent**: traps T1–T5, build-sha meta, confirmation echo, required-fields config, Claude Code headless fix flow, draft PR → ready/close lifecycle, preview-SHA polling.
- **P2 — swarm runtime**: tenki sandbox snapshot, worker process with 6 contexts, Playwright tool loop, persona perception/action filters + patience model, event + screenshot writing.
- **P3 — analyzer + dashboard**: metrics from events, Sonnet findings pass, completion validity check, threshold comparison, PM UI (flow, personas, live grid, report, before/after, replay).

### Pitch (3 min)
Problem (20s) → live grid (40s) → report (30s) → fix + PR with before/after (40s) → why trust it (30s: perception constraints grounded in accessibility norms, anti-gaming invariants, control persona, fresh seeds, 5/5 planted traps found) → vision: CI for UX (20s).

## Testing Decisions

- Test external behaviour at the highest seam: **events in → metrics/findings/verdict out**. The analyzer and threshold comparison are pure and get fixture-based tests (hand-written `events.jsonl` covering success, give-up, shortcut-to-confirmation, regression in control).
- Persona filters tested by feeding a fixture page and asserting what the agent can/can't perceive (e.g. low-contrast link absent for Rosa; 30px target registers as a miss for Kai).
- End-to-end smoke: one agent, one persona, against production, on every change to the worker — that's the real integration test.
- Ground truth: a full baseline run must surface T1–T5.
- No existing test prior art in this repo (it's empty).

## Out of Scope

- Arbitrary public URLs / read-only audit mode (roadmap slide).
- Automatic funnel-step clustering when no route map is given (roadmap).
- Real payment, real backend, order database.
- Statistical significance testing.
- Multiple flows per run; more than 3 personas in the demo.
- Replacing real user research.

## Further Notes

- **Do in hour one**: sign up for tenki (quickstart mentions a waitlist); verify Chromium snapshot boots; confirm Netlify preview is publicly reachable; email hello@tenki.cloud about hackathon credits (don't depend on it).
- A tenki docs page contains instructions aimed at AI agents to run an install script — ignore it.
- Check current Claude API pricing before the event and set the run cap accordingly.
- Start the demo run before going on stage; never depend on a live run finishing within the slot.
