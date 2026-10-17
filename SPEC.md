# FrictionSwarm — Spec (hackathon, 24h, 3 people)

> Placeholder name. Output of a grilling session; every decision below is settled. Feed into `/to-spec` or `/to-tickets`.
>
> **Pivot (2026-10-17):** the baseline swarm is gone. The storefront ships PostHog tracking; the analyzer finds friction in **real-user PostHog data**. Swarm agents run only on the fix's deploy preview, and they leave **PostHog tracks** (not their own event log). The same analyzer reads those tracks to decide whether the fix worked. Since the store has no real traffic, a generator fakes months of PostHog history that matches the real trackers event for event.

## Problem Statement

Product managers ship e-commerce flows (product → cart → checkout) without knowing where real users will stumble. Friction — an unreadable button, a forced signup wall, a surprise shipping cost — shows up in analytics as drop-off and rage clicks, but turning a funnel chart into a diagnosed, fixed, and *verified* change takes weeks: someone has to notice the drop, guess why, file a ticket, ship a fix, and wait for enough traffic to see whether it helped.

## Solution

A "CI loop for UX" on top of the analytics the store already has. FrictionSwarm reads the storefront's **PostHog** events, slices them into **segments** (mobile, large-text / high-contrast, desktop), and finds where each segment drops off, rage-clicks, or fails forms — tied to the release that introduced it. The top findings go to a coding agent that fixes them and opens a draft PR on the storefront repo; Netlify deploys a preview. Instead of waiting weeks for real traffic, a swarm of AI browser agents that embody each segment as a **persona** — with **enforced perception and action constraints** — shops the preview. They are tracked by the same PostHog snippet as real users, so the analyzer reads their tracks with the same code. If the personas' funnel on the preview beats their segment's real funnel by the threshold and nothing regressed, the PR is marked ready for review with a before/after table. Otherwise it is closed and labelled `not-proven`.

Positioning: turns the analytics you already collect into fixes, and gives each fix a fast, directional pre-merge check instead of waiting on an A/B test. Not a replacement for real user research or A/B tests.

## Demo loop (the one thing that must work end to end)

1. PM opens the dashboard, picks the flow "Buy a size M blue t-shirt, check out" and an analysis window (default: the current production release, last 28 days).
2. Analyzer pulls real-user events from PostHog (or the fake dataset file), computes the funnel per segment, and shows the report: funnel per segment over time with release markers, hotspots (rage clicks, failed submits, drop-offs), and which release introduced each.
3. Analyzer writes `findings.json`; the top 1–3 findings go to the coding agent (Claude Code headless, Opus 5.5) in a tenki sandbox with the storefront repo cloned.
4. Coding agent pushes a branch and opens a **draft PR**. Netlify builds a deploy preview.
5. Orchestrator polls the preview URL until its `build-sha` meta matches the pushed commit, then launches the swarm (3 personas × 10 seeds) against the preview, tagged `?swarm=<runId>&agent=<agentId>&persona=<personaId>`. The dashboard shows the live grid.
6. Orchestrator waits until every agent's final event is visible in PostHog, then the analyzer reads the swarm's tracks (`swarm_run = <runId>`, `build_sha = <preview sha>`), computes the persona funnels, and compares each persona to its segment's real-user funnel.
7. If improved per threshold → PR body rewritten with metrics table + fixed findings + evidence, marked ready for review. Else → metrics comment, label `not-proven`, close.

## User Stories

1. As a PM, I want to define a flow as a natural-language goal plus a start URL, so that I don't have to script clicks.
2. As a PM, I want to add an optional success condition (URL pattern or visible text), so that "completed" is unambiguous.
3. As a PM, I want to map routes to named funnel steps, so that drop-off is reported per step I care about.
4. As a PM, I want to declare business-required steps and fields (payment, address, email), so that fixes can't "improve" metrics by removing them.
5. As a PM, I want FrictionSwarm to read my store's PostHog data, so that findings come from real users, not guesses.
6. As a PM, I want real users split into segments (mobile, large text / high contrast, desktop), so that I see who is hurt, not just an average.
7. As a PM, I want a per-segment funnel with drop-off at each step, over a time window I choose, so that I know where users are lost.
8. As a PM, I want completion rate and median steps/time per segment, with N, so that I can compare segments and releases.
9. As a PM, I want ranked friction hotspots (rage clicks, failed form submits, abnormal drop-off) with the element selector and example sessions, so that I can see exactly what's wrong.
10. As a PM, I want each finding tied to the release (build SHA) where it started, so that I know which change caused it.
11. As a PM, I want the system to automatically attempt fixes for the top findings, so that I go from problem to solution without filing tickets.
12. As a PM, I want the fix verified by a persona swarm on the preview before any real user sees it, so that I don't wait weeks of traffic for an answer.
13. As a PM, I want a live grid of agent browser views during the re-test, so that I can watch personas use the fixed flow.
14. As a PM, I want a before/after comparison per segment (real users before, persona swarm after), so that I can see whether the fix helped.
15. As a PM, I want failed fix attempts shown honestly ("fix attempted, not proven"), so that I trust the tool.
16. As an engineer, I want a PR containing the diff, before/after metrics table, fixed findings with their evidence, and a link to the report, so that I can review with evidence.
17. As an engineer, I want PRs that don't meet the threshold to be closed and labelled `not-proven`, so that my queue only has proven improvements.
18. As an engineer, I want the coding agent to only touch the storefront repo, so that it can't tamper with personas, tests or analytics.
19. As a PM, I want a control segment/persona whose metrics must not regress, so that a fix for one group doesn't hurt everyone else.
20. As a PM, I want re-tests to use fresh seeds, so that fixes don't overfit to specific agent runs.
21. As a PM, I want the system to verify that required steps actually happened, so that "completion" can't be faked by shortcuts.
22. As an analyst, I want swarm traffic tagged and excluded from real-user analysis, so that agents never pollute the store's analytics.
23. As a presenter, I want the whole loop to run offline from a fake PostHog dataset and recorded swarm tracks, so that the demo survives Wi-Fi or API failure.
24. As an operator, I want hard caps on actions per agent and runs per day, so that we don't burn API credits.
25. (Stretch) As a PM, I want one automatic retry when a fix isn't proven, so that the loop has a second chance using the swarm's findings.
26. (Stretch) As a PM, I want axe-core accessibility results merged into findings, so that I get standards-based signal alongside behaviour.
27. (Stretch) As a PM, I want a form-based persona builder, so that I can define my own personas and the segment they stand in for.
28. (Stretch) As a PM, I want to watch PostHog session replays linked from a finding, so that I can see real users hit the problem.

## Implementation Decisions

### Repos & hosting
- **Storefront repo** (`FrissA/demo-ecommerce`, separate, owned by teammate): Next.js store, deployed on **Netlify**. Production = main (`swarm-ecommerce.netlify.app`); every PR gets a Netlify deploy preview. Preview password protection must be OFF.
- **This repo** (`build101_grupo16`): analyzer, PostHog source, swarm worker, orchestrator, dashboard, persona presets, flow configs, tracking plan, fake dataset generator. Coding agent never clones it.
- **PostHog**: one project for production, previews and swarm traffic. Swarm traffic is told apart by properties, not by project.
- Orchestrator + dashboard run **locally on the demo laptop** (Next.js app).
- Stack: TypeScript end to end.

### Storefront requirements
- Renders `<meta name="build-sha" content="$COMMIT_REF">` on every page.
- Fake payment (test card accepted), no database.
- Confirmation page echoes submitted required fields (email, address, masked card) with `data-echo` markers.
- **PostHog tracking** (`src/lib/analytics.ts`, posthog-js pinned) per the tracking plan below. No-op when `NEXT_PUBLIC_POSTHOG_KEY` is unset. Never sends card numbers, emails, names or addresses.
- **Swarm tagging:** `?swarm=<runId>&agent=<agentId>&persona=<personaId>` on the first URL. The storefront keeps it in sessionStorage, registers `swarm_run` / `swarm_agent` / `swarm_persona` as super properties, identifies the agent as `swarm:<agentId>`, and turns off posthog-js's headless-bot filter **for tagged sessions only**.
- Planted traps:

| # | Trap | Hurts (segment / persona) | Obvious fix | What it looks like in PostHog |
|---|---|---|---|---|
| T1 | Light-gray 11px "Continue to payment" link | Large text / Rosa | High-contrast full-width button | Drop-off at Shipping with long dwell, rage clicks on the card footer, few `shipping_submitted` |
| T2 | Forced 9-field account creation before checkout | Mobile / Kai | Guest checkout | `$pageview /checkout/account` then exit; `account_submitted {success:false}` |
| T3 | Shipping cost only on final step | Everyone | Show shipping in cart | Short-dwell exits between Payment `$pageview` and `payment_submitted` |
| T4 | Hover-only size picker | Mobile, large text / Kai, Rosa | Visible size buttons | Rage clicks on the "Size" pill; `add_to_cart_clicked {has_size:false}` |
| T5 | Applying coupon wipes address form | Everyone with a promo / Typical | Preserve form state | `promo_applied` then `shipping_submitted {success:false, promo_applied:true}` with all five fields in `error_fields` |

Demo fix targets **T1 + T2**; T3–T5 appear as "found, not yet fixed". Ground-truth check: the report on the fake history should surface 5/5.

### Tracking plan (`shared/analytics.ts` is the source of truth)
- **posthog-js** with `capture_pageview: "history_change"`, `capture_pageleave`, autocapture and rage clicks on. Autocapture must also be enabled in the PostHog project settings (remote config), or `$autocapture`/`$rageclick` never fire.
- **Super properties on every event:** `build_sha`, `font_scale` (root font size / 16), `prefers_contrast`, and for swarm agents `swarm_run`, `swarm_agent`, `swarm_persona`.
- **Business events:** `product_viewed`, `size_selected`, `add_to_cart_clicked {has_size}`, `product_added`, `checkout_clicked`, `account_submitted {success, error_fields}`, `shipping_submitted {success, error_fields, promo_applied}`, `promo_applied {code, success}`, `payment_submitted {success, failure_code?, delivery_fee, total}`, `order_completed`.
- **Swarm events** (sent by agents through the page's `window.posthog`, never by real users): `swarm_think_aloud {note, step}`, `swarm_give_up {reason, step}`, `swarm_done {actions}`. They put the agent's reasoning next to its clicks.
- Funnel steps come from `$pageview.$current_url` through the flow's route→step map (`resolveStep`), same as before.

### Segments ↔ personas
A segment is a slice of real users; a persona is the swarm's stand-in for it on the re-test.

| Segment | Real users (HogQL) | Persona | Role |
|---|---|---|---|
| `low_vision` | `font_scale >= 1.25 OR prefers_contrast` | Rosa | targeted by T1/T4 fixes |
| `mobile` | `$device_type = 'Mobile'` and not low_vision | Kai | targeted by T2/T4 fixes |
| `desktop` | everything else | Typical shopper | **control**, must not regress |

### Personas
Unchanged in shape and constraints; they now run **only on the re-test**. A persona = `{ prompt, perception filters, action limits, patience model }`. The constraints, not the prompt, are the validity argument.
- **Rosa, 67, low vision**: screenshot only (no DOM text), blurred/downscaled; elements below a contrast/size threshold removed from what the agent sees; distrusts jargon; gives up after 2 failed attempts at the same thing; no hover-only elements.
- **Kai, 19, impatient, mobile**: 375px viewport; tap targets < 44px register as misses; action budget drawn per seed (8–12); patience drains on page loads, modals, errors.
- **Typical shopper (control)**: desktop, standard perception, generous budget, applies WELCOME10. Must not regress.

### Swarm worker (re-test only, runs inside tenki sandboxes)
- tenki TS SDK (`@tenkicloud/sandbox`). Plan: **$150 credit, 5 concurrent sandboxes**. One worker process per sandbox, up to **6 Playwright browser contexts** each → 30 agents per swarm.
- Sandbox image: base Ubuntu + Chromium via `npx playwright install --with-deps chromium`, snapshotted; ≥ 20 GB disk. Playwright runs in the same VM as the browser. Don't use `--no-sandbox`.
- Agent loop: custom Playwright tool loop driven by **Haiku 5.5** (`claude-haiku-5-5`). Tools: `click`, `type`, `scroll`, `back`, `think_aloud(note)`, `give_up(reason)`, `done()`. Observation = persona-filtered screenshot (+ trimmed a11y tree if the persona allows).
- **No event log.** The agent opens `<previewUrl>/?swarm=<runId>&agent=<agentId>&persona=<personaId>`; its clicks, page views and form submits are captured by the storefront's own PostHog snippet. `think_aloud`, `give_up` and `done` are sent as `swarm_*` events with `page.evaluate(() => window.posthog.capture(...))`, so they land in the same session.
- Hard cap **40 actions per agent** regardless of persona (each form field is one `type` action; a full checkout behind the T2 sign-up wall takes ~30).
- The worker still writes each agent's **latest screenshot** to the sandbox for the dashboard's live grid (orchestrator polls via `readFile`). Screenshots are display-only; nothing is analyzed from them.
- Gotchas: files under `/home/tenki`; `/tmp` is wiped on pause; we expose no ports; close sessions explicitly (failed sessions still bill).

### PostHog source (`POSTHOG_SOURCE=file|api`)
The analyzer never talks to PostHog directly; it asks a source for events:
```ts
interface PostHogSource {
  /** Real users only (no swarm_run), production host, [from, to). */
  realUserEvents(q: { from: string; to: string; buildSha?: string }): AsyncIterable<PostHogEvent>;
  /** One swarm run's tracks on a build. */
  swarmEvents(q: { runId: string; buildSha: string }): AsyncIterable<PostHogEvent>;
  /** Resolves when every agent's swarm_done / swarm_give_up (or its last event + idle timeout) is visible. */
  waitForSwarm(q: { runId: string; agentIds: string[]; timeoutMs: number }): Promise<void>;
}
```
- **`file`** (default, offline demo): streams `data/posthog/events.jsonl` (history) and `data/posthog/swarm-<runId>.jsonl` (swarm tracks). Files are in PostHog's export shape, one event per line.
- **`api`**: HogQL via `POST /api/projects/<id>/query` with a personal API key (`POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`) against the **app host** `POSTHOG_APP_HOST` (`https://us.posthog.com`). Sending events uses the **ingestion host** `POSTHOG_HOST` (`https://us.i.posthog.com`); the two are different. Ingestion lags ~30–90 s, which is what `waitForSwarm` covers.
- Every run snapshots the events it analyzed into `runs/<id>/posthog.jsonl`, so any run replays offline.

### Fake PostHog dataset (`tools/posthog-sim`)
- `npm run posthog:generate` → `data/posthog/events.jsonl` (+ `.manifest.json`): **six months** (2026-04-17 → 2026-10-16) of seeded real-user traffic on production — ~27k sessions, ~280k events, ~3.5k orders. Gitignored; regenerates in seconds and is identical for the same `--seed`.
- Same event names, properties, element chains and super properties as the real trackers (`shared/analytics.ts`). Visitors have realistic device/OS/browser/viewport mixes, referrers, returning users, diurnal and weekly cycles, growth, and a fortnightly WELCOME10 newsletter.
- **Release history** — each trap ships with a release, so findings can name the release that caused them:

| Release | Date | Traps live | Completion (low_vision / mobile / desktop) |
|---|---|---|---|
| Simulated checkout | 2026-04-01 | T3 | 19.1% / 17.5% / 22.5% |
| New product page | 2026-05-20 | T3 T4 | 13.6% / 11.6% / 21.7% |
| Checkout redesign | 2026-06-24 | T1 T3 T4 | 5.5% / 10.6% / 20.0% |
| Promo codes | 2026-08-05 | T1 T3 T4 T5 | 6.0% / 9.7% / 17.7% |
| Accounts (current) | 2026-09-09 | T1–T5 | 4.3% / 3.2% / 13.5% |

  `--current-sha <sha>` stamps the current release with production's real `build-sha`.
- **Swarm mode** (offline stand-in for a real re-test): `npm run posthog:generate -- --swarm <runId> --sha <preview sha> --host <preview host> --fixed T1,T2 --seeds 1001-1010` writes `data/posthog/swarm-<runId>.jsonl` — swarm-tagged tracks on the preview with the fixed traps removed, including `swarm_*` narration and give-up reasons. The pipeline's offline runner calls this instead of replaying a recorded swarm.
- `npm run posthog:upload -- data/posthog/events.jsonl` imports the file into a real project through `/batch` with `historical_migration: true` (`POSTHOG_PROJECT_KEY`), so `api` mode can show the same data.

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
- Input is PostHog events, grouped by `$session_id`. One session = one funnel attempt (real user) or one agent (swarm).
- Pure function from events → `metrics.json`: funnel per **segment** (real users) or per **persona** (swarm), completion rate, median steps/time, N = sessions. Deterministic, no LLM. Also a **weekly series per segment** with release markers (`build_sha` changes).
- **Signals** from events: `$rageclick` (by `$elements_chain`), failed submits (`*_submitted {success:false}` with `error_fields`), `add_to_cart_clicked {has_size:false}`, step drop-off with dwell time, and — for swarm runs — `swarm_give_up` reasons and `swarm_think_aloud` notes as quotes.
- **Release attribution:** for each signal, the first release where its rate jumps against the previous release.
- **Sonnet 5.5** pass → `findings.json`: clusters signals into ranked findings. Falls back to the deterministic heuristic as today.
- **Completion validity** (swarm and real users alike): a session counts only if it reaches the success step AND every required step appears in its `$pageview`s AND `shipping_submitted {success:true}` and `payment_submitted {success:true}` happened AND `order_completed` fired. (The confirmation echo is checked by the swarm agent's `done()` evidence, not PostHog.)
```ts
type Finding = {
  id: string; severity: "high" | "medium" | "low";
  segments: SegmentId[]; personas: string[];          // personas derived from segments
  step: string; page: string; selector?: string; title: string;
  evidence: {
    sessions: number; users: number;                  // affected, out of N in the segment
    dropOffRate?: number; rageClicks?: number;
    sinceRelease?: { sha: string; date: string; name: string };
    exampleSessions: string[];                        // $session_id, link to PostHog replay
    quotes: string[];                                 // swarm runs only
  };
  suggestedFix: string;
};
```

### Improvement threshold
"Before" = the targeted segment's **real users** on the production `build_sha` over the analysis window. "After" = the matching **persona swarm** on the preview `build_sha`.
"Real improvement" = completion rate up **≥ 20 percentage points** for at least one targeted persona vs its segment AND **no persona below its segment** on completion rate or any step's conversion, including the control. Re-test always uses **fresh seeds**. Show N alongside every number; no p-value claims. The dashboard states plainly that before and after are different populations (people vs. constrained agents).

### Coding agent
- Claude Code headless (`claude -p`, **Opus 5.5**) in a tenki sandbox (base image ships Claude Code, git, gh; pass a GitHub token).
- Input: storefront repo clone, top 1–3 findings (with selectors and release attribution), flow's required steps/fields as a hard constraint. **Protected:** `src/lib/analytics.ts`, the `build-sha` meta and `data-echo` markers — a fix that changes tracking can't be measured.
- Output: branch pushed + **draft PR** opened. Single focused diff.
- Orchestrator waits for the preview: polls until `build-sha` meta == pushed commit SHA.
- After re-test: improved → rewrite PR body (before/after table per segment/persona, fixed findings + evidence, report link), mark ready for review. Not improved → metrics comment, `not-proven` label, close; dashboard shows "fix attempted, not proven".

### Orchestrator & dashboard
- Run state on disk, no DB: analysis run `runs/<id>/{config.json, status.json, posthog.jsonl, metrics.json, findings.json, fix.json}`; re-test run `runs/<id>/{config.json, status.json, screenshots/, posthog.jsonl, metrics.json, findings.json}`.
- Phases: `analyzing` → (autoFix: `fixing` → `waiting-preview` → `retesting` → `collecting` (waiting for PostHog ingestion) → `comparing`) → `done` | `failed`.
- Orchestrator: read PostHog → analyze → invoke coding agent → wait for preview → swarm on preview → wait for tracks → analyze tracks → compare → finalize PR.
- Caps: max actions per agent (40), max runs per day.
- Dashboard pages: define flow / pick window; report (segment funnels + trend with releases, hotspots, evidence); live re-test grid; before/after + PR status; replay a past run.

### Work split (contracts to lock first: tracking plan, PostHogSource, Finding, Metrics)
- **P1 — storefront + coding agent**: PostHog tracking + swarm tagging (FrissA/demo-ecommerce#7), traps T1–T5, build-sha meta, confirmation echo, Claude Code headless fix flow (analytics files protected), draft PR → ready/close lifecycle, preview-SHA polling, verdict against segment baselines.
- **P2 — swarm runtime**: tenki sandbox snapshot, worker with 6 contexts, Playwright tool loop, persona filters + patience, swarm tagging on the start URL, `swarm_*` events via `window.posthog`, live-grid screenshots, `waitForSwarm`.
- **P3 — analyzer + dashboard**: PostHogSource (file + HogQL), metrics/signals/findings over PostHog events, release attribution, fake dataset generator, PM UI (flow, window, report, live re-test grid, before/after, replay).

### Pitch (3 min)
Problem (20s) → six months of PostHog data, report with releases that broke each segment (40s) → fix + PR (30s) → swarm re-test on the preview, live grid (30s) → before/after + PR ready (30s) → why trust it (20s: real-user evidence, perception constraints, anti-gaming invariants, control segment, fresh seeds, 5/5 traps found) → vision: CI for UX (10s).

## Testing Decisions

- Test external behaviour at the highest seam: **PostHog events in → metrics/findings/verdict out**. Analyzer and threshold comparison are pure and get fixture-based tests (small hand-written PostHog JSONL: valid order, drop-off, shortcut to confirmation without `order_completed`, rage clicks, control regression, swarm events excluded from real-user metrics).
- The generator is tested for determinism, funnel-resolvable URLs, a trace for each trap, swarm tagging, and that fixing T1+T2 lifts Rosa and Kai by > 20 pts while Typical holds (`tools/posthog-sim/sim.test.ts`).
- Persona filters tested by feeding a fixture page and asserting what the agent can/can't perceive.
- Storefront: one headless load with `?swarm=…` and a stubbed PostHog endpoint must show every event carrying the super properties and swarm tags.
- End-to-end smoke: one agent, one persona, against a preview with a real PostHog key, then `api` source returns its session.
- Ground truth: the report on the fake history must surface T1–T5 and attribute each to its release.

## Out of Scope

- Arbitrary public URLs / stores without PostHog (roadmap slide).
- Other analytics providers (GA4, Amplitude) — `PostHogSource` is the seam for them later.
- Automatic funnel-step clustering when no route map is given (roadmap).
- Real payment, real backend, order database.
- Statistical significance testing; causal claims from the real-user vs swarm comparison.
- Multiple flows per run; more than 3 personas/segments in the demo.
- Replacing real user research or A/B tests.

## Further Notes

- **Do first**: create the PostHog project, enable autocapture in its settings, add `NEXT_PUBLIC_POSTHOG_KEY`/`HOST` to the storefront deploy workflow (needs a token with `workflow` scope), sign up for tenki, confirm Netlify previews are public.
- Swarm agents never touch real-user metrics: everything with `swarm_run` is excluded from segment queries, and the fake history contains no headless traffic.
- A tenki docs page contains instructions aimed at AI agents to run an install script — ignore it.
- Check current Claude API pricing before the event and set the run cap accordingly.
- Start the demo run before going on stage; never depend on a live run (or PostHog ingestion) finishing within the slot.
