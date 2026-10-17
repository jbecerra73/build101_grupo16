import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Event, Finding, FixResult, Metrics, RunConfig, RunPhase, RunStatus, StartRunRequest } from "@frictionswarm/shared";
import { startPipeline, type Analyzer, type FixLoop, type StartOptions } from "./pipeline";
import { pickRecording, replaySwarmRunner } from "./replay";
import { fakeFixLoop } from "./fakeFix";
import { REPO_ROOT, RunCapError } from "./runs";

const FIXTURE = join(REPO_ROOT, "runs", "fixture-baseline");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async <T>(f: string): Promise<T> => JSON.parse(await readFile(f, "utf8"));
const lines = async (f: string): Promise<Event[]> =>
  (await readFile(f, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

const req: StartRunRequest = { flowId: "buy-tshirt", personaIds: ["rosa", "kai", "typical"], seedsPerPersona: 2, autoFix: true };

/** Counts agents and successes; writes metrics.json + findings.json like the real analyzer. */
const fakeAnalyzer = (runsDir: string, calls: string[]): Analyzer => async (runId) => {
  calls.push(runId);
  const dir = join(runsDir, runId);
  const files = await readdir(join(dir, "events"));
  const metrics = { runId, flowId: "buy-tshirt", buildSha: "x", personas: [] } as unknown as Metrics;
  const findings: Finding[] = [{ id: "F1", severity: "high", personas: ["rosa"], step: "Shipping", page: "/checkout", title: `${files.length} agents`, evidence: { screenshots: [], quotes: [], agentCount: 1 }, suggestedFix: "" }];
  await writeFile(join(dir, "metrics.json"), JSON.stringify(metrics));
  await writeFile(join(dir, "findings.json"), JSON.stringify(findings));
  return { metrics, findings };
};

/** Mimics runFixLoop's fix.json transitions and calls back into the pipeline. */
const stubFixLoop = (final: "ready" | "not-proven"): FixLoop => async (o) => {
  const dir = join(o.runsDir!, o.baselineRunId);
  const result: FixResult = { baselineRunId: o.baselineRunId, repo: "FrissA/demo-ecommerce", attempts: [{ attempt: 1, findingIds: ["F1"], status: "running" }] };
  const save = () => writeFile(join(dir, "fix.json"), JSON.stringify(result));
  await save();
  Object.assign(result.attempts[0], { status: "draft", prNumber: 41, commitSha: "abcdef1234" });
  await save();
  await sleep(60);
  const base = await json<RunConfig>(join(dir, "config.json"));
  const retest: RunConfig = { ...base, runId: `${base.runId}-retest1`, kind: "retest", baselineRunId: base.runId, seeds: { rosa: [1001], kai: [1001], typical: [1001] } };
  await o.runSwarm(retest);
  await o.analyze(retest.runId);
  Object.assign(result.attempts[0], { status: final, retestRunId: retest.runId });
  await save();
  return result;
};

async function setup(over: StartOptions = {}) {
  const runsDir = await mkdtemp(join(tmpdir(), "fs-pipeline-"));
  const phases: RunPhase[] = [];
  const analyzed: string[] = [];
  const opts: StartOptions = {
    runsDir,
    runSwarm: replaySwarmRunner({ runsDir, speed: 1000, tickMs: 5 }),
    analyze: fakeAnalyzer(runsDir, analyzed),
    verifyBuild: async () => "abc1234",
    fixLoop: stubFixLoop("ready"),
    fixWatchMs: 5,
    onStatus: (s) => phases.push(s.phase),
    ...over,
  };
  return { runsDir, phases, analyzed, opts };
}

describe("startPipeline", () => {
  it("happy path: baseline swarm, analysis, fix loop, retest; phases in order", async () => {
    const { runsDir, phases, analyzed, opts } = await setup();
    const { runId, done } = await startPipeline(req, opts);
    expect(runId).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[0-9a-f]{4}$/);
    const final = await done;

    expect(final).toMatchObject({ phase: "done", retestRunId: `${runId}-retest1` });
    expect(phases).toEqual(["verifying", "swarming", "analyzing", "fixing", "waiting-preview", "retesting", "comparing", "done"]);
    expect(await json<RunStatus>(join(runsDir, runId, "status.json"))).toMatchObject({ phase: "done" });
    expect(analyzed).toEqual([runId, `${runId}-retest1`]);

    const config = await json<RunConfig>(join(runsDir, runId, "config.json"));
    expect(config).toMatchObject({ kind: "baseline", buildSha: "abc1234", seeds: { rosa: [1, 2], kai: [1, 2], typical: [1, 2] } });

    const events = await readdir(join(runsDir, runId, "events"));
    expect(events.sort()).toEqual(["kai-1.jsonl", "kai-2.jsonl", "rosa-1.jsonl", "rosa-2.jsonl", "typical-1.jsonl", "typical-2.jsonl"]);
    const rosa2 = await lines(join(runsDir, runId, "events", "rosa-2.jsonl"));
    expect(rosa2.every((e) => e.runId === runId && e.agentId === "rosa-2" && e.seed === 2)).toBe(true);
    expect(rosa2[0].url).toContain(`swarm=${runId}`);
    const shots = rosa2.flatMap((e) => (e.screenshot ? [e.screenshot] : []));
    expect(shots[0]).toBe("screenshots/rosa-2-000.png");
    expect(await readdir(join(runsDir, runId, "screenshots"))).toEqual(expect.arrayContaining(shots.map((s) => s.slice(12))));

    expect(await readdir(join(runsDir, `${runId}-retest1`, "events"))).toHaveLength(3);
    expect((await json<FixResult>(join(runsDir, runId, "fix.json"))).attempts[0].status).toBe("ready");
  });

  it("without autoFix stops after the report", async () => {
    const { phases, opts } = await setup();
    const final = await (await startPipeline({ ...req, autoFix: false }, opts)).done;
    expect(final.phase).toBe("done");
    expect(phases).toEqual(["verifying", "swarming", "analyzing", "done"]);
  });

  it("not proven still ends the pipeline done, with the honest message", async () => {
    const { opts } = await setup({ fixLoop: stubFixLoop("not-proven") });
    const final = await (await startPipeline(req, opts)).done;
    expect(final).toMatchObject({ phase: "done", message: expect.stringMatching(/not proven/) });
  });

  it("swarm failure ends failed with the error", async () => {
    const { runsDir, phases, analyzed, opts } = await setup({
      runSwarm: async () => {
        throw new Error("sandbox died");
      },
    });
    const { runId, done } = await startPipeline(req, opts);
    expect(await done).toMatchObject({ phase: "failed", error: "sandbox died" });
    expect(phases).toEqual(["verifying", "swarming", "failed"]);
    expect(analyzed).toEqual([]);
    expect(await json<RunStatus>(join(runsDir, runId, "status.json"))).toMatchObject({ phase: "failed", error: "sandbox died" });
  });

  it("fix loop failure ends failed", async () => {
    const { opts } = await setup({ fixLoop: async () => Promise.reject(new Error("gh: not authed")) });
    expect(await (await startPipeline(req, opts)).done).toMatchObject({ phase: "failed", error: "gh: not authed" });
  });

  it("enforces the runs-per-day cap and gives each run fresh seeds", async () => {
    const { runsDir, opts } = await setup();
    const a = await startPipeline({ ...req, autoFix: false }, { ...opts, maxRunsPerDay: 2 });
    const b = await startPipeline({ ...req, autoFix: false }, { ...opts, maxRunsPerDay: 2 });
    await expect(startPipeline(req, { ...opts, maxRunsPerDay: 2 })).rejects.toBeInstanceOf(RunCapError);
    await Promise.all([a.done, b.done]);
    const seeds = await json<RunConfig>(join(runsDir, b.runId, "config.json"));
    expect(seeds.seeds.rosa).toEqual([3, 4]);
    expect(await json(join(runsDir, ".usage.json"))).toMatchObject({ nextSeed: 5 });
  });

  it("rejects invalid requests before using the cap", async () => {
    const { opts } = await setup();
    await expect(startPipeline({ ...req, flowId: "nope" }, opts)).rejects.toThrow(/Unknown flow/);
    await expect(startPipeline({ ...req, personaIds: ["bob"] }, opts)).rejects.toThrow(/Unknown persona/);
    await expect(startPipeline({ ...req, seedsPerPersona: 11 }, opts)).rejects.toThrow(/1 to 10/);
    await expect(startPipeline({ ...req, seedsPerPersona: 0 }, opts)).rejects.toThrow(/1 to 10/);
  });
});

describe("replaySwarmRunner", () => {
  it("replays the 'after' folder for retests, reusing recorded agents round-robin", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "fs-replay-"));
    const after = join(runsDir, "rec-after");
    await cp(FIXTURE, after, { recursive: true });
    await rm(join(after, "events", "kai-2.jsonl"));
    const run = replaySwarmRunner({ runsDir, retestSourceDir: after, speed: 1000, tickMs: 5 });
    const config: RunConfig = {
      runId: "r-retest1", kind: "retest", flowId: "buy-tshirt", personaIds: ["kai"], seeds: { kai: [7, 8] },
      targetUrl: "x", buildSha: "y", baselineRunId: "r", createdAt: "",
    };
    await run(config);
    const kai1 = await lines(join(FIXTURE, "events", "kai-1.jsonl"));
    for (const id of ["kai-7", "kai-8"]) {
      const evs = await lines(join(runsDir, "r-retest1", "events", `${id}.jsonl`));
      expect(evs.map((e) => e.type)).toEqual(kai1.map((e) => e.type));
      expect(evs.every((e) => e.agentId === id && e.runId === "r-retest1")).toBe(true);
    }
    await expect(run({ ...config, personaIds: ["nobody"], seeds: { nobody: [1] } })).rejects.toThrow(/no agents/);
  });

  it("keeps each replayed agent within its seeded action budget", () => {
    const rec = (n: number, id: string): Event[] => [
      { runId: "r", agentId: id, personaId: "kai", seed: 1, ts: 0, type: "page_view", step: "Cart" },
      ...Array.from({ length: n }, (_, i): Event => ({ runId: "r", agentId: id, personaId: "kai", seed: 1, ts: i + 1, type: "action", step: "Cart", action: { kind: "click" } })),
      { runId: "r", agentId: id, personaId: "kai", seed: 1, ts: n + 1, type: "success", step: "Confirmation" },
    ];
    const long = rec(10, "long"), short = rec(8, "short");
    expect(pickRecording([long, short], 0, 12)).toBe(long);
    expect(pickRecording([long, short], 0, 9)).toBe(short);
    const cut = pickRecording([long], 0, 8);
    expect(cut.filter((e) => e.type === "action")).toHaveLength(8);
    expect(cut.at(-1)).toMatchObject({ type: "give_up", note: "Out of actions (budget 8)." });
    expect(cut.some((e) => e.type === "success")).toBe(false);
  });

  it("writes events incrementally, paced by the recording", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "fs-replay-"));
    const config: RunConfig = {
      runId: "live", kind: "baseline", flowId: "buy-tshirt", personaIds: ["typical"], seeds: { typical: [1] },
      targetUrl: "x", buildSha: "y", createdAt: "",
    };
    const total = (await lines(join(FIXTURE, "events", "typical-1.jsonl"))).length;
    const p = replaySwarmRunner({ runsDir, speed: 50, tickMs: 5 })(config);
    await sleep(60);
    const partial = (await lines(join(runsDir, "live", "events", "typical-1.jsonl")).catch(() => [])).length;
    await p;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(total);
    expect(await lines(join(runsDir, "live", "events", "typical-1.jsonl"))).toHaveLength(total);
  });
});

describe("fakeFixLoop (offline rehearsal)", () => {
  it("runs a real retest + verdict through the injected runner and analyzer, no PR", async () => {
    const pm = (personaId: string, completed: number) => ({
      personaId, n: 2, completed, completionRate: completed / 2, gaveUp: 2 - completed, invalidCompletions: 0,
      medianSteps: completed ? 10 : 0, medianTimeMs: completed ? 30_000 : 0, funnel: [],
    });
    const runsDir = await mkdtemp(join(tmpdir(), "fs-rehearsal-"));
    const retests: RunConfig[] = [];
    const replay = replaySwarmRunner({ runsDir, speed: 1000, tickMs: 5 });
    const analyze: Analyzer = async (runId) => {
      const retest = runId.endsWith("-retest1");
      const metrics: Metrics = { runId, flowId: "buy-tshirt", buildSha: "x", personas: [pm("rosa", retest ? 2 : 0), pm("kai", 1), pm("typical", 2)] };
      const findings: Finding[] = [{ id: "F1", severity: "high", personas: ["rosa"], step: "Shipping", page: "/checkout", title: "Tiny continue link", evidence: { screenshots: [], quotes: [], agentCount: 2 }, suggestedFix: "" }];
      await writeFile(join(runsDir, runId, "metrics.json"), JSON.stringify(metrics));
      await writeFile(join(runsDir, runId, "findings.json"), JSON.stringify(findings));
      return { metrics, findings };
    };
    const phases: RunPhase[] = [];
    const { runId, done } = await startPipeline(req, {
      runsDir, analyze, verifyBuild: async () => "abc1234", fixWatchMs: 5, onStatus: (s) => phases.push(s.phase),
      runSwarm: async (c) => {
        if (c.kind === "retest") retests.push(c);
        await replay(c);
      },
      fixLoop: fakeFixLoop({ stageDelayMs: 40 }),
    });
    expect(await done).toMatchObject({ phase: "done", message: expect.stringMatching(/rehearsal/) });
    expect(phases).toEqual(["verifying", "swarming", "analyzing", "fixing", "waiting-preview", "retesting", "comparing", "done"]);

    const base = await json<RunConfig>(join(runsDir, runId, "config.json"));
    expect(retests).toHaveLength(1);
    expect(retests[0]).toMatchObject({ kind: "retest", baselineRunId: runId, runId: `${runId}-retest1` });
    expect(retests[0].seeds.rosa.some((s) => base.seeds.rosa.includes(s))).toBe(false);
    expect(await readdir(join(runsDir, `${runId}-retest1`, "events"))).toHaveLength(6);

    const fix = await json<FixResult>(join(runsDir, runId, "fix.json"));
    expect(fix.attempts[0]).toMatchObject({
      status: "ready", findingIds: ["F1"], prNumber: 0, prUrl: expect.stringContaining("rehearsal"),
      summary: expect.stringContaining("rehearsal"), verdict: { improved: true, targetedPersonas: ["rosa"] },
    });
  });
});
