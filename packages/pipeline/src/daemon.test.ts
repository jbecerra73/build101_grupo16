import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAnalyzer } from "@frictionswarm/analyzer";
import type { FixResult, RunStatus, StartRunRequest } from "@frictionswarm/shared";
import { FsStore, MemoryStore, type OrchestratorHeartbeat, type QueuedRun, type Settings, type SwarmTopology } from "@frictionswarm/store";
import { Orchestrator, RESTARTED, type DepsFactory } from "./daemon";
import { fakeFixLoop } from "./fakeFix";
import { RunMirror } from "./mirror";
import { replaySwarmRunner } from "./replay";
import { REPO_ROOT } from "./runs";

const FIXTURE = join(REPO_ROOT, "runs", "fixture-baseline");
const FIXTURE_RETEST = join(REPO_ROOT, "runs", "fixture-retest");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req: StartRunRequest = { flowId: "buy-tshirt", personaIds: ["rosa", "kai", "typical"], seedsPerPersona: 2, autoFix: true };

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

function setup(o: { store?: MemoryStore | FsStore; workDir?: string; speed?: number; settingsSeen?: Settings[] } = {}) {
  return (async () => {
    const workDir = o.workDir ?? (await mkdtemp(join(tmpdir(), "fs-daemon-")));
    cleanup.push(() => rm(workDir, { recursive: true, force: true }));
    const store = o.store ?? new MemoryStore();
    const makeDeps: DepsFactory = (settings, { workDir, signal }) => {
      o.settingsSeen?.push(settings);
      return {
        runsDir: workDir,
        runSwarm: replaySwarmRunner({ runsDir: workDir, sourceDir: FIXTURE, retestSourceDir: FIXTURE_RETEST, speed: o.speed ?? 1000, tickMs: 5, signal, bootMs: 0 }),
        analyze: createAnalyzer({ runsDir: workDir, env: {} }),
        verifyBuild: async () => "abc1234",
        fixLoop: fakeFixLoop({ stageDelayMs: 5 }),
        fixWatchMs: 5,
      };
    };
    const orch = new Orchestrator({ store, workDir, makeDeps, pollMs: 20, heartbeatMs: 50, log: () => {}, env: {} });
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
    for (const f of ["config.json", "status.json", "metrics.json", "findings.json", "themes.json", "fix.json", "swarm.json"])
      expect(keys).toContain(`runs/r1/${f}`);
    expect(keys.some((k) => k.startsWith("runs/r1/screenshots/"))).toBe(true);
    // every local file has the same bytes in the store, events included
    const localEvents = (await readdir(join(workDir, "r1", "events"))).sort();
    expect(localEvents).toHaveLength(6);
    for (const f of localEvents)
      expect(await store.getText(`runs/r1/events/${f}`)).toBe(await readFile(join(workDir, "r1", "events", f), "utf8"));

    const fix = (await store.getJson<FixResult>("runs/r1/fix.json"))!;
    const retestId = fix.attempts[0].retestRunId!;
    expect(retestId).toBe("r1-retest1");
    expect(await store.list(`runs/${retestId}/`)).toEqual(expect.arrayContaining([`runs/${retestId}/config.json`, `runs/${retestId}/metrics.json`, `runs/${retestId}/swarm.json`]));

    const topo = (await store.getJson<SwarmTopology>("runs/r1/swarm.json"))!;
    expect(topo).toMatchObject({ runId: "r1", backend: "replay" });
    expect(topo.sandboxes).toHaveLength(5);
    expect(topo.sandboxes.flatMap((s) => s.agentIds).sort()).toEqual(["kai-1", "kai-2", "rosa-1", "rosa-2", "typical-1", "typical-2"]);
    for (const s of topo.sandboxes) {
      expect(s.agentIds.length).toBeLessThanOrEqual(6);
      expect(s.status).toBe("done");
      expect(s.costUsd).toBeGreaterThanOrEqual(0);
    }
    expect(topo.sandboxes.reduce((t, s) => t + (s.costUsd ?? 0), 0)).toBeGreaterThan(0);

    expect(await store.getJson("usage.json")).toMatchObject({ runs: 1, nextSeed: 3 });
    await orch.heartbeat();
    expect(await store.getJson<OrchestratorHeartbeat>("orchestrator.json")).toMatchObject({ host: "local", activeRunIds: [], queueDepth: 0 });
  });

  it("passes settings.json to the pipeline wiring and enforces the daily cap", async () => {
    const seen: Settings[] = [];
    const { store, orch } = await setup({ settingsSeen: seen });
    await store.putJson("settings.json", { replaySpeed: 7, maxRunsPerDay: 1 });
    await store.putJson("usage.json", { date: new Date().toISOString().slice(0, 10), runs: 1, nextSeed: 10 });
    await enqueue(store, "capped");
    await orch.start();
    const s = await until(() => status(store, "capped"));
    expect(s).toMatchObject({ phase: "failed", error: "Run cap reached: 1/1 runs today" });
    expect(await store.list("queue/")).toEqual([]);
    expect(seen).toEqual([]);

    await store.putJson("settings.json", { replaySpeed: 7, maxRunsPerDay: 5 });
    await enqueue(store, "ok");
    await until(async () => (await status(store, "ok"))?.phase === "done");
    expect(seen[0]).toMatchObject({ replaySpeed: 7, maxRunsPerDay: 5 });
  });

  it("refuses an invalid queued request without running it", async () => {
    const { store, orch } = await setup();
    await enqueue(store, "bad", { ...req, personaIds: ["nobody"] });
    await orch.start();
    expect(await until(() => status(store, "bad"))).toMatchObject({ phase: "failed", error: 'Unknown persona(s): nobody' });
  });

  it("cancels a running run when cancel.json appears", async () => {
    const { store, orch } = await setup({ speed: 1 });
    await enqueue(store, "c1");
    await orch.start();
    await until(async () => (await status(store, "c1"))?.phase === "swarming");
    await store.putJson("runs/c1/cancel.json", { runId: "c1", requestedAt: new Date().toISOString() });
    const s = await until(async () => {
      const s = await status(store, "c1");
      return s?.phase === "failed" && s;
    });
    expect(s).toMatchObject({ phase: "failed", error: "cancelled" });
    await until(async () => !orch.active.size);
    const topo = (await store.getJson<SwarmTopology>("runs/c1/swarm.json"))!;
    expect(topo.sandboxes.every((x) => x.status === "closed" || x.status === "done")).toBe(true);
    expect(await store.getJson("runs/c1/metrics.json")).toBeUndefined();
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
    await store.putJson("runs/stale/status.json", { runId: "stale", phase: "swarming", updatedAt: at });
    await store.putJson("runs/finished/status.json", { runId: "finished", phase: "done", updatedAt: at });
    await store.putJson("runs/fixture-live/status.json", { runId: "fixture-live", phase: "swarming", updatedAt: at });
    await orch.start();
    expect(await status(store, "gone")).toMatchObject({ phase: "failed", error: RESTARTED, message: "Interrupted during fixing" });
    expect(await status(store, "stale")).toMatchObject({ phase: "failed", error: RESTARTED });
    expect(await status(store, "finished")).toMatchObject({ phase: "done" });
    expect(await status(store, "fixture-live")).toMatchObject({ phase: "swarming" });
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
  it("uploads changed files only, and event logs up to the last complete line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-mirror-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const store = new MemoryStore();
    const m = new RunMirror(store, dir);
    await mkdir(join(dir, "r", "events"), { recursive: true });
    await writeFile(join(dir, "r", "config.json"), "{}");
    await writeFile(join(dir, "r", "events", "a.jsonl"), '{"n":1}\n{"n":');
    expect(await m.sync("r")).toBe(2);
    expect(await store.getText("runs/r/events/a.jsonl")).toBe('{"n":1}\n');
    await appendFile(join(dir, "r", "events", "a.jsonl"), '2}\n');
    expect(await m.sync("r")).toBe(1);
    expect(await store.getText("runs/r/events/a.jsonl")).toBe('{"n":1}\n{"n":2}\n');
    expect(await m.sync("r")).toBe(0);
  });
});

describe("sandboxCount", () => {
  it("spreads agents over up to 5 sandboxes with at most 6 agents each", async () => {
    const { sandboxCount } = await import("./swarm");
    expect([1, 2, 5, 6, 9, 30, 31, 36].map(sandboxCount)).toEqual([1, 2, 5, 5, 5, 5, 6, 6]);
  });
});
