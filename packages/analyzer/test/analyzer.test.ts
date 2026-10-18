import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSource } from "@frictionswarm/posthog";
import { addToCart, buyJeans, buyTshirt, promoCheckout, type Metrics, type PostHogEvent, type RunConfig } from "@frictionswarm/shared";
import { mulberry32, newVisitor, RELEASES, SEGMENT_PROFILES, simulateSession, visitorSegment } from "../../../tools/posthog-sim/sim";
import {
  AnswerSchema,
  attributeRelease,
  analyzeRun,
  computeMetrics,
  compareSegmentsToPersonas,
  createAnalyzer,
  describeElement,
  extractJson,
  frictionSignals,
  generateFindings,
  heuristicFindings,
  heuristicThemes,
  historyFromSummaries,
  linkToTargets,
  KNOWN_RELEASES,
  modelFromEnv,
  parseElementsChain,
  parseJsonl,
  releaseRates,
  summarizeSessions,
  validateCompletion,
  type FindingsInput,
  type ReleaseRate,
} from "../src";

const FX = join(import.meta.dirname, "fixtures");
const fx = (name: string) => parseJsonl<PostHogEvent>(readFileSync(join(FX, `${name}.jsonl`), "utf8"));
const REAL = ["valid-order", "drop-off", "shortcut", "missing-step", "rage-clicks"].flatMap(fx);
const SWARM = fx("swarm");
const noLlm = { env: {} };

const analysisConfig: RunConfig = {
  runId: "a1", kind: "analysis", flowId: "buy-tshirt", window: { from: "2026-10-14", to: "2026-10-17" },
  posthog: { source: "file", buildSha: "" }, personaIds: [], seeds: {}, targetUrl: "x", createdAt: "",
};
const retestConfig: RunConfig = {
  runId: "r1", kind: "retest", flowId: "buy-tshirt", posthog: { source: "file", buildSha: "preview" },
  personaIds: ["rosa", "kai", "typical"], seeds: { rosa: [1], kai: [], typical: [1, 2] }, targetUrl: "x", createdAt: "",
};
const session = (id: string) => REAL.filter((e) => e.properties.$session_id === id);

describe("validateCompletion", () => {
  it("accepts a full order", () => {
    expect(validateCompletion(buyTshirt, fx("valid-order"))).toEqual({ valid: true, reasons: [] });
  });
  it("rejects a shortcut to /checkout/success without order_completed", () => {
    const v = validateCompletion(buyTshirt, fx("shortcut"));
    expect(v.valid).toBe(false);
    expect(v.reasons).toEqual([
      "skipped required step(s): Shipping, Payment",
      "no successful shipping_submitted",
      "no successful payment_submitted",
      "no order_completed",
    ]);
  });
  it("rejects an order whose $pageviews miss a required step", () => {
    expect(validateCompletion(buyTshirt, fx("missing-step"))).toEqual({ valid: false, reasons: ["skipped required step(s): Payment"] });
  });
  it("rejects a drop-off", () => {
    expect(validateCompletion(buyTshirt, session("drop-1")).reasons[0]).toBe("never reached the success step");
  });
});

describe("other flows", () => {
  const order = fx("valid-order");
  const added = (product_id: number): PostHogEvent => ({ ...order[0], uuid: "v-added", event: "product_added", properties: { ...order[0].properties, product_id } });
  const realUsers = (n: number) => {
    const rng = mulberry32(3);
    return Array.from({ length: n }, (_, i) => {
      const visitor = newVisitor(rng, Date.parse("2026-10-01T12:00:00Z") + i);
      return simulateSession({
        rng, start: Date.parse("2026-10-01T12:00:00Z") + i * 60_000, visitor, host: "swarm-ecommerce.netlify.app", buildSha: "prod",
        traps: RELEASES.at(-1)!.traps, profile: SEGMENT_PROFILES[visitorSegment(visitor)], promoCodes: true,
      }).events;
    });
  };

  it("each flow checks its own completion events", () => {
    expect(validateCompletion(buyJeans, order).reasons).toEqual(["no product_added with product_id=2"]);
    expect(validateCompletion(buyJeans, [...order, added(2)]).valid).toBe(true);
    expect(validateCompletion(buyJeans, [...order, added(1)]).valid).toBe(false);
    expect(validateCompletion(promoCheckout, order).reasons).toEqual(["no successful promo_applied"]);
    // Add to cart ends at /cart (which this order passed): the order is irrelevant, the product_added is not.
    expect(validateCompletion(addToCart, order).reasons).toEqual(["no product_added"]);
    expect(validateCompletion(addToCart, [...order, added(1)]).valid).toBe(true);
  });

  it("counts only the real users who attempted the flow; every swarm agent counts", () => {
    const sessions = realUsers(400);
    const jeans = summarizeSessions(buyJeans, sessions.flat());
    const viewedJeans = sessions.filter((evs) => evs.some((e) => e.event === "product_viewed" && e.properties.product_id === 2));
    expect(jeans.length).toBe(viewedJeans.length);
    expect(jeans.length).toBeGreaterThan(0);
    expect(summarizeSessions(addToCart, sessions.flat()).length).toBe(sessions.length);
    const tried = new Set(REAL.filter((e) => e.event === "promo_applied").map((e) => e.properties.$session_id));
    expect(summarizeSessions(promoCheckout, REAL).map((x) => x.id)).toEqual([...tried]);
    expect(summarizeSessions(buyTshirt, REAL).length).toBeGreaterThan(tried.size);
    expect(summarizeSessions(promoCheckout, SWARM).length).toBe(summarizeSessions(buyTshirt, SWARM).length);
  });

  it("ignores friction on pages outside the flow", () => {
    const summaries = summarizeSessions(addToCart, realUsers(600).flat());
    const steps = new Set(addToCart.steps.map((s) => s.name));
    const marks = summaries.flatMap((s) => s.marks);
    expect(marks.some((m) => m.kind === "rage_click")).toBe(true);
    for (const m of marks) expect(steps).toContain(m.step);
  });
});

describe("computeMetrics", () => {
  const m = computeMetrics(analysisConfig, buyTshirt, REAL);
  const seg = (id: string) => m.segments.find((s) => s.segmentId === id)!;

  it("measures each segment: N sessions, users, valid completions, invalid ones, medians over valid completions", () => {
    expect(m.segments.map((s) => s.segmentId)).toEqual(["low_vision", "mobile", "desktop"]);
    expect(seg("desktop")).toMatchObject({
      n: 4, users: 4, completed: 1, completionRate: 0.25, invalidCompletions: 2, gaveUp: 1,
      medianSteps: 12, // 6 funnel $pageviews + 6 $autocapture actions
      medianTimeMs: 123_000, // first event → /checkout/success
    });
    expect(seg("mobile")).toMatchObject({ n: 2, completed: 0, gaveUp: 2, medianSteps: 0, medianTimeMs: 0 });
    expect(seg("low_vision")).toMatchObject({ n: 2, completed: 0 }); // font_scale 1.5, and a mobile user with prefers_contrast
    expect(m.personas).toEqual([]);
  });

  it("reports the funnel: steps reached by anyone plus required ones, with drop-off per step", () => {
    expect(seg("mobile").funnel.map((f) => f.step)).toEqual(["Home", "Product", "Cart", "Shipping", "Payment", "Confirmation"]);
    expect(seg("mobile").funnel.find((f) => f.step === "Product")).toEqual({ step: "Product", reached: 1, droppedHere: 1 });
    expect(seg("mobile").funnel.find((f) => f.step === "Payment")).toEqual({ step: "Payment", reached: 1, droppedHere: 1 });
    expect(seg("low_vision").funnel.find((f) => f.step === "Shipping")).toEqual({ step: "Shipping", reached: 2, droppedHere: 2 });
    // The shortcut counts as reaching Confirmation and dropping there (it isn't a completion)
    expect(seg("desktop").funnel.find((f) => f.step === "Confirmation")).toEqual({ step: "Confirmation", reached: 3, droppedHere: 2 });
  });

  it("adds a weekly trend with releases", () => {
    expect(m.trend!.releases).toEqual([{ sha: "prod", date: "2026-10-14", name: "prod" }]);
    expect(m.trend!.points).toEqual([
      { segmentId: "low_vision", weekStart: "2026-10-12", n: 2, completed: 0, completionRate: 0 },
      { segmentId: "mobile", weekStart: "2026-10-12", n: 2, completed: 0, completionRate: 0 },
      { segmentId: "desktop", weekStart: "2026-10-12", n: 4, completed: 1, completionRate: 0.25 },
    ]);
  });

  it("measures a retest per persona (swarm_persona)", () => {
    const r = computeMetrics(retestConfig, buyTshirt, SWARM);
    expect(r.segments).toEqual([]);
    expect(r.personas.map((p) => [p.personaId, p.n, p.completed, p.gaveUp])).toEqual([
      ["rosa", 1, 1, 0],
      ["kai", 0, 0, 0],
      ["typical", 2, 1, 1],
    ]);
  });

  it("is pure and deterministic", () => {
    expect(computeMetrics(analysisConfig, buyTshirt, [...REAL].reverse())).toEqual(m);
  });
});

describe("swarm events never count as real users", () => {
  it("are dropped by the source before the analyzer sees them", async () => {
    const data = mkdtempSync(join(tmpdir(), "ph-"));
    writeFileSync(join(data, "events.jsonl"), [...REAL, ...SWARM].map((e) => JSON.stringify(e)).join("\n"));
    const run = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(run, "config.json"), JSON.stringify(analysisConfig));
    const r = await analyzeRun(run, { source: fileSource({ dataDir: data }), ...noLlm });
    expect(r.sessions).toBe(8);
    expect(r.metrics.segments.reduce((n, s) => n + s.n, 0)).toBe(8);
    const snap = parseJsonl<PostHogEvent>(readFileSync(join(run, "posthog.jsonl"), "utf8"));
    expect(snap).toHaveLength(REAL.length);
    expect(snap.some((e) => e.properties.swarm_run)).toBe(false);
    expect(r.metrics).toEqual(computeMetrics(analysisConfig, buyTshirt, REAL, { history: r.history }));
  });
});

describe("elements", () => {
  it("reads PostHog element chains into a selector and label", () => {
    const chain = 'button.text-sm.md:text-base.rounded-full:attr__type="submit"nth-child="1"nth-of-type="1"text="Pay; now";div.flex.justify-end';
    const [el, parent] = parseElementsChain(chain);
    expect(el).toEqual({ tag: "button", classes: ["text-sm", "md:text-base", "rounded-full"], attrs: { attr__type: "submit", "nth-child": "1", "nth-of-type": "1", text: "Pay; now" }, text: "Pay; now" });
    expect(parent).toMatchObject({ tag: "div", classes: ["flex", "justify-end"] });
    expect(describeElement(chain)).toEqual({ selector: 'button.text-sm.md:text-base.rounded-full[type="submit"]:has-text("Pay; now")', label: "Pay; now", tag: "button" });
    expect(describeElement('div.flex:nth-child="3";form;div.card:text="Shipping"')).toEqual({ selector: "div.flex", label: "Shipping", tag: "div" });
  });
});

describe("signals", () => {
  const sessions = summarizeSessions(buyTshirt, REAL);
  const signals = frictionSignals(buyTshirt, sessions, { kind: "analysis", minSessions: 1 });
  const byKind = (k: string) => signals.filter((s) => s.kind === k);

  it("groups $rageclick by element chain", () => {
    const [rage] = byKind("rage_click");
    expect(rage).toMatchObject({
      step: "Shipping", page: "/checkout", selector: "div.flex.items-center.p-6.pt-0.justify-end",
      sessions: 2, users: 2, events: 3, exits: 2, strong: true,
    });
    expect(rage.groups.find((g) => g.id === "low_vision")).toEqual({ id: "low_vision", sessions: 2, reached: 2, rate: 1 });
    expect(rage.groups.find((g) => g.id === "desktop")).toEqual({ id: "desktop", sessions: 0, reached: 3, rate: 0 });
    expect(rage.exampleSessions).toEqual(["rage-1", "rage-2"]);
  });

  it("finds size-less add to cart, failed submits and the promo wipe (T5 pattern)", () => {
    expect(byKind("no_size")[0]).toMatchObject({ step: "Product", sessions: 1, events: 2, exits: 1 });
    expect(byKind("promo_wipe")[0]).toMatchObject({ step: "Shipping", fields: ["email", "fullName", "address", "city", "postalCode"], exampleSessions: ["promo-1"] });
    expect(byKind("failed_submit")).toEqual([]); // the wipe isn't double-counted
  });

  it("measures drop-off with dwell per step and group", () => {
    const pay = signals.find((s) => s.key === "drop_off|Payment|")!;
    expect(pay.groups.find((g) => g.id === "mobile")).toEqual({ id: "mobile", sessions: 1, reached: 1, rate: 1, exitDwellMs: 7000 });
    const ship = signals.find((s) => s.key === "drop_off|Shipping|")!;
    // promo-1's exit is explained by the wipe; the rage-click exits are not
    expect(ship.groups.find((g) => g.id === "low_vision")).toMatchObject({ sessions: 2, exitDwellMs: 95_000 });
  });

  it("quotes swarm give-ups and think-aloud notes on a retest", () => {
    const sig = frictionSignals(buyTshirt, summarizeSessions(buyTshirt, SWARM), { kind: "retest" });
    const giveUp = sig.find((s) => s.kind === "give_up")!;
    expect(giveUp).toMatchObject({ step: "Shipping", strong: true, groups: [{ id: "rosa", sessions: 0, reached: 1, rate: 0 }, { id: "typical", sessions: 1, reached: 2, rate: 0.5 }] });
    expect(giveUp.quotes).toEqual(["Applying the promo code erased my whole address. I'm not typing it again.", "Now the shipping form. Filling in my address."]);
  });
});

describe("release attribution", () => {
  const r = (name: string, rate: number, reached = 100): ReleaseRate => ({ release: { sha: name, date: "2026-01-01", name }, count: rate * reached, reached, rate });

  it("picks the first release where the rate jumps", () => {
    expect(attributeRelease([r("A", 0), r("B", 0.3), r("C", 0.31), r("D", 0.5)])?.name).toBe("B");
    expect(attributeRelease([r("A", 0.01), r("B", 0.02), r("C", 0.4), r("D", 0.41)])?.name).toBe("C");
  });
  it("attributes a signal present from the start to the oldest release", () => {
    expect(attributeRelease([r("A", 0.15), r("B", 0.16), r("C", 0.14)])?.name).toBe("A");
  });
  it("skips releases without traffic at the step and ignores noise", () => {
    expect(attributeRelease([r("A", 0, 0), r("B", 0, 0), r("C", 0.45)])?.name).toBe("C");
    expect(attributeRelease([r("A", 0.01), r("B", 0.015)])).toBeUndefined();
  });
  it("rates marks per release over the chosen segments", () => {
    const sessions = summarizeSessions(buyTshirt, REAL);
    const h = historyFromSummaries(
      sessions.map((s) => ({ ...s, buildSha: s.segment === "low_vision" ? "new" : "old", start: s.segment === "low_vision" ? s.start + 1e9 : s.start })),
      { from: "", to: "" },
    );
    expect(h.releases.map((x) => x.sha)).toEqual(["old", "new"]);
    const rates = releaseRates(h, "rage_click|Shipping|div.flex.items-center.p-6.pt-0.justify-end", ["low_vision", "mobile", "desktop"]);
    expect(rates.map((x) => [x.release.sha, x.count, x.reached])).toEqual([["old", 0, 4], ["new", 2, 2]]);
  });
  it("knows the fake history's release names", () => {
    expect(KNOWN_RELEASES).toEqual(RELEASES.map(({ sha, date, name }) => ({ sha, date, name })));
  });
});

describe("heuristic findings", () => {
  const sessions = summarizeSessions(buyTshirt, REAL);
  const ctx = { flow: buyTshirt, kind: "analysis" as const, sessions, minSessions: 1 };
  const findings = heuristicFindings(ctx, frictionSignals(buyTshirt, sessions, { kind: "analysis", minSessions: 1 }));

  it("turns rage clicks around the hidden continue button into a finding for the right segment", () => {
    const f = findings.find((x) => x.step === "Shipping" && x.segments.includes("low_vision"))!;
    expect(f).toMatchObject({
      segments: ["low_vision"], personas: ["rosa"], page: "/checkout",
      selector: 'button.text-[11px][type="submit"]:has-text("Continue to payment")',
      evidence: { sessions: 2, users: 2, rageClicks: 3, dropOffRate: 1, exampleSessions: ["rage-1", "rage-2"], quotes: [] },
    });
    expect(f.title).toMatch(/can't find 'Continue to payment'/);
  });

  it("uses the Finding shape: personas derived from segments, example sessions that exist, ids F1..Fn", () => {
    const ids = new Set(sessions.map((s) => s.id));
    expect(findings.map((f) => f.id)).toEqual(findings.map((_, i) => `F${i + 1}`));
    for (const f of findings) {
      expect(f.personas).toEqual(f.segments.map((s) => ({ low_vision: "rosa", mobile: "kai", desktop: "typical" })[s]));
      for (const s of f.evidence.exampleSessions) expect(ids.has(s)).toBe(true);
      expect(f.evidence.sessions).toBeGreaterThanOrEqual(f.evidence.exampleSessions.length);
    }
    expect(findings.find((f) => f.title.startsWith("Applying a promo code wipes"))).toBeDefined();
  });
});

describe("findings (model path)", () => {
  const sessions = summarizeSessions(buyTshirt, REAL);
  const signals = frictionSignals(buyTshirt, sessions, { kind: "analysis", minSessions: 1 });
  const input: FindingsInput = {
    runId: "a1", kind: "analysis", flow: buyTshirt, sessions, signals,
    metrics: computeMetrics(analysisConfig, buyTshirt, sessions),
  };
  const id = (kind: string) => signals.find((s) => s.kind === kind)!.id;
  const mf = (over: object) => ({
    severity: "high", signalIds: [id("rage_click")], segments: ["low_vision"], step: "Shipping", page: "/checkout",
    selector: null, title: "Continue is invisible", suggestedFix: "Big button", quotes: [], ...over,
  });

  it("sends aggregated signals, not raw events", async () => {
    let user = "";
    await generateFindings(input, { model: async (p) => ((user = p.user), { findings: [mf({})], themes: [] }) });
    expect(user).toContain(id("rage_click"));
    expect(user).not.toContain("$session_id");
    expect(user).not.toContain("rage-1");
  });

  it("validates the answer: cited signals must exist, evidence is recomputed, quotes must be real notes", async () => {
    const model = async () =>
      "```json\n" +
      JSON.stringify({
        findings: [
          mf({ signalIds: ["S999"], title: "ghost" }),
          mf({ severity: "low", signalIds: [id("promo_wipe")], segments: ["desktop"], title: "Promo wipes the form", selector: "form" }),
          mf({ signalIds: [id("rage_click"), "S999"], quotes: ["I love this shop"] }),
        ],
        themes: [],
      }) +
      "\n```";
    const res = await generateFindings(input, { model });
    expect(res.path).toBe("custom");
    expect(res.findings.map((f) => [f.id, f.title])).toEqual([["F1", "Continue is invisible"], ["F2", "Promo wipes the form"]]);
    expect(res.findings[0]).toEqual({
      id: "F1", severity: "high", segments: ["low_vision"], personas: ["rosa"], step: "Shipping", page: "/checkout",
      title: "Continue is invisible", suggestedFix: "Big button",
      evidence: { sessions: 2, users: 2, rageClicks: 3, exampleSessions: ["rage-1", "rage-2"], quotes: [] },
    });
    expect(res.findings[1]).toMatchObject({ selector: "form", segments: ["desktop"], evidence: { sessions: 1, exampleSessions: ["promo-1"] } });
  });

  it("falls back to the heuristic on malformed output, errors and timeouts", async () => {
    let calls = 0;
    const bad = await generateFindings(input, { model: async () => (calls++, { findings: [{ severity: "urgent" }] }) });
    expect(calls).toBe(2);
    expect(bad).toMatchObject({ path: "heuristic", themesPath: "heuristic" });
    expect(bad.error).toMatch(/custom failed/);
    expect(bad.findings).toEqual(heuristicFindings({ flow: buyTshirt, kind: "analysis", sessions }, signals));
    expect(await generateFindings(input, { model: async () => { throw new Error("boom"); } })).toMatchObject({ path: "heuristic", error: "custom failed: boom" });
    expect((await generateFindings(input, { timeoutMs: 10, model: () => new Promise(() => {}) })).error).toMatch(/timed out/);
    const dropped = await generateFindings(input, { model: async () => ({ findings: [mf({ signalIds: ["S999"] })] }) });
    expect(dropped.path).toBe("heuristic");
  }, 10_000);

  it("extracts the JSON object from a chatty answer", () => {
    expect(extractJson('Here you go:\n```json\n{"a": "x } y", "b": [{"c": "\\"}"}]}\n```\nDone {not json}')).toEqual({ a: "x } y", b: [{ c: '"}' }] });
  });

  it("uses the heuristic without credentials, and picks auth in order", async () => {
    expect((await generateFindings(input, noLlm)).path).toBe("heuristic");
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }, 1)?.path).toBe("messages-api");
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "t" }, 1)?.path).toBe("agent-sdk");
    expect(modelFromEnv({}, 1)).toBeUndefined();
    expect(AnswerSchema.shape.themes).toBeDefined();
  });
});

describe("themes", () => {
  const sessions = summarizeSessions(buyTshirt, SWARM);
  const signals = frictionSignals(buyTshirt, sessions, { kind: "retest" });
  const input: FindingsInput = { runId: "r1", kind: "retest", flow: buyTshirt, sessions, signals, metrics: computeMetrics(retestConfig, buyTshirt, sessions) };
  const giveUp = signals.find((s) => s.kind === "give_up")!.id;

  it("heuristic: one theme per give-up step on a retest, quoting the reason", () => {
    expect(heuristicThemes("retest", sessions)).toEqual([
      {
        id: "T1", title: "Gave up at Shipping", segments: ["desktop"], personas: ["typical"], sessions: 1,
        quotes: [{ sessionId: "swarm-typical-1", agentId: "typical-1", personaId: "typical", text: "Applying the promo code erased my whole address. I'm not typing it again." }],
      },
    ]);
  });

  it("heuristic: exits per step on an analysis, linked to findings", () => {
    const s = summarizeSessions(buyTshirt, REAL);
    const t = heuristicThemes("analysis", s, [{ id: "F1", step: "Shipping", title: "Hidden button" } as never]);
    expect(t.find((x) => x.title.startsWith("Left at Shipping"))).toMatchObject({ title: "Left at Shipping: Hidden button", sessions: 3, findingIds: ["F1"] });
  });

  it("validates model themes: real give-ups, verbatim quotes, mapped finding ids", async () => {
    const res = await generateFindings(input, {
      model: async () => ({
        findings: [
          { severity: "high", signalIds: [giveUp], segments: ["desktop"], step: "Shipping", page: "/checkout", selector: null, title: "Promo wipes the address", suggestedFix: "Keep it", quotes: ["erased my whole address", "invented"] },
        ],
        themes: [
          { title: "Form wiped", agentIds: ["typical-1", "ghost-1"], quotes: [{ agentId: "typical-1", text: "erased my whole address" }, { agentId: "rosa-1", text: "erased my whole address" }], findingIds: ["F1", "F7"] },
          { title: "Made up", agentIds: ["ghost-2"], quotes: [], findingIds: [] },
        ],
      }),
    });
    expect(res).toMatchObject({ path: "custom", themesPath: "custom" });
    expect(res.findings[0].evidence.quotes).toEqual(["erased my whole address"]);
    expect(res.themes).toEqual([
      {
        id: "T1", title: "Form wiped", segments: ["desktop"], personas: ["typical"], sessions: 1,
        quotes: [{ sessionId: "swarm-typical-1", agentId: "typical-1", personaId: "typical", text: "erased my whole address" }],
        findingIds: ["F1"],
      },
    ]);
  });
});

describe("findings on a fix's retest", () => {
  const sessions = summarizeSessions(buyTshirt, SWARM);
  const signals = frictionSignals(buyTshirt, sessions, { kind: "retest" });
  const fix = {
    attempt: 1,
    summary: "Made Continue bigger",
    targets: [{ id: "F2", title: "Continue is invisible", step: "Shipping", page: "/checkout", suggestedFix: "Big button" }],
  };
  const input: FindingsInput = {
    runId: "r1", kind: "retest", flow: buyTshirt, sessions, signals, fix,
    metrics: computeMetrics(retestConfig, buyTshirt, sessions),
  };
  const mf = (over: object) => ({
    severity: "high", signalIds: [signals[0].id], segments: ["low_vision"], step: "Shipping", page: "/checkout",
    selector: null, title: "Still can't find Continue", suggestedFix: "Pin it", quotes: [], persistsFrom: null, ...over,
  });

  it("tells the model which fix it checks and keeps links to real targets only", async () => {
    let user = "";
    const res = await generateFindings(input, {
      model: async (p) => ((user = p.user), { findings: [mf({ persistsFrom: "F2" }), mf({ persistsFrom: "F9", title: "Other" })], themes: [] }),
    });
    expect(user).toContain("fixUnderTest");
    expect(user).toContain("Made Continue bigger");
    expect(res.findings.map((f) => f.persistsFrom)).toEqual(["F2", undefined]);
  });

  it("accepts answers without persistsFrom", async () => {
    const { persistsFrom: _, ...old } = mf({});
    const res = await generateFindings(input, { model: async () => ({ findings: [old], themes: [] }) });
    expect(res.path).toBe("custom");
    expect(res.findings[0].persistsFrom).toBeUndefined();
  });

  it("heuristic: links a finding on the target's step and element, once per target", () => {
    const f = (id: string, step: string, selector?: string) => ({ ...heuristicFindings({ flow: buyTshirt, kind: "retest", sessions }, signals)[0], id, step, ...(selector ? { selector } : {}) });
    const targets = { attempt: 1, targets: [{ id: "T1", title: "x", step: "Shipping", page: "/checkout", selector: "#continue", suggestedFix: "y" }] };
    expect(linkToTargets([f("F1", "Shipping", "#other"), f("F2", "Shipping", "#continue"), f("F3", "Shipping")], targets).map((x) => x.persistsFrom)).toEqual([
      undefined, "T1", undefined,
    ]);
    expect(linkToTargets([f("F1", "Payment")], targets)[0].persistsFrom).toBeUndefined();
    expect(linkToTargets([f("F1", "Shipping")], undefined)[0].persistsFrom).toBeUndefined();
  });
});

describe("compareSegmentsToPersonas (reference verdict)", () => {
  const before = computeMetrics(analysisConfig, buyTshirt, REAL);
  const after = (agents: string[]) => computeMetrics(retestConfig, buyTshirt, SWARM.filter((e) => agents.includes(e.properties.swarm_agent as string)));

  it("improved: a targeted persona is +20 pts over its segment and nobody is below theirs", () => {
    const v = compareSegmentsToPersonas(before, after(["rosa-1", "typical-1", "typical-2"]), ["rosa"]);
    expect(v.improved).toBe(true);
    expect(v.comparisons.map((c) => [c.personaId, c.segmentId, c.completionDeltaPts, c.regressions])).toEqual([
      ["rosa", "low_vision", 100, []],
      ["kai", "mobile", 0, []],
      ["typical", "desktop", 25, []],
    ]);
    expect(v.reasons[0]).toMatch(/rosa: \+100 pts vs low_vision/);
  });

  it("not improved when the control regresses, even with a big lift", () => {
    const v = compareSegmentsToPersonas(before, after(["rosa-1", "typical-1"]), ["rosa"]);
    expect(v.improved).toBe(false);
    // Payment 0% at n=1 vs 33.3% is within the small-N margin; the completion drop is not.
    expect(v.comparisons.find((c) => c.personaId === "typical")!.regressions).toEqual(["completion 0% < 25%"]);
    expect(v.reasons.some((r) => /typical Payment 0% \(n=1\) vs 33.3%: within small-N margin/.test(r))).toBe(true);
  });

  it("not improved without a +20 pt lift on a targeted persona", () => {
    expect(compareSegmentsToPersonas(before, after(["rosa-1", "typical-1", "typical-2"]), ["kai"]).improved).toBe(false);
  });

  // Funnels as [n, Cart, Shipping, Payment, Confirmation]; completion = Confirmation / n.
  type F = [number, number, number, number, number];
  const group = ([n, ...r]: F) => ({
    n, users: n, completed: r[3], completionRate: r[3] / n, gaveUp: 0, invalidCompletions: 0, medianSteps: 0, medianTimeMs: 0,
    funnel: ["Cart", "Shipping", "Payment", "Confirmation"].map((step, i) => ({ step, reached: r[i], droppedHere: 0 })),
  });
  const segs = (s: Record<string, F>): Metrics => ({
    runId: "a", flowId: "buy-tshirt", buildSha: "p", personas: [],
    segments: Object.entries(s).map(([segmentId, f]) => ({ segmentId: segmentId as "mobile", ...group(f) })),
  });
  const pers = (p: Record<string, F>): Metrics => ({
    runId: "r", flowId: "buy-tshirt", buildSha: "x", segments: [],
    personas: Object.entries(p).map(([personaId, f]) => ({ personaId, ...group(f) })),
  });
  const baseline = segs({ low_vision: [439, 86, 42, 19, 18], mobile: [400, 120, 60, 30, 28], desktop: [100, 20, 18, 16, 15] });

  it("tolerates small-N step dips (one agent = 10 pts) when completion holds", () => {
    const v = compareSegmentsToPersonas(baseline, pers({ rosa: [10, 10, 9, 5, 4], kai: [10, 10, 8, 6, 5], typical: [10, 10, 9, 7, 7] }), ["rosa", "kai"]);
    expect(v.improved).toBe(true);
    expect(v.comparisons.every((c) => c.regressions.length === 0)).toBe(true);
    expect(v.reasons).toContain(
      "rosa Confirmation 80% (n=5) vs 94.7%: within small-N margin (95% upper bound 96.4%, tolerance 15 pts), not a regression",
    );
  });

  it("still fails a real step regression (20% at n=10 vs 90%)", () => {
    const v = compareSegmentsToPersonas(baseline, pers({ rosa: [10, 10, 9, 5, 4], typical: [10, 10, 2, 2, 2] }), ["rosa"]);
    expect(v.improved).toBe(false);
    expect(v.comparisons.find((c) => c.personaId === "typical")!.regressions).toEqual([
      "Shipping conversion 20% (n=10) < 90% (95% upper bound 51%)",
    ]);
  });

  it("still fails any completion-rate drop, and the tolerance and confidence are options", () => {
    const v = compareSegmentsToPersonas(baseline, pers({ rosa: [10, 10, 9, 5, 4], typical: [10, 10, 9, 5, 1] }), ["rosa"]);
    expect(v.improved).toBe(false);
    expect(v.comparisons.find((c) => c.personaId === "typical")!.regressions[0]).toBe("completion 10% < 15%");
    const strict = compareSegmentsToPersonas(baseline, pers({ rosa: [10, 10, 9, 5, 4] }), ["rosa"], { stepTolerancePts: 0, confidence: 0.5 });
    expect(strict.comparisons[0].regressions.map((r) => r.split(" ")[0])).toEqual(["Confirmation"]);
  });
});

describe("analyzeRun / createAnalyzer", () => {
  it("analyzes a retest from its snapshot and writes metrics, findings and themes", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
    const dir = join(runsDir, "r1");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify(retestConfig));
    copyFileSync(join(FX, "swarm.jsonl"), join(dir, "posthog.jsonl"));
    const lines: string[] = [];
    const analyze = createAnalyzer({ runsDir, ...noLlm, log: (l) => lines.push(l) });
    const { metrics, findings } = await analyze("r1");
    const written = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    expect(written("metrics.json") as Metrics).toEqual(metrics);
    expect(written("findings.json")).toEqual(findings);
    expect(written("themes.json")[0].title).toBe("Gave up at Shipping");
    expect(findings[0]).toMatchObject({ step: "Shipping", personas: ["typical"], severity: "high" });
    expect(findings[0].evidence.quotes[0]).toMatch(/erased my whole address/);
    expect(parseJsonl(readFileSync(join(dir, "posthog.jsonl"), "utf8"))).toHaveLength(SWARM.length);
    expect(lines[0]).toMatch(/analyzed r1: 3 sessions, \d+ findings via heuristic/);
  });
});

describe("committed fixtures", () => {
  const RUNS = join(import.meta.dirname, "..", "..", "..", "runs");
  it.each(["fixture-analysis", "fixture-retest"])("%s: metrics, findings and themes are what the analyzer computes on replay", async (id) => {
    const dir = join(RUNS, id);
    const r = await analyzeRun(dir, { ...noLlm, write: false });
    const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    expect(r.metrics).toEqual(read("metrics.json"));
    expect(r.findings).toEqual(read("findings.json"));
    expect(r.themes).toEqual(read("themes.json"));
  });
});
