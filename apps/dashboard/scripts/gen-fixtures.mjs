// Generates the dashboard fixtures next to runs/fixture-baseline. The baseline's
// events, config and findings are not modified; it gets status.json, fix.json,
// themes.json and real screenshots. Usage (tsx, because it imports the analyzer):
//   npx tsx apps/dashboard/scripts/gen-fixtures.mjs
// Screenshots come from scripts/shots/<persona>/<page>.png (real captures of the
// production storefront, see capture-screenshots.mjs), picked by each event's
// persona and URL. metrics.json is computed by the analyzer, and every agent stays
// within its seeded action budget (actionBudget), so the analyzer counts the
// fixtures exactly as written.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMetrics, readRun, sanitizeThemes, validateCompletion } from "@frictionswarm/analyzer";
import { actionBudget, buyTshirt, PERSONAS } from "@frictionswarm/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv[2] ?? join(HERE, "..", "..", ".."));
const RUNS = join(ROOT, "runs");
const BASE = join(RUNS, "fixture-baseline");
const SHOTS = join(HERE, "shots");
const SITE = "https://swarm-ecommerce.netlify.app";
const PRODUCT = "/shop/product/1/T-shirt-with-Tape-Details";
const STEP_OF = {
  "/": "Home", "/shop": "Browse", [PRODUCT]: "Product",
  "/cart": "Cart", "/checkout/account": "Account", "/checkout": "Shipping",
  "/checkout?step=payment": "Payment", "/checkout/success": "Confirmation",
};
const PAGE_OF = {
  "/": "home", "/shop": "shop", [PRODUCT]: "product", "/cart": "cart", "/checkout/account": "account",
  "/checkout": "checkout", "/checkout?step=payment": "payment", "/checkout/success": "success",
};

const json = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readEvents = (dir) =>
  Object.fromEntries(
    readdirSync(join(dir, "events")).map((f) => [
      f.replace(".jsonl", ""),
      readFileSync(join(dir, "events", f), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    ]),
  );

function url(runId, path) {
  const [p, q] = path.split("?");
  return `${SITE}${p}?${q ? q + "&" : ""}swarm=${runId}`;
}

/** The captured screenshot for an event: persona look × page of its URL. */
function shotFor(e) {
  const u = new URL(e.url);
  const step = u.searchParams.get("step");
  const page = PAGE_OF[u.pathname + (step ? `?step=${step}` : "")];
  if (!page) throw new Error(`No captured page for ${e.url}`);
  return join(SHOTS, e.personaId, `${page}.png`);
}

/** Copy the captured screenshot of every event that references one into the run folder. */
function copyShots(dir, agents) {
  rmSync(join(dir, "screenshots"), { recursive: true, force: true });
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  for (const evs of Object.values(agents))
    for (const e of evs) if (e.screenshot) copyFileSync(shotFor(e), join(dir, e.screenshot));
}

/** Tiny script DSL → events (screenshots named <agentId>-NNN.png). */
function agent(runId, personaId, seed, t0, script) {
  const agentId = `${personaId}-${seed}`;
  const out = [];
  let ts = t0, path = "/", shot = 0;
  const base = () => ({ runId, agentId, personaId, seed, ts, url: url(runId, path), step: STEP_OF[path] });
  for (const [kind, a, b] of script) {
    if (kind === "view") {
      path = a;
      out.push({ ...base(), type: "page_view", screenshot: `screenshots/${agentId}-${String(shot++).padStart(3, "0")}.png` });
      ts += 1500;
    } else if (kind === "click") {
      out.push({ ...base(), type: "action", action: { kind: "click", selector: a, text: b } });
      ts += 1500;
    } else if (kind === "type") {
      out.push({ ...base(), type: "action", action: { kind: "type", selector: `#${a}`, text: b, field: a } });
      ts += 2000;
    } else if (kind === "think") {
      out.push({ ...base(), type: "think_aloud", note: a });
      ts += 1200;
    } else if (kind === "success") {
      out.push({
        ...base(), type: "success",
        confirmation: { email: "ana@example.com", address: "123 Main St, Springfield 12345, United States", cardLast4: "4242" },
      });
    }
  }
  return out;
}

const shippingFields = [
  ["type", "email", "ana@example.com"], ["type", "fullName", "Ana Pérez"], ["type", "address", "123 Main St"],
  ["type", "city", "Springfield"], ["type", "postalCode", "12345"], ["type", "country", "United States"],
];

function writeRun(dir, config, agents) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  json(join(dir, "config.json"), config);
  for (const [id, evs] of Object.entries(agents))
    writeFileSync(join(dir, "events", `${id}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
  copyShots(dir, agents);
}

/** metrics.json = what the analyzer computes; fail loudly if an agent breaks its budget. */
function analyzerMetrics(dir) {
  const run = readRun(dir);
  for (const evs of run.byAgent.values()) {
    const n = evs.filter((e) => e.type === "action").length;
    const budget = actionBudget(PERSONAS[evs[0].personaId], evs[0].seed);
    if (n > budget) throw new Error(`${dir}: ${evs[0].agentId} took ${n} actions, budget ${budget}`);
  }
  const metrics = computeMetrics(run.config, buyTshirt, run.events);
  json(join(dir, "metrics.json"), metrics);
  return { run, metrics };
}

/** Hand-written themes (like the hand-written findings), validated by the analyzer's own rules. */
function writeThemes(dir, themes, findingIds) {
  const run = readRun(dir);
  const out = sanitizeThemes(themes, run.events, new Map(findingIds.map((id) => [id, id])));
  const quotes = (ts) => ts.reduce((n, t) => n + t.quotes.length, 0);
  if (out.length !== themes.length || quotes(out) !== quotes(themes)) throw new Error(`${dir}: a theme quote is not in the agent's notes`);
  json(join(dir, "themes.json"), out);
}

const BASELINE_THEMES = [
  {
    title: "Could not see how to continue to payment",
    agentIds: ["rosa-1"],
    quotes: [
      { agentId: "rosa-1", text: "I can't find how to continue to payment. There is no button I can read." },
      { agentId: "rosa-1", text: "I filled everything in but I can't find a button to go on." },
    ],
    findingIds: ["F1"],
  },
  {
    title: "Refused a forced sign-up on mobile",
    agentIds: ["kai-1"],
    quotes: [
      { agentId: "kai-1", text: "Forced to create an account with 9 fields. Not doing that on my phone." },
      { agentId: "kai-1", text: "9 fields just to buy a shirt?? no way" },
    ],
    findingIds: ["F2"],
  },
];

// ---------------------------------------------------------------- fixture-baseline (screenshots, themes)
const baseMetrics = readJson(join(BASE, "metrics.json"));
const baseConfig = readJson(join(BASE, "config.json"));
copyShots(BASE, readEvents(BASE));
writeThemes(BASE, BASELINE_THEMES, ["F1", "F2", "F3"]);

// ---------------------------------------------------------------- fixture-retest
{
  const runId = "fixture-retest";
  const t0 = 1792269000000;
  const rosaScript = [
    ["view", "/"], ["click", "a[href='/shop']", "Shop Now"],
    ["view", "/shop"], ["click", "a[href^='/shop/product/1']", "T-shirt with Tape Details"],
    ["view", PRODUCT], ["click", "button[data-size='Medium']", "Medium"],
    ["click", "button:has-text('Add to Cart')", "Add to Cart"], ["click", "a[href='/cart']", "Cart"],
    ["view", "/cart"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout"], ...shippingFields,
    ["think", "There is a big blue button that says Continue to payment. Good, I can read that."],
    ["click", "button:has-text('Continue to payment')", "Continue to payment"],
    ["view", "/checkout?step=payment"],
    ["type", "cardNumber", "4242 4242 4242 4242"], ["click", "button[type=submit]", "Pay $120"],
    ["view", "/checkout/success"], ["success"],
  ];
  // Kai's budget is drawn from 8–12 by seed. Seed 11 gets 10: room for the buttons.
  // Every required field is typed: a "Use saved address" shortcut would make the
  // completion invalid for the analyzer (SPEC validity) and fail the verdict.
  const kaiButtons = [
    ["view", "/cart"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout"], ["think", "oh nice, guest checkout. no account needed"],
    ...shippingFields,
    ["click", "button:has-text('Continue to payment')", "Continue to payment"],
    ["view", "/checkout?step=payment"],
    ["type", "cardNumber", "4242 4242 4242 4242"], ["click", "button[type=submit]", "Pay $120"],
    ["view", "/checkout/success"], ["success"],
  ];
  // Seed 12 also gets 10, but this agent submits each form with the phone keyboard's
  // Go key: 8 actions, so the replay runner can reuse it for seeds with a budget of 8.
  const kaiKeyboard = [
    ["view", "/cart"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout"], ["think", "no sign up wall this time, ok"],
    ...shippingFields,
    ["view", "/checkout?step=payment"], ["think", "hit go on the keyboard, it moved on"],
    ["type", "cardNumber", "4242 4242 4242 4242"],
    ["view", "/checkout/success"], ["success"],
  ];
  const typicalScript = [
    ["view", "/"], ["click", "a[href='/shop']", "Shop Now"],
    ["view", "/shop"], ["click", "a[href^='/shop/product/1']", "T-shirt with Tape Details"],
    ["view", PRODUCT], ["click", "button[data-size='Medium']", "Medium"],
    ["click", "button:has-text('Add to Cart')", "Add to Cart"], ["click", "a[href='/cart']", "Cart"],
    ["view", "/cart"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout"], ...shippingFields,
    ["click", "button:has-text('Continue to payment')", "Continue to payment"],
    ["view", "/checkout?step=payment"],
    ["type", "cardNumber", "4242 4242 4242 4242"], ["click", "button[type=submit]", "Pay $120"],
    ["view", "/checkout/success"], ["success"],
  ];
  const agents = {
    "rosa-11": agent(runId, "rosa", 11, t0 + 200, rosaScript),
    "kai-11": agent(runId, "kai", 11, t0 + 400, kaiButtons),
    "kai-12": agent(runId, "kai", 12, t0 + 900, kaiKeyboard),
    "typical-11": agent(runId, "typical", 11, t0 + 300, typicalScript),
  };
  for (const [id, evs] of Object.entries(agents)) {
    const v = validateCompletion(buyTshirt, evs);
    if (!v.valid) throw new Error(`${runId}/${id} is not a valid completion: ${v.reasons.join("; ")}`);
  }
  const config = {
    runId, kind: "retest", flowId: "buy-tshirt", personaIds: ["rosa", "kai", "typical"],
    seeds: { rosa: [11], kai: [11, 12], typical: [11] },
    targetUrl: "https://deploy-preview-7--swarm-ecommerce.netlify.app",
    buildSha: "c0ffee1fixture", baselineRunId: "fixture-baseline",
    createdAt: new Date(t0).toISOString(),
  };
  const dir = join(RUNS, runId);
  writeRun(dir, config, agents);
  const { metrics } = analyzerMetrics(dir);
  json(join(dir, "findings.json"), [
    {
      id: "F1", severity: "low", personas: ["kai"], step: "Shipping", page: "/checkout",
      selector: "button:has-text('Continue to payment')", title: "Continue button sits below the fold on mobile",
      evidence: { screenshots: ["screenshots/kai-11-001.png"], quotes: [], agentCount: 1 },
      suggestedFix: "Keep the Continue button visible (sticky footer) while the shipping form is open on small screens.",
    },
  ]);
  json(join(dir, "themes.json"), []);

  // Verdict lives in the baseline's fix.json.
  const comparisons = config.personaIds.map((pid) => {
    const before = baseMetrics.personas.find((p) => p.personaId === pid);
    const after = metrics.personas.find((p) => p.personaId === pid);
    return {
      personaId: pid, before, after,
      completionDeltaPts: Math.round((after.completionRate - before.completionRate) * 100), regressions: [],
    };
  });
  const verdict = {
    improved: true, targetedPersonas: ["rosa", "kai"], comparisons,
    reasons: [
      "rosa: completion +100 pts (0/1 → 1/1), meets the ≥ 20 pts threshold",
      "kai: completion +100 pts (0/2 → 2/2), meets the ≥ 20 pts threshold",
      "No metric got worse for any persona, including the control (typical, 1/1 → 1/1)",
    ],
  };
  json(join(BASE, "fix.json"), {
    baselineRunId: "fixture-baseline", repo: "FrissA/demo-ecommerce",
    attempts: [
      {
        attempt: 1, findingIds: ["F1", "F2"], branch: "frictionswarm/fixture-baseline-1",
        commitSha: "c0ffee1fixture", prNumber: 7, prUrl: "https://github.com/FrissA/demo-ecommerce/pull/7",
        previewUrl: "https://deploy-preview-7--swarm-ecommerce.netlify.app", retestRunId: runId,
        status: "ready", verdict,
        summary:
          "Replaced the 11px light-gray 'Continue to payment' link with a full-width, high-contrast primary button, " +
          "and added a guest checkout path so /checkout no longer redirects to the 9-field account form. " +
          "Required fields and the payment step are unchanged.",
      },
    ],
  });
  json(join(BASE, "status.json"), {
    runId: "fixture-baseline", phase: "done", updatedAt: new Date(t0 + 60000).toISOString(),
    message: "Fix proven: PR #7 marked ready for review", retestRunId: runId,
  });
}

// ---------------------------------------------------------------- fixture-not-proven
{
  const runId = "fixture-not-proven";
  const src = readEvents(BASE);
  const agents = Object.fromEntries(
    Object.entries(src).map(([id, evs]) => [
      id,
      evs.map((e) => ({ ...e, runId, ts: e.ts - 3600_000, url: e.url?.replace("swarm=fixture-baseline", `swarm=${runId}`) })),
    ]),
  );
  const dir = join(RUNS, runId);
  writeRun(dir, { ...baseConfig, runId, createdAt: new Date(Object.values(agents)[0][0].ts - 2000).toISOString() }, agents);
  const { metrics } = analyzerMetrics(dir);
  json(join(dir, "findings.json"), readJson(join(BASE, "findings.json")));
  writeThemes(dir, BASELINE_THEMES, ["F1", "F2", "F3"]);
  const before = (pid) => metrics.personas.find((p) => p.personaId === pid);
  const after = (pid, patch) => ({ ...before(pid), ...patch });
  const cmp = (pid, patch, regressions = []) => {
    const a = after(pid, patch);
    return {
      personaId: pid, before: before(pid), after: a,
      completionDeltaPts: Math.round((a.completionRate - before(pid).completionRate) * 100), regressions,
    };
  };
  json(join(dir, "fix.json"), {
    baselineRunId: runId, repo: "FrissA/demo-ecommerce",
    attempts: [
      {
        attempt: 1, findingIds: ["F1", "F2"], branch: `frictionswarm/${runId}-1`, commitSha: "badc0de1",
        prNumber: 5, prUrl: "https://github.com/FrissA/demo-ecommerce/pull/5",
        previewUrl: "https://deploy-preview-5--swarm-ecommerce.netlify.app", status: "not-proven",
        summary: "Made 'Continue to payment' a large button and moved account creation into a modal on the shipping step.",
        verdict: {
          improved: false, targetedPersonas: ["rosa", "kai"],
          comparisons: [
            cmp("rosa", { completed: 1, completionRate: 1, gaveUp: 0, medianSteps: 21, medianTimeMs: 51200 }),
            cmp("kai", {}),
            cmp("typical", { medianSteps: 24, medianTimeMs: 58900 }, ["medianSteps 19 → 24", "medianTimeMs 46.2s → 58.9s"]),
          ],
          reasons: [
            "rosa: completion +100 pts (0/1 → 1/1)",
            "kai: completion +0 pts (0/2 → 0/2): the sign-up modal still blocks checkout",
            "Control regressed: typical median steps 19 → 24 and median time 46.2s → 58.9s",
          ],
        },
      },
      {
        attempt: 2, findingIds: ["F2"], branch: `frictionswarm/${runId}-2`, commitSha: "badc0de2",
        prNumber: 6, prUrl: "https://github.com/FrissA/demo-ecommerce/pull/6",
        previewUrl: "https://deploy-preview-6--swarm-ecommerce.netlify.app", status: "not-proven",
        summary: "Added a 'Continue as guest' link under the account form.",
        verdict: {
          improved: false, targetedPersonas: ["kai"],
          comparisons: [
            cmp("rosa", {}),
            cmp("kai", { completed: 0, gaveUp: 1, invalidCompletions: 1 }),
            cmp("typical", {}),
          ],
          reasons: [
            "kai: completion +0 pts (0/2 → 0/2), below the ≥ 20 pts threshold",
            "The guest link is 12px and fails Kai's 44px tap-target minimum",
          ],
        },
      },
    ],
  });
  json(join(dir, "status.json"), {
    runId, phase: "done", updatedAt: new Date(Object.values(agents)[0][0].ts + 900_000).toISOString(),
    message: "Fix attempted twice, not proven. PRs closed and labelled not-proven.",
  });
}

// ---------------------------------------------------------------- fixture-live (swarming)
{
  const runId = "fixture-live";
  const src = readEvents(BASE);
  const plan = [
    ["rosa", 1, "rosa-1", 22], ["rosa", 2, "rosa-1", 13], ["rosa", 3, "rosa-1", 6],
    ["kai", 1, "kai-1", 10], ["kai", 2, "kai-1", 6], ["kai", 3, "kai-1", 3],
    ["typical", 1, "typical-1", 27], ["typical", 2, "typical-1", 16], ["typical", 3, "typical-1", 4],
  ];
  const t0 = Date.parse("2026-10-17T21:30:00.000Z");
  const agents = {};
  for (const [pid, seed, tpl, len] of plan) {
    const agentId = `${pid}-${seed}`;
    const tplEvents = src[tpl];
    const offset = t0 + seed * 700 - tplEvents[0].ts;
    agents[agentId] = tplEvents.slice(0, len).map((e) => {
      const out = { ...e, runId, agentId, seed, ts: e.ts + offset, url: e.url?.replace("swarm=fixture-baseline", `swarm=${runId}`) };
      if (e.screenshot) out.screenshot = e.screenshot.replace(`${tpl}-`, `${agentId}-`);
      return out;
    });
  }
  const config = {
    runId, kind: "baseline", flowId: "buy-tshirt", personaIds: ["rosa", "kai", "typical"],
    seeds: { rosa: [1, 2, 3], kai: [1, 2, 3], typical: [1, 2, 3] },
    targetUrl: SITE, buildSha: "f00dfeedfixture", createdAt: new Date(t0 - 4000).toISOString(),
  };
  const dir = join(RUNS, runId);
  writeRun(dir, config, agents);
  for (const evs of Object.values(agents)) {
    const n = evs.filter((e) => e.type === "action").length;
    if (n > actionBudget(PERSONAS[evs[0].personaId], evs[0].seed)) throw new Error(`${runId}/${evs[0].agentId} is over budget`);
  }
  // Simulate a partially written last line, as happens while the worker is writing.
  writeFileSync(join(dir, "events", "typical-3.jsonl"),
    readFileSync(join(dir, "events", "typical-3.jsonl"), "utf8") + '{"runId":"fixture-live","agentId":"typ');
  json(join(dir, "status.json"), {
    runId, phase: "swarming", updatedAt: new Date(t0 + 30000).toISOString(),
    message: "Swarm #1: 9 agents on 2 tenki sandboxes",
  });
}
console.log("ok");
