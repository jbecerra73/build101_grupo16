import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Finding,
  FixResult,
  Metrics,
  PersonaMetrics,
  PostHogEvent,
  RunConfig,
  RunPhase,
  RunStatus,
  SegmentMetrics,
  StartRunRequest,
  Verdict,
} from "@frictionswarm/shared";
import type { PostHogSource } from "@frictionswarm/posthog";
import { fakeFixLoop, pickTargets } from "./fakeFix";
import { realFixLoop, type Analyzer, type Compare, type FixLoop } from "./fixLoop";
import { fixedTrapsFromFix, ingested, offlineSwarmRunner, swarmFile } from "./offline";
import { defaultWindow, startPipeline, validateRequest, type StartOptions } from "./pipeline";
import { RunCapError } from "./runs";
import { trapOf, trapsOf } from "./traps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async <T>(f: string): Promise<T> => JSON.parse(await readFile(f, "utf8"));
const lines = async (f: string): Promise<PostHogEvent[]> =>
  (await readFile(f, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const req: StartRunRequest = { flowId: "buy-tshirt", window: { from: "2026-09-19", to: "2026-10-17" }, source: "file", seedsPerPersona: 2, autoFix: true };

const group = (n: number, completed: number) => ({
  n, users: n, completed, completionRate: n ? completed / n : 0, gaveUp: n - completed, invalidCompletions: 0, medianSteps: 0, medianTimeMs: 0, funnel: [],
});
const seg = (segmentId: SegmentMetrics["segmentId"], rate: number): SegmentMetrics => ({ segmentId, ...group(100, rate * 100) });
const per = (personaId: string, n: number, c: number): PersonaMetrics => ({ personaId, ...group(n, c) });

const F_T1: Finding = {
  id: "F1", severity: "high", segments: ["low_vision"], personas: ["rosa"], step: "Shipping", page: "/checkout",
  selector: "button:has-text('Continue to payment')", title: "Continue to payment is unreadable",
  evidence: { sessions: 40, users: 39, exampleSessions: [], quotes: [] }, suggestedFix: "",
};
const F_T2: Finding = { ...F_T1, id: "F2", segments: ["mobile"], personas: ["kai"], step: "Account", page: "/checkout/account", selector: undefined, title: "Forced sign-up", evidence: { ...F_T1.evidence, sessions: 90 } };
const F_T3: Finding = { ...F_T1, id: "F3", severity: "medium", segments: ["desktop"], personas: ["typical"], step: "Payment", page: "/checkout", selector: undefined, title: "Delivery fee shows up late" };
const F_T4: Finding = { ...F_T1, id: "F4", step: "Product", page: "/shop/product/1", title: "Size picker only opens on hover" };
const F_T5: Finding = { ...F_T1, id: "F5", severity: "low", title: "Applying a promo code wipes the address form" };

/** Writes metrics.json + findings.json like the analyzer; analysis → T1/T2/T3 findings. */
const fakeAnalyzer = (runsDir: string, calls: string[]): Analyzer => async (runId) => {
  calls.push(runId);
  const config = await json<RunConfig>(join(runsDir, runId, "config.json"));
  const analysis = config.kind === "analysis";
  const metrics: Metrics = {
    runId, flowId: config.flowId, buildSha: config.posthog.buildSha,
    segments: analysis ? [seg("low_vision", 0.04), seg("mobile", 0.03), seg("desktop", 0.13)] : [],
    personas: analysis ? [] : config.personaIds.map((p) => per(p, 2, 2)),
  };
  const findings = analysis ? [F_T3, F_T1, F_T2] : [];
  await writeFile(join(runsDir, runId, "metrics.json"), JSON.stringify(metrics));
  await writeFile(join(runsDir, runId, "findings.json"), JSON.stringify(findings));
  return { metrics, findings };
};

const compare: Compare = (a, r, targeted): Verdict => ({
  improved: true, targetedPersonas: targeted, reasons: ["stub"],
  comparisons: r.personas.map((after, i) => ({ personaId: after.personaId, segmentId: a.segments[i].segmentId, before: a.segments[i], after, completionDeltaPts: 50, regressions: [] })),
});

const fakeSource = (waited: string[]): PostHogSource => ({
  realUserEvents: async function* () {},
  swarmEvents: async function* () {},
  waitForSwarm: async (q) => void waited.push(q.runId),
});

async function setup(over: StartOptions = {}) {
  const runsDir = await mkdtemp(join(tmpdir(), "fs-pipeline-"));
  const phases: RunPhase[] = [];
  const analyzed: string[] = [];
  const waited: string[] = [];
  const swarms: RunConfig[] = [];
  const opts: StartOptions = {
    runsDir,
    source: () => fakeSource(waited),
    analyze: fakeAnalyzer(runsDir, analyzed),
    compare,
    runSwarm: async (c) => void swarms.push(c),
    fixLoop: fakeFixLoop({ stageDelayMs: 20 }),
    fixWatchMs: 5,
    onStatus: (s) => phases.push(s.phase),
    ...over,
  };
  return { runsDir, phases, analyzed, waited, swarms, opts };
}

describe("startPipeline", () => {
  it("happy path: analysis, fix, preview, retest, collecting, comparing, done", async () => {
    const { runsDir, phases, analyzed, waited, swarms, opts } = await setup();
    const { runId, done } = await startPipeline(req, opts);
    expect(runId).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[0-9a-f]{4}$/);
    const final = await done;

    expect(final).toMatchObject({ phase: "done", retestRunId: `${runId}-retest1`, message: expect.stringMatching(/rehearsal/) });
    expect(phases).toEqual(["analyzing", "fixing", "waiting-preview", "retesting", "collecting", "comparing", "done"]);
    expect(analyzed).toEqual([runId, `${runId}-retest1`]);
    expect(waited).toEqual([`${runId}-retest1`]);

    const config = await json<RunConfig>(join(runsDir, runId, "config.json"));
    expect(config).toMatchObject({ kind: "analysis", window: req.window, posthog: { source: "file" }, personaIds: [], seeds: {} });
    expect(swarms[0]).toMatchObject({
      kind: "retest", baselineRunId: runId, personaIds: ["rosa", "kai", "typical"],
      seeds: { rosa: [1, 2], kai: [1, 2], typical: [1, 2] }, posthog: { source: "file" },
    });
    const fix = await json<FixResult>(join(runsDir, runId, "fix.json"));
    // The rehearsal fixes the T1 + T2 findings, not the top-severity T3 one.
    expect(fix.attempts[0]).toMatchObject({
      status: "ready", findingIds: ["F2", "F1"], prNumber: 0, summary: expect.stringContaining("rehearsal"),
      verdict: { improved: true, targetedPersonas: ["kai", "rosa"] },
    });
    expect(swarms[0].posthog.buildSha).toBe(fix.attempts[0].commitSha);
  });

  it("without autoFix stops after the report", async () => {
    const { phases, opts } = await setup();
    const final = await (await startPipeline({ ...req, autoFix: false }, opts)).done;
    expect(final).toMatchObject({ phase: "done", message: "Report ready: 3 findings" });
    expect(phases).toEqual(["analyzing", "done"]);
  });

  it("not proven still ends done, with the honest message", async () => {
    const { opts } = await setup({ compare: (a, r, t) => ({ ...compare(a, r, t), improved: false }) });
    const final = await (await startPipeline(req, opts)).done;
    expect(final).toMatchObject({ phase: "done", message: expect.stringMatching(/not proven/) });
  });

  it("analysis failure ends failed with the error", async () => {
    const { runsDir, phases, opts } = await setup({ analyze: async () => Promise.reject(new Error("no PostHog data")) });
    const { runId, done } = await startPipeline(req, opts);
    expect(await done).toMatchObject({ phase: "failed", error: "no PostHog data" });
    expect(phases).toEqual(["analyzing", "failed"]);
    expect(await json<RunStatus>(join(runsDir, runId, "status.json"))).toMatchObject({ phase: "failed" });
  });

  it("collecting timeout ends failed during collecting", async () => {
    const { opts } = await setup({
      source: () => ({ ...fakeSource([]), waitForSwarm: async () => Promise.reject(new Error("waitForSwarm timed out")) }),
    });
    expect(await (await startPipeline(req, opts)).done).toMatchObject({ phase: "failed", error: "waitForSwarm timed out", message: "Failed during collecting" });
  });

  it("cancel aborts the current phase", async () => {
    const controller = new AbortController();
    const { opts } = await setup({ signal: controller.signal, runSwarm: () => new Promise(() => {}) });
    const { done } = await startPipeline(req, opts);
    await sleep(150);
    controller.abort();
    expect(await done).toMatchObject({ phase: "failed", error: "cancelled", message: "Cancelled during retesting" });
  });

  it("enforces the runs-per-day cap and gives every retest fresh seeds", async () => {
    const { runsDir, swarms, opts } = await setup();
    const a = await startPipeline(req, { ...opts, maxRunsPerDay: 2 });
    const b = await startPipeline(req, { ...opts, maxRunsPerDay: 2 });
    await expect(startPipeline(req, { ...opts, maxRunsPerDay: 2 })).rejects.toBeInstanceOf(RunCapError);
    await Promise.all([a.done, b.done]);
    expect(swarms.map((s) => s.seeds.rosa).sort()).toEqual([[1, 2], [3, 4]]);
    expect(await json(join(runsDir, ".usage.json"))).toMatchObject({ nextSeed: 5 });
  });

  it("rejects invalid requests before using the cap", async () => {
    const { opts } = await setup();
    await expect(startPipeline({ ...req, flowId: "nope" }, opts)).rejects.toThrow(/Unknown flow/);
    await expect(startPipeline({ ...req, seedsPerPersona: 11 }, opts)).rejects.toThrow(/1 to 10/);
    await expect(startPipeline({ ...req, window: { from: "2026-10-17", to: "2026-10-01" } }, opts)).rejects.toThrow(/before/);
    expect(() => validateRequest({ ...req, source: "s3" as never })).toThrow(/Unknown source/);
  });

  it("defaults to the last 28 days, today included", () => {
    expect(defaultWindow(new Date("2026-10-17T15:00:00Z"))).toEqual({ from: "2026-09-20", to: "2026-10-18" });
  });
});

describe("traps", () => {
  it("maps findings to the trap they describe", () => {
    expect([F_T1, F_T2, F_T3, F_T4, F_T5].map(trapOf)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(trapsOf([F_T2, F_T1, F_T2])).toEqual(["T1", "T2"]);
  });

  it("the rehearsal picks the T1/T2 findings, else the top ones", () => {
    expect(pickTargets([F_T3, F_T1, F_T2, F_T4], ["T1", "T2"], 3).map((f) => f.id)).toEqual(["F2", "F1"]);
    expect(pickTargets([F_T5, F_T3], ["T1", "T2"], 1).map((f) => f.id)).toEqual(["F3"]);
  });

  it("reads the fixed traps from the baseline's fix.json", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "fs-traps-"));
    await writeFile(join(runsDir, "x"), "");
    const base = join(runsDir, "a");
    await import("node:fs/promises").then((fs) => fs.mkdir(base));
    await writeFile(join(base, "findings.json"), JSON.stringify([F_T1, F_T2, F_T3]));
    await writeFile(join(base, "fix.json"), JSON.stringify({ baselineRunId: "a", repo: "r", attempts: [{ attempt: 1, findingIds: ["F1", "F3"], retestRunId: "a-retest1", status: "retesting" }] }));
    const cfg = { runId: "a-retest1", baselineRunId: "a" } as RunConfig;
    expect(await fixedTrapsFromFix(runsDir, cfg)).toEqual(["T1", "T3"]);
  });
});

describe("offlineSwarmRunner", () => {
  const retest = (seeds: number[]): RunConfig => ({
    runId: "r-retest1", kind: "retest", flowId: "buy-tshirt", posthog: { source: "file", buildSha: "abc1234" },
    personaIds: ["rosa", "kai", "typical"], seeds: { rosa: seeds, kai: seeds, typical: seeds },
    targetUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app", baselineRunId: "r", createdAt: "",
  });

  it("plays the agents out: screenshots while they shop, PostHog events after an ingestion lag", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "fs-offline-"));
    const dataDir = join(runsDir, "data");
    const config = retest([1, 2]);
    const run = offlineSwarmRunner({ runsDir, dataDir, durationMs: 600, ingestLagMs: 300, bootMs: 0, tickMs: 10, fixedTraps: async () => ["T1", "T2"] });
    const p = run(config);
    await sleep(250);
    const midShots = await readdir(join(runsDir, "r-retest1", "screenshots"));
    const midEvents = (await lines(swarmFile(dataDir, "r-retest1"))).length;
    await p;
    const afterRun = (await lines(swarmFile(dataDir, "r-retest1"))).length;
    await ingested("r-retest1");
    const events = await lines(swarmFile(dataDir, "r-retest1"));

    expect(midShots.length).toBeGreaterThan(0);
    expect(midEvents).toBeLessThan(events.length);
    expect(afterRun).toBeLessThan(events.length); // still ingesting when the agents are done
    expect((await readdir(join(runsDir, "r-retest1", "screenshots"))).sort()).toEqual(
      ["kai-1.png", "kai-2.png", "rosa-1.png", "rosa-2.png", "typical-1.png", "typical-2.png"],
    );
    expect(new Set(events.map((e) => e.properties.swarm_agent))).toEqual(new Set(["rosa-1", "rosa-2", "kai-1", "kai-2", "typical-1", "typical-2"]));
    expect(events.every((e) => e.properties.swarm_run === "r-retest1" && e.properties.build_sha === "abc1234")).toBe(true);
    expect(events.every((e) => String(e.properties.$current_url).startsWith("https://deploy-preview-12--swarm-ecommerce.netlify.app/"))).toBe(true);
    // Every agent ends with swarm_done or swarm_give_up, and nobody meets the fixed sign-up wall.
    for (const a of new Set(events.map((e) => e.properties.swarm_agent)))
      expect(events.some((e) => e.properties.swarm_agent === a && (e.event === "swarm_done" || e.event === "swarm_give_up"))).toBe(true);
    expect(events.some((e) => e.properties.$pathname === "/checkout/account")).toBe(false);
    const topo = await json<{ backend: string; sandboxes: { status: string }[] }>(join(runsDir, "r-retest1", "swarm.json"));
    expect(topo).toMatchObject({ backend: "offline" });
    expect(topo.sandboxes.every((s) => s.status === "done")).toBe(true);
  });

  it("fixing T1 + T2 lifts Rosa and Kai on the preview; the unfixed store keeps them stuck", async () => {
    const seeds = Array.from({ length: 10 }, (_, i) => 101 + i);
    const rate = async (fixed: ("T1" | "T2")[]) => {
      const runsDir = await mkdtemp(join(tmpdir(), "fs-offline-"));
      const dataDir = join(runsDir, "data");
      await offlineSwarmRunner({ runsDir, dataDir, durationMs: 50, ingestLagMs: 0, bootMs: 0, tickMs: 5, fixedTraps: async () => fixed })(retest(seeds));
      await ingested("r-retest1");
      const events = await lines(swarmFile(dataDir, "r-retest1"));
      const ok = (p: string) => new Set(events.filter((e) => e.properties.swarm_persona === p && e.event === "order_completed").map((e) => e.properties.swarm_agent)).size / 10;
      return { rosa: ok("rosa"), kai: ok("kai"), typical: ok("typical") };
    };
    const before = await rate([]);
    const after = await rate(["T1", "T2"]);
    expect(after.rosa - before.rosa).toBeGreaterThanOrEqual(0.3);
    expect(after.kai - before.kai).toBeGreaterThanOrEqual(0.3);
    expect(after.typical).toBeGreaterThanOrEqual(0.6);
  });

  it("stops on cancel", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "fs-offline-"));
    const c = new AbortController();
    const p = offlineSwarmRunner({ runsDir, dataDir: join(runsDir, "data"), durationMs: 5_000, bootMs: 0, tickMs: 10, signal: c.signal, fixedTraps: async () => [] })(retest([1]));
    await sleep(50);
    c.abort();
    await expect(p).rejects.toThrow("cancelled");
  });
});

describe("realFixLoop", () => {
  it("fails clearly when P1's fix loop is not there", async () => {
    const loop: FixLoop = realFixLoop("/nonexistent/orchestrator/fix-loop.ts");
    await expect(loop({} as Parameters<FixLoop>[0])).rejects.toThrow(/P1 fix loop not available/);
  });
});
