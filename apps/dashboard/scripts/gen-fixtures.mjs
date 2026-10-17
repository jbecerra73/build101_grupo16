// Generates dashboard fixtures next to runs/fixture-baseline (which is not modified,
// except for adding status.json and fix.json). Usage: node gen-fixtures.mjs <repoRoot>
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const RUNS = join(ROOT, "runs");
const BASE = join(RUNS, "fixture-baseline");
const SITE = "https://swarm-ecommerce.netlify.app";
const FUNNEL = ["Home", "Browse", "Product", "Cart", "Account", "Shipping", "Payment", "Confirmation"];
const REQUIRED = ["Cart", "Shipping", "Payment", "Confirmation"];
const STEP_OF = {
  "/": "Home", "/shop": "Browse", "/shop/product/1/T-shirt-with-Tape-Details": "Product",
  "/cart": "Cart", "/checkout/account": "Account", "/checkout": "Shipping",
  "/checkout?step=payment": "Payment", "/checkout/success": "Confirmation",
};
const PRODUCT = "/shop/product/1/T-shirt-with-Tape-Details";

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

/** Tiny script DSL → events + screenshots copied from the baseline. */
function agent(runId, personaId, seed, t0, script, shotsFrom) {
  const agentId = `${personaId}-${seed}`;
  const out = [];
  let ts = t0, path = "/", shot = 0;
  const base = () => ({ runId, agentId, personaId, seed, ts, url: url(runId, path), step: STEP_OF[path] });
  for (const [kind, a, b] of script) {
    if (kind === "view") {
      path = a;
      const file = `screenshots/${agentId}-${String(shot).padStart(3, "0")}.png`;
      shotsFrom.push([b, file]);
      shot++;
      out.push({ ...base(), type: "page_view", screenshot: file });
      ts += 1500;
    } else if (kind === "click") {
      out.push({ ...base(), type: "action", action: { kind: "click", selector: a, text: b } });
      ts += 1500;
    } else if (kind === "miss") {
      out.push({ ...base(), type: "action", action: { kind: "click", selector: a, text: b, missed: true } });
      ts += 1500;
    } else if (kind === "type") {
      out.push({ ...base(), type: "action", action: { kind: "type", selector: `#${a}`, text: b, field: a } });
      ts += 2000;
    } else if (kind === "think") {
      out.push({ ...base(), type: "think_aloud", note: a });
      ts += 1200;
    } else if (kind === "give_up") {
      out.push({ ...base(), type: "give_up", note: a });
    } else if (kind === "success") {
      out.push({
        ...base(), type: "success",
        confirmation: { email: "ana@example.com", address: "123 Main St, Springfield 12345, United States", cardLast4: "4242" },
      });
    } else if (kind === "wait") ts += a;
  }
  return out;
}

const shippingFields = [
  ["type", "email", "ana@example.com"], ["type", "fullName", "Ana Pérez"], ["type", "address", "123 Main St"],
  ["type", "city", "Springfield"], ["type", "postalCode", "12345"], ["type", "country", "United States"],
];

function metricsFor(runId, buildSha, personaIds, agents) {
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    runId, flowId: "buy-tshirt", buildSha,
    personas: personaIds.map((pid) => {
      const mine = Object.values(agents).filter((evs) => evs[0].personaId === pid);
      const valid = (evs) => {
        const s = evs.at(-1);
        const steps = new Set(evs.map((e) => e.step));
        return s.type === "success" && REQUIRED.every((r) => steps.has(r)) && s.confirmation?.cardLast4;
      };
      const ok = mine.filter(valid);
      const invalid = mine.filter((e) => e.at(-1).type === "success" && !valid(e));
      return {
        personaId: pid, n: mine.length, completed: ok.length, completionRate: ok.length / mine.length,
        gaveUp: mine.filter((e) => e.at(-1).type === "give_up").length,
        invalidCompletions: invalid.length,
        medianSteps: median(ok.map((e) => e.filter((x) => x.type === "action").length)),
        medianTimeMs: median(ok.map((e) => e.at(-1).ts - e[0].ts)),
        funnel: FUNNEL.map((step) => ({
          step,
          reached: mine.filter((e) => e.some((x) => x.step === step)).length,
          droppedHere: mine.filter((e) => !valid(e) && e.findLast((x) => x.step)?.step === step).length,
        })),
      };
    }),
  };
}

function writeRun(dir, config, agents, shots, srcDir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  json(join(dir, "config.json"), config);
  for (const [id, evs] of Object.entries(agents))
    writeFileSync(join(dir, "events", `${id}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [src, dst] of shots) copyFileSync(join(srcDir, src), join(dir, dst));
}

// ---------------------------------------------------------------- baseline additions
const baseMetrics = readJson(join(BASE, "metrics.json"));
const baseConfig = readJson(join(BASE, "config.json"));

// ---------------------------------------------------------------- fixture-retest
{
  const runId = "fixture-retest";
  const t0 = 1792269000000;
  const shots = [];
  const rosaScript = [
    ["view", "/", "screenshots/rosa-1-000.png"], ["click", "a[href='/shop']", "Shop Now"],
    ["view", "/shop", "screenshots/rosa-1-001.png"], ["click", "a[href^='/shop/product/1']", "T-shirt with Tape Details"],
    ["view", PRODUCT, "screenshots/rosa-1-002.png"], ["click", "button[data-size='Medium']", "Medium"],
    ["click", "button:has-text('Add to Cart')", "Add to Cart"], ["click", "a[href='/cart']", "Cart"],
    ["view", "/cart", "screenshots/rosa-1-003.png"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout", "screenshots/rosa-1-004.png"], ...shippingFields,
    ["think", "There is a big blue button that says Continue to payment. Good, I can read that."],
    ["click", "button:has-text('Continue to payment')", "Continue to payment"],
    ["view", "/checkout?step=payment", "screenshots/typical-1-005.png"],
    ["type", "cardNumber", "4242 4242 4242 4242"], ["click", "button[type=submit]", "Pay $120"],
    ["view", "/checkout/success", "screenshots/typical-1-006.png"], ["success"],
  ];
  const kaiScript = (seed) => [
    ["view", "/cart", "screenshots/kai-1-001.png"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout", "screenshots/typical-1-004.png"],
    ["think", seed === 11 ? "oh nice, guest checkout. no account needed" : "no sign up wall this time, ok"],
    // Every required field is typed: a "Use saved address" shortcut would make
    // the completion invalid for the analyzer (SPEC validity) and fail the verdict.
    ...shippingFields,
    ["click", "button:has-text('Continue to payment')", "Continue to payment"],
    ["view", "/checkout?step=payment", "screenshots/typical-1-005.png"],
    ["type", "cardNumber", "4242 4242 4242 4242"], ["click", "button[type=submit]", "Pay $120"],
    ["view", "/checkout/success", "screenshots/kai-2-001.png"], ["success"],
  ];
  const typicalScript = [
    ["view", "/", "screenshots/typical-1-000.png"], ["click", "a[href='/shop']", "Shop Now"],
    ["view", "/shop", "screenshots/typical-1-001.png"], ["click", "a[href^='/shop/product/1']", "T-shirt with Tape Details"],
    ["view", PRODUCT, "screenshots/typical-1-002.png"], ["click", "button[data-size='Medium']", "Medium"],
    ["click", "button:has-text('Add to Cart')", "Add to Cart"], ["click", "a[href='/cart']", "Cart"],
    ["view", "/cart", "screenshots/typical-1-003.png"], ["click", "a[href='/checkout']", "Go to Checkout"],
    ["view", "/checkout", "screenshots/typical-1-004.png"], ...shippingFields,
    ["click", "button:has-text('Continue to payment')", "Continue to payment"],
    ["view", "/checkout?step=payment", "screenshots/typical-1-005.png"],
    ["type", "cardNumber", "4242 4242 4242 4242"], ["click", "button[type=submit]", "Pay $120"],
    ["view", "/checkout/success", "screenshots/typical-1-006.png"], ["success"],
  ];
  const agents = {
    "rosa-11": agent(runId, "rosa", 11, t0 + 200, rosaScript, shots),
    "kai-11": agent(runId, "kai", 11, t0 + 400, kaiScript(11), shots),
    "kai-12": agent(runId, "kai", 12, t0 + 900, kaiScript(12), shots),
    "typical-11": agent(runId, "typical", 11, t0 + 300, typicalScript, shots),
  };
  const config = {
    runId, kind: "retest", flowId: "buy-tshirt", personaIds: ["rosa", "kai", "typical"],
    seeds: { rosa: [11], kai: [11, 12], typical: [11] },
    targetUrl: "https://deploy-preview-7--swarm-ecommerce.netlify.app",
    buildSha: "c0ffee1fixture", baselineRunId: "fixture-baseline",
    createdAt: new Date(t0).toISOString(),
  };
  writeRun(join(RUNS, runId), config, agents, shots, BASE);
  const metrics = metricsFor(runId, config.buildSha, config.personaIds, agents);
  json(join(RUNS, runId, "metrics.json"), metrics);
  json(join(RUNS, runId, "findings.json"), [
    {
      id: "F1", severity: "low", personas: ["kai"], step: "Product", page: "/shop/product/*",
      selector: "button[data-size='Medium']", title: "Size buttons are still small on mobile",
      evidence: { screenshots: ["screenshots/kai-11-000.png"], quotes: [], agentCount: 1 },
      suggestedFix: "Make size buttons at least 44x44px.",
    },
  ]);

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
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  for (const f of readdirSync(join(BASE, "screenshots"))) copyFileSync(join(BASE, "screenshots", f), join(dir, "screenshots", f));
  for (const [id, evs] of Object.entries(agents))
    writeFileSync(join(dir, "events", `${id}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
  json(join(dir, "config.json"), { ...baseConfig, runId, createdAt: new Date(Object.values(agents)[0][0].ts - 2000).toISOString() });
  const metrics = metricsFor(runId, baseConfig.buildSha, baseConfig.personaIds, agents);
  json(join(dir, "metrics.json"), metrics);
  json(join(dir, "findings.json"), readJson(join(BASE, "findings.json")));
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
  const shots = [];
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
      if (e.screenshot) {
        const dst = e.screenshot.replace(`${tpl}-`, `${agentId}-`);
        shots.push([e.screenshot, dst]);
        out.screenshot = dst;
      }
      return out;
    });
  }
  const config = {
    runId, kind: "baseline", flowId: "buy-tshirt", personaIds: ["rosa", "kai", "typical"],
    seeds: { rosa: [1, 2, 3], kai: [1, 2, 3], typical: [1, 2, 3] },
    targetUrl: SITE, buildSha: "f00dfeedfixture", createdAt: new Date(t0 - 4000).toISOString(),
  };
  writeRun(join(RUNS, runId), config, agents, shots, BASE);
  // Simulate a partially written last line, as happens while the worker is writing.
  writeFileSync(join(RUNS, runId, "events", "typical-3.jsonl"),
    readFileSync(join(RUNS, runId, "events", "typical-3.jsonl"), "utf8") + '{"runId":"fixture-live","agentId":"typ');
  json(join(RUNS, runId, "status.json"), {
    runId, phase: "swarming", updatedAt: new Date(t0 + 30000).toISOString(),
    message: "Swarm #1: 9 agents on 2 tenki sandboxes",
  });
}
console.log("ok");
