import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding, FixResult, Metrics, RunConfig, RunStatus, StartRunRequest } from "@frictionswarm/shared";
import { FsStore, MemoryStore, type OrchestratorHeartbeat, type QueuedRun, type Settings, type SwarmTopology } from "@frictionswarm/store";
import { Orchestrator, RESTARTED, type DepsFactory } from "./daemon";
import { fakeFixLoop } from "./fakeFix";
import type { Analyzer, Compare } from "./fixLoop";
import { RunMirror } from "./mirror";
import { ingested, offlineSwarmRunner } from "./offline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req: StartRunRequest = { flowId: "buy-tshirt", seedsPerPersona: 2, autoFix: true };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(15);
  }
}

const group = (n: number, completed: number) => ({
  n, users: n, completed, completionRate: n ? completed / n : 0, gaveUp: n - completed, invalidCompletions: 0, medianSteps: 0, medianTimeMs: 0, funnel: [],
});

/** metrics.json + findings.json + posthog.jsonl like the analyzer. */
const fakeAnalyzer = (runsDir: string): Analyzer => async (runId) => {
  const config = JSON.parse(await readFile(join(runsDir, runId, "config.json"), "utf8")) as RunConfig;
  const metrics: Metrics = {
    runId, flowId: config.flowId, buildSha: config.posthog.buildSha,
    segments: config.kind === "analysis" ? [{ segmentId: "low_vision", ...group(50, 2) }, { segmentId: "mobile", ...group(50, 2) }, { segmentId: "desktop", ...group(50, 7) }] : [],
    personas: config.kind === "retest" ? config.personaIds.map((personaId) => ({ personaId, ...group(2, 2) })) : [],
  };
  const findings: Finding[] = config.kind === "analysis"
    ? [{ id: "F1", severity: "high", segments: ["low_vision"], personas: ["rosa"], step: "Shipping", page: "/checkout", title: "Continue link unreadable", evidence: { sessions: 9, users: 9, exampleSessions: [], quotes: [] }, suggestedFix: "" }]
    : [];
  await writeFile(join(runsDir, runId, "metrics.json"), JSON.stringify(metrics));
  await writeFile(join(runsDir, runId, "findings.json"), JSON.stringify(findings));
  await writeFile(join(runsDir, runId, "posthog.jsonl"), "{}\n");
  return { metrics, findings };
};

const compare: Compare = (a, r, targetedPersonas) => ({
  improved: true, targetedPersonas, reasons: [],
  comparisons: r.personas.map((after, i) => ({ personaId: after.personaId, segmentId: a.segments[i].segmentId, before: a.segments[i], after, completionDeltaPts: 50, regressions: [] })),
});

function setup(o: { store?: MemoryStore | FsStore; workDir?: string; durationMs?: number; settingsSeen?: Settings[]; idleExitMs?: number; onIdle?: (why: "idle" | "deadline") => void; deadline?: number; drainMs?: number } = {}) {
  return (async () => {
    const workDir = o.workDir ?? (await mkdtemp(join(tmpdir(), "fs-daemon-")));
    cleanup.push(() => rm(workDir, { recursive: true, force: true }));
    const store = o.store ?? new MemoryStore();
    const makeDeps: DepsFactory = (settings, { workDir, signal }) => {
      o.settingsSeen?.push(settings);
      return {
        runsDir: workDir,
        source: () => ({
          realUserEvents: async function* () {},
          swarmEvents: async function* () {},
          waitForSwarm: (q) => ingested(q.runId),
        }),
        runSwarm: offlineSwarmRunner({ runsDir: workDir, dataDir: join(workDir, ".data"), durationMs: o.durationMs ?? 60, ingestLagMs: 20, bootMs: 0, tickMs: 5, signal }),
        analyze: fakeAnalyzer(workDir),
        compare,
        fixLoop: fakeFixLoop({ stageDelayMs: 5 }),
        fixWatchMs: 5,
      };
    };
    const orch = new Orchestrator({ store, workDir, makeDeps, pollMs: 20, heartbeatMs: 50, log: () => {}, env: {}, idleExitMs: o.idleExitMs, onIdle: o.onIdle, deadline: o.deadline, drainMs: o.drainMs });
    cleanup.push(() => orch.stop({ abort: true, wait: true }));
    return { store, workDir, orch };
  })();
}

const enqueue = async (store: MemoryStore | FsStore, runId: string, r: StartRunRequest = req) => {
  const q: QueuedRun = { requestId: `q-${runId}`, runId, req: r, requestedAt: new Date().toISOString() };
  await store.putJson(`queue/${q.requestId}.json`, q);
  return q;
};
const status = (store: MemoryStore | FsStore, runId: string) => store.getJson<RunStatus>(`runs/${runId}/status.json`);

describe("orchestrator daemon", () => {
  it("calls onIdle once after idleExitMs with nothing running or queued, not while a run is going", async () => {
    let idle = 0;
    const { store, orch } = await setup({ idleExitMs: 150, durationMs: 300, onIdle: () => void idle++ });
    await enqueue(store, "r-idle");
    await orch.start();
    await until(async () => (await status(store, "r-idle"))?.phase === "retesting");
    expect(idle).toBe(0);
    await until(async () => idle > 0);
    expect((await status(store, "r-idle"))?.phase).toBe("done");
    await sleep(300);
    expect(idle).toBe(1);
  });

  it("near the sandbox's deadline takes no new run, lets the active one finish, then exits", async () => {
    const exits: string[] = [];
    const { store, orch } = await setup({ durationMs: 300, deadline: Date.now() + 60 * 60_000, drainMs: 60 * 60_000 - 500, onIdle: (why) => void exits.push(why) });
    await enqueue(store, "r-first");
    await orch.start();
    await until(async () => (await status(store, "r-first"))?.phase === "retesting");
    // Draining from here on: the second run stays queued.
    await sleep(600);
    await enqueue(store, "r-second");
    await until(async () => exits.length > 0);
    expect(exits).toEqual(["deadline"]);
    expect((await status(store, "r-first"))?.phase).toBe("done");
    expect(await status(store, "r-second")).toBeUndefined();
    expect(await store.list("queue/")).toEqual(["queue/q-r-second.json"]);
  });

  it("ignores a queued-only cancel (Clear queue) once the run has started", async () => {
    const { store, orch } = await setup({ durationMs: 200 });
    await enqueue(store, "r-kept");
    await orch.start();
    await until(async () => orch.active.has("r-kept"));
    await store.putJson("runs/r-kept/cancel.json", { runId: "r-kept", requestedAt: new Date().toISOString(), queuedOnly: true });
    const final = await until(async () => {
      const s = await status(store, "r-kept");
      return s && (s.phase === "done" || s.phase === "failed") && s;
    });
    expect(final.phase).toBe("done");
  });

  it("takes a queued run, runs the pipeline and mirrors every run file to the store", async () => {
    const { store, workDir, orch } = await setup();
    await enqueue(store, "r1");
    await orch.start();
    const final = await until(async () => {
      const s = await status(store, "r1");
      return s && (s.phase === "done" || s.phase === "failed") && s;
    });
    expect(final).toMatchObject({ phase: "done" });
    await until(async () => !orch.active.size);

    expect(await store.list("queue/")).toEqual([]);
    const keys = await store.list("runs/r1/");
    for (const f of ["config.json", "request.json", "status.json", "metrics.json", "findings.json", "fix.json", "posthog.jsonl"])
      expect(keys).toContain(`runs/r1/${f}`);
    expect(await store.getJson("runs/r1/config.json")).toMatchObject({ kind: "analysis", posthog: { source: "file" } });

    const fix = (await store.getJson<FixResult>("runs/r1/fix.json"))!;
    const retestId = fix.attempts[0].retestRunId!;
    expect(retestId).toBe("r1-retest1");
    const retestKeys = await store.list(`runs/${retestId}/`);
    expect(retestKeys).toEqual(expect.arrayContaining([`runs/${retestId}/config.json`, `runs/${retestId}/metrics.json`, `runs/${retestId}/swarm.json`]));
    // screenshots of the retest swarm are mirrored with the same bytes
    const shots = retestKeys.filter((k) => k.endsWith(".png"));
    expect(shots.map((k) => k.split("/").at(-1)).sort()).toEqual(["kai-1.png", "kai-2.png", "rosa-1.png", "rosa-2.png", "typical-1.png", "typical-2.png"]);
    expect(await store.getBytes(shots[0])).toEqual(new Uint8Array(await readFile(join(workDir, retestId, "screenshots", shots[0].split("/").at(-1)!))));

    const topo = (await store.getJson<SwarmTopology>(`runs/${retestId}/swarm.json`))!;
    expect(topo).toMatchObject({ runId: retestId, backend: "offline" });
    expect(topo.sandboxes).toHaveLength(5);
    expect(topo.sandboxes.flatMap((s) => s.agentIds).sort()).toEqual(["kai-1", "kai-2", "rosa-1", "rosa-2", "typical-1", "typical-2"]);
    for (const s of topo.sandboxes) {
      expect(s.agentIds.length).toBeLessThanOrEqual(6);
      expect(s.status).toBe("done");
    }

    expect(await store.getJson("usage.json")).toMatchObject({ runs: 1, nextSeed: 3 });
    await orch.heartbeat();
    expect(await store.getJson<OrchestratorHeartbeat>("orchestrator.json")).toMatchObject({ host: "local", activeRunIds: [], queueDepth: 0 });
  });

  it("passes settings.json to the pipeline wiring and enforces the daily cap", async () => {
    const seen: Settings[] = [];
    const { store, orch } = await setup({ settingsSeen: seen });
    await store.putJson("settings.json", { swarmSpeed: 7, maxRunsPerDay: 1 });
    await store.putJson("usage.json", { date: new Date().toISOString().slice(0, 10), runs: 1, nextSeed: 10 });
    await enqueue(store, "capped");
    await orch.start();
    const s = await until(() => status(store, "capped"));
    expect(s).toMatchObject({ phase: "failed", error: "Run cap reached: 1/1 runs today" });
    expect(await store.list("queue/")).toEqual([]);
    expect(seen).toEqual([]);

    await store.putJson("settings.json", { swarmSpeed: 7, maxRunsPerDay: 5 });
    await enqueue(store, "ok");
    await until(async () => (await status(store, "ok"))?.phase === "done");
    expect(seen[0]).toMatchObject({ swarmSpeed: 7, maxRunsPerDay: 5 });
  });

  it("refuses an invalid queued request without running it", async () => {
    const { store, orch } = await setup();
    await enqueue(store, "bad", { ...req, flowId: "nope" });
    await orch.start();
    expect(await until(() => status(store, "bad"))).toMatchObject({ phase: "failed", error: 'Unknown flow "nope"' });
  });

  it("cancels a running run when cancel.json appears", async () => {
    const { store, orch } = await setup({ durationMs: 20_000 });
    await enqueue(store, "c1");
    await orch.start();
    await until(async () => (await status(store, "c1"))?.phase === "retesting");
    await store.putJson("runs/c1/cancel.json", { runId: "c1", requestedAt: new Date().toISOString() });
    const s = await until(async () => {
      const s = await status(store, "c1");
      return s?.phase === "failed" && s;
    });
    expect(s).toMatchObject({ phase: "failed", error: "cancelled" });
    await until(async () => !orch.active.size);
    await until(async () => {
      const topo = await store.getJson<SwarmTopology>("runs/c1-retest1/swarm.json");
      return topo?.sandboxes.every((x) => x.status === "closed" || x.status === "done");
    });
    expect(await store.getJson("runs/c1-retest1/metrics.json")).toBeUndefined();
  });

  it("drops a queued run that was cancelled before it started", async () => {
    const { store, orch } = await setup();
    await enqueue(store, "early");
    await store.putJson("runs/early/cancel.json", { runId: "early", requestedAt: new Date().toISOString() });
    await orch.start();
    expect(await until(() => status(store, "early"))).toMatchObject({ phase: "failed", error: "cancelled" });
  });

  it("marks runs left mid-flight by a previous orchestrator as failed on boot", async () => {
    const { store, orch } = await setup();
    const at = new Date().toISOString();
    await store.putJson("orchestrator.json", { host: "tenki", version: "x", startedAt: at, lastSeenAt: at, activeRunIds: ["gone"], queueDepth: 0 });
    await store.putJson("runs/gone/config.json", { runId: "gone" });
    await store.putJson("runs/gone/status.json", { runId: "gone", phase: "fixing", updatedAt: at });
    await store.putJson("runs/stale/config.json", { runId: "stale" });
    await store.putJson("runs/stale/status.json", { runId: "stale", phase: "collecting", updatedAt: at });
    await store.putJson("runs/finished/status.json", { runId: "finished", phase: "done", updatedAt: at });
    await store.putJson("runs/fixture-live/status.json", { runId: "fixture-live", phase: "retesting", updatedAt: at });
    await orch.start();
    expect(await status(store, "gone")).toMatchObject({ phase: "failed", error: RESTARTED, message: "Interrupted during fixing" });
    expect(await status(store, "stale")).toMatchObject({ phase: "failed", error: RESTARTED });
    expect(await status(store, "finished")).toMatchObject({ phase: "done" });
    expect(await status(store, "fixture-live")).toMatchObject({ phase: "retesting" });
  });

  it("does not mirror when the store is the work dir itself (local fs mode)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "fs-daemon-same-"));
    const store = new FsStore(workDir);
    const { orch } = await setup({ store, workDir });
    expect(orch.mirror).toBeUndefined();
    await enqueue(store, "local1");
    await orch.start();
    await until(async () => (await status(store, "local1"))?.phase === "done");
    expect(JSON.parse(await readFile(join(workDir, "local1", "status.json"), "utf8")).phase).toBe("done");
  });
});

describe("RunMirror", () => {
  it("uploads changed files only, and JSONL up to the last complete line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-mirror-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const store = new MemoryStore();
    const m = new RunMirror(store, dir);
    await mkdir(join(dir, "r"), { recursive: true });
    await writeFile(join(dir, "r", "config.json"), "{}");
    await writeFile(join(dir, "r", "posthog.jsonl"), '{"n":1}\n{"n":');
    expect(await m.sync("r")).toBe(2);
    expect(await store.getText("runs/r/posthog.jsonl")).toBe('{"n":1}\n');
    await appendFile(join(dir, "r", "posthog.jsonl"), '2}\n');
    expect(await m.sync("r")).toBe(1);
    expect(await store.getText("runs/r/posthog.jsonl")).toBe('{"n":1}\n{"n":2}\n');
    expect(await m.sync("r")).toBe(0);
  });
});

describe("sandboxCount", () => {
  it("spreads agents over up to 5 sandboxes with at most 6 agents each", async () => {
    const { sandboxCount } = await import("./swarm");
    expect([1, 2, 5, 6, 9, 30, 31, 36].map(sandboxCount)).toEqual([1, 2, 5, 5, 5, 5, 6, 6]);
  });
});
