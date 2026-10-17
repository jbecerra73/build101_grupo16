import { appendFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buyTshirt, type Event, type Metrics, type RunConfig } from "@frictionswarm/shared";
import {
  computeMetrics,
  createAnalyzer,
  extractJson,
  frictionSignals,
  generateFindings,
  heuristicFindings,
  modelFromEnv,
  parseJsonl,
  readRun,
  validateCompletion,
} from "../src";

const FIXTURE = join(import.meta.dirname, "..", "..", "..", "runs", "fixture-baseline");
const fx = (name: string) => parseJsonl<Event>(readFileSync(join(import.meta.dirname, "fixtures", `${name}.jsonl`), "utf8"));
const config = (personaIds: string[]): RunConfig => ({
  runId: "t", kind: "baseline", flowId: "buy-tshirt", personaIds, seeds: {}, targetUrl: "x", buildSha: "sha", createdAt: "",
});
const run = readRun(FIXTURE);
const noLlm = { env: {} };

describe("validateCompletion", () => {
  it("accepts a full, echoed checkout", () => {
    expect(validateCompletion(buyTshirt, fx("valid-success"))).toEqual({ valid: true, reasons: [] });
  });
  it("rejects a give-up", () => {
    const v = validateCompletion(buyTshirt, fx("give-up"));
    expect(v.valid).toBe(false);
    expect(v.reasons).toContain("no success event");
  });
  it("rejects a shortcut to confirmation", () => {
    const v = validateCompletion(buyTshirt, fx("shortcut"));
    expect(v.valid).toBe(false);
    expect(v.reasons.join()).toMatch(/skipped required step\(s\): Shipping, Payment/);
    expect(v.reasons.join()).toMatch(/not filled: fullName, address, city, postalCode, country, cardNumber/);
  });
  it("rejects a missing required field", () => {
    expect(validateCompletion(buyTshirt, fx("missing-field")).reasons).toEqual(["required field(s) not filled: postalCode"]);
  });
  it("rejects a confirmation that doesn't echo what was typed", () => {
    const { valid, reasons } = validateCompletion(buyTshirt, fx("mismatched-echo"));
    expect(valid).toBe(false);
    expect(reasons).toHaveLength(2);
    expect(reasons.join()).toMatch(/address.*9 Elm Rd/);
    expect(reasons.join()).toMatch(/last 4 "4242".*"1111"/);
  });
  it("rejects the fixture's Kai shortcut", () => {
    expect(validateCompletion(buyTshirt, run.byAgent.get("kai-2")!).valid).toBe(false);
    expect(validateCompletion(buyTshirt, run.byAgent.get("typical-1")!).valid).toBe(true);
  });
});

describe("computeMetrics", () => {
  it("reproduces runs/fixture-baseline/metrics.json exactly", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURE, "metrics.json"), "utf8"));
    expect(computeMetrics(run.config, buyTshirt, run.events)).toEqual(expected);
  });

  it("counts completions, give-ups, invalid completions and drop-offs per persona", () => {
    const events = [...fx("valid-success"), ...fx("give-up"), ...fx("shortcut")];
    const m = computeMetrics(config(["typical", "rosa", "kai"]), buyTshirt, events);
    const [typical, rosa, kai] = m.personas;
    expect(typical).toMatchObject({ n: 1, completed: 1, completionRate: 1, medianSteps: 10, medianTimeMs: 13500 });
    expect(rosa).toMatchObject({ n: 1, completed: 0, gaveUp: 1, medianSteps: 0, medianTimeMs: 0 });
    expect(rosa.funnel.find((f) => f.step === "Shipping")).toEqual({ step: "Shipping", reached: 1, droppedHere: 1 });
    expect(kai).toMatchObject({ completed: 0, invalidCompletions: 1 });
    expect(kai.funnel.find((f) => f.step === "Confirmation")?.droppedHere).toBe(1);
    // Funnel: steps reached by someone, plus required ones
    expect(typical.funnel.map((f) => f.step)).toEqual(["Cart", "Shipping", "Payment", "Confirmation"]);
  });

  it("takes medians over valid completions only", () => {
    const slow = fx("valid-success").map((e) => ({ ...e, agentId: "typical-8", seed: 8, ts: e.ts * 3 }));
    const m = computeMetrics(config(["typical"]), buyTshirt, [...fx("valid-success"), ...slow, ...fx("missing-field").map((e) => ({ ...e, agentId: "typical-9" }))]);
    expect(m.personas[0]).toMatchObject({ n: 3, completed: 2, medianSteps: 10, medianTimeMs: (13500 + 40500) / 2 });
  });
});

describe("readRun", () => {
  it("tolerates a half-written last line and missing optional files", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-"));
    cpSync(join(FIXTURE, "config.json"), join(dir, "config.json"));
    cpSync(join(FIXTURE, "events"), join(dir, "events"), { recursive: true });
    appendFileSync(join(dir, "events", "kai-2.jsonl"), '\n{"runId":"fixture-baseline","agentId":"kai-2","ts":17');
    const r = readRun(dir);
    expect(r.events).toHaveLength(run.events.length);
    expect(r.metrics).toBeUndefined();
    expect(r.findings).toBeUndefined();
  });
});

describe("frictionSignals", () => {
  it("finds repeat clicks, back-and-forth and give-ups with the nearest screenshot", () => {
    const s = frictionSignals(buyTshirt, fx("give-up"));
    expect(s.find((x) => x.kind === "repeat_click")).toMatchObject({ selector: "#promo", count: 3, step: "Shipping", page: "/checkout", screenshot: "screenshots/rosa-7-001.png" });
    expect(s.filter((x) => x.kind === "back_and_forth").map((x) => x.note)).toEqual(["Cart → Shipping → Cart", "Shipping → Cart → Shipping"]);
    expect(s.find((x) => x.kind === "give_up")).toMatchObject({ agentId: "rosa-7", screenshot: "screenshots/rosa-7-003.png" });
  });
  it("finds the fixture's missed tap", () => {
    expect(frictionSignals(buyTshirt, run.events).find((x) => x.kind === "missed_tap")).toMatchObject({
      agentId: "kai-1", step: "Product", page: "/shop/product/*", selector: "button[data-size='Medium']", screenshot: "screenshots/kai-1-000.png",
    });
  });
});

describe("findings", () => {
  const metrics = computeMetrics(run.config, buyTshirt, run.events);

  it("heuristic surfaces the Rosa 'Continue to payment' give-up and the Kai account wall", () => {
    const f = heuristicFindings(buyTshirt, run.events, frictionSignals(buyTshirt, run.events));
    const rosa = f.find((x) => x.personas.includes("rosa") && x.step === "Shipping")!;
    expect(rosa).toMatchObject({ severity: "high", page: "/checkout", selector: "a:has-text('Continue to payment')" });
    expect(rosa.evidence.quotes).toContain("I can't find how to continue to payment. There is no button I can read.");
    expect(rosa.evidence.screenshots).toContain("screenshots/rosa-1-004.png");
    const kai = f.find((x) => x.personas.includes("kai") && x.step === "Account")!;
    expect(kai).toMatchObject({ severity: "high", page: "/checkout/account" });
    expect(kai).not.toHaveProperty("selector");
    expect(kai.evidence.quotes).toContain("9 fields just to buy a shirt?? no way");
    expect(f.slice(0, 2).map((x) => x.step).sort()).toEqual(["Account", "Shipping"]);
    expect(f.map((x) => x.id)).toEqual(f.map((_, i) => `F${i + 1}`));
  });

  it("validates model output and drops invented evidence", async () => {
    const model = async () =>
      "```json\n" +
      JSON.stringify({
        findings: [
          { severity: "high", personas: ["ghost"], step: "Cart", page: "/cart", selector: null, title: "unknown persona", evidence: { screenshots: [], quotes: [], agentCount: 1 }, suggestedFix: "x" },
          {
            severity: "high", personas: ["rosa", "ghost"], step: "Shipping", page: "/checkout", selector: "a:has-text('Continue to payment')",
            title: "Invisible continue link",
            evidence: { screenshots: ["screenshots/rosa-1-004.png", "screenshots/made-up.png"], quotes: ["There is no button I can read.", "I love this shop"], agentCount: 40 },
            suggestedFix: "High-contrast button",
          },
          { severity: "low", personas: ["kai"], step: "Product", page: "/shop/product/*", selector: null, title: "Small sizes", evidence: { screenshots: [], quotes: [], agentCount: 1 }, suggestedFix: "44px" },
        ],
      }) +
      "\n```";
    const { findings, path } = await generateFindings(run, metrics, { flow: buyTshirt, model });
    expect(path).toBe("custom");
    expect(findings.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(findings[0]).toEqual({
      id: "F1", severity: "high", personas: ["rosa"], step: "Shipping", page: "/checkout", selector: "a:has-text('Continue to payment')",
      title: "Invisible continue link",
      evidence: { screenshots: ["screenshots/rosa-1-004.png"], quotes: ["There is no button I can read."], agentCount: 4 },
      suggestedFix: "High-contrast button",
    });
    expect(findings[1]).not.toHaveProperty("selector");
  });

  it("falls back to the heuristic on malformed output or errors", async () => {
    let calls = 0;
    const bad = await generateFindings(run, metrics, { flow: buyTshirt, model: async () => (calls++, { findings: [{ severity: "urgent" }] }) });
    expect(calls).toBe(2);
    expect(bad.path).toBe("heuristic");
    expect(bad.error).toMatch(/custom failed/);
    expect(bad.findings.length).toBeGreaterThan(0);
    const thrown = await generateFindings(run, metrics, { flow: buyTshirt, model: async () => { throw new Error("boom"); } });
    expect(thrown).toMatchObject({ path: "heuristic", error: "custom failed: boom" });
    const slow = await generateFindings(run, metrics, { flow: buyTshirt, timeoutMs: 10, model: () => new Promise(() => {}) });
    expect(slow.error).toMatch(/timed out/);
  }, 10_000);

  it("accepts an explicit empty answer, but not one whose findings were all dropped", async () => {
    let calls = 0;
    const empty = await generateFindings(run, metrics, { flow: buyTshirt, model: async () => (calls++, { findings: [] }) });
    expect(empty).toEqual({ findings: [], path: "custom" });
    expect(calls).toBe(1);
    const ghost = { severity: "low", personas: ["ghost"], step: "Cart", page: "/cart", selector: null, title: "x", evidence: { screenshots: [], quotes: [], agentCount: 1 }, suggestedFix: "y" };
    const dropped = await generateFindings(run, metrics, { flow: buyTshirt, model: async () => ({ findings: [ghost] }) });
    expect(dropped.path).toBe("heuristic");
  });

  it("extracts the JSON object from a chatty answer", () => {
    expect(extractJson('Here you go:\n```json\n{"a": "x } y", "b": [{"c": "\\"}"}]}\n```\nDone {not json}')).toEqual({ a: "x } y", b: [{ c: '"}' }] });
  });

  it("uses the heuristic without credentials, and picks auth in order", async () => {
    expect((await generateFindings(run, metrics, { flow: buyTshirt, ...noLlm })).path).toBe("heuristic");
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }, 1)?.path).toBe("messages-api");
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "t" }, 1)?.path).toBe("agent-sdk");
    expect(modelFromEnv({}, 1)).toBeUndefined();
  });
});

describe("createAnalyzer", () => {
  it("writes metrics.json + findings.json for a run id", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "analyzer-runs-"));
    cpSync(FIXTURE, join(runsDir, "fixture-baseline"), { recursive: true });
    const analyze = createAnalyzer({ runsDir, ...noLlm });
    const { metrics, findings } = await analyze("fixture-baseline");
    const written = (f: string) => JSON.parse(readFileSync(join(runsDir, "fixture-baseline", f), "utf8"));
    expect(written("metrics.json") as Metrics).toEqual(metrics);
    expect(written("findings.json")).toEqual(findings);
    expect(findings.length).toBeGreaterThan(0);
  });
});
