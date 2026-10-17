import { appendFile, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { actionBudget, PERSONAS, type Event, type RunConfig } from "@frictionswarm/shared";
import type { SwarmRunner } from "../../../orchestrator/fix-loop";
import { readJson, REPO_ROOT, runsDir as defaultRunsDir, writeJson } from "./runs";
import { sandboxCount, type SandboxInfo, type SwarmTopology } from "./swarm";

export type ReplayOptions = {
  runsDir?: string;
  /** Recorded run folder replayed for baselines. Default runs/fixture-baseline. */
  sourceDir?: string;
  /** Recorded "after" folder replayed for retest configs. Default: sourceDir. */
  retestSourceDir?: string;
  /** >1 plays faster than recorded. Event ts keep the recorded durations. */
  speed?: number;
  /** How often new events are flushed to disk. */
  tickMs?: number;
  /** Stops the replay (the runner then rejects with "cancelled"). */
  signal?: AbortSignal;
  /** Simulated sandbox boot time in recorded ms (scaled by speed, staggered per sandbox). */
  bootMs?: number;
};

/** Fake cost model for the swarm monitor: sandbox time + one Haiku call per action. */
export const REPLAY_COST = { sandboxUsdPerSecond: 0.00012, usdPerAction: 0.0025 };

type Agent = { agentId: string; personaId: string; seed: number; srcId: string; evs: Event[]; t0: number; sent: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function loadRecording(dir: string) {
  const cfg = await readJson<RunConfig>(join(dir, "config.json"));
  const byPersona = new Map<string, Event[][]>();
  for (const f of (await readdir(join(dir, "events"))).filter((f) => f.endsWith(".jsonl")).sort()) {
    const evs = (await readFile(join(dir, "events", f), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Event)
      .sort((a, b) => a.ts - b.ts);
    if (evs.length) byPersona.set(evs[0].personaId, [...(byPersona.get(evs[0].personaId) ?? []), evs]);
  }
  return { runId: cfg?.runId ?? basename(dir), byPersona };
}

const actionsOf = (evs: Event[]) => evs.filter((e) => e.type === "action").length;

/** The recording replayed for the i-th requested agent of a persona: round-robin,
 * skipping recordings with more actions than the agent's seeded budget (the real
 * worker stops at its budget). When none fits, the round-robin one is cut at the
 * budget and ends in a give_up, as the worker would. */
export function pickRecording(pool: Event[][], i: number, budget: number): Event[] {
  for (let k = 0; k < pool.length; k++) {
    const evs = pool[(i + k) % pool.length];
    if (actionsOf(evs) <= budget) return evs;
  }
  const evs = pool[i % pool.length];
  const cut: Event[] = [];
  let n = 0;
  for (const e of evs) {
    if (e.type === "action" && ++n > budget) break;
    cut.push(e);
  }
  const last = cut.at(-1) ?? evs[0];
  const { runId, agentId, personaId, seed, url, step } = last;
  return [...cut, { runId, agentId, personaId, seed, url, step, ts: last.ts + 1000, type: "give_up", note: `Out of actions (budget ${budget}).` }];
}

/** A SwarmRunner that replays a recorded run folder as if it were a live
 * swarm: events are appended to runs/<runId>/events/<agentId>.jsonl as they
 * "happen" (recorded pacing ÷ speed), with runId, agentId, seed and the
 * ?swarm= tag rewritten, and screenshots copied as events reference them.
 * Requested agents reuse recorded agents of the same persona round-robin,
 * within each agent's seeded action budget (see pickRecording).
 * This is the offline demo path and the reference behaviour for P2's runner. */
export function replaySwarmRunner(opts: ReplayOptions = {}): SwarmRunner {
  return async (config) => {
    const dir =
      (config.kind === "retest" ? opts.retestSourceDir : undefined) ??
      opts.sourceDir ??
      join(REPO_ROOT, "runs", "fixture-baseline");
    const speed = opts.speed ?? 1;
    const tickMs = opts.tickMs ?? 250;
    const out = join(opts.runsDir ?? defaultRunsDir(), config.runId);
    const rec = await loadRecording(dir);

    const agents: Agent[] = [];
    for (const personaId of config.personaIds) {
      const pool = rec.byPersona.get(personaId);
      if (!pool?.length) throw new Error(`Replay recording ${dir} has no agents for persona "${personaId}"`);
      (config.seeds[personaId] ?? []).forEach((seed, i) => {
        const persona = PERSONAS[personaId];
        const evs = persona ? pickRecording(pool, i, actionBudget(persona, seed)) : pool[i % pool.length];
        agents.push({ agentId: `${personaId}-${seed}`, personaId, seed, srcId: evs[0].agentId, evs, t0: evs[0].ts, sent: 0 });
      });
    }

    await rm(join(out, "events"), { recursive: true, force: true });
    await mkdir(join(out, "events"), { recursive: true });
    await mkdir(join(out, "screenshots"), { recursive: true });
    const started = Date.now();
    const swarmTag = new RegExp(`swarm=${escape(rec.runId)}`, "g");

    // swarm.json: agents spread over simulated sandboxes (<= 6 each), each
    // booting for a moment before its agents start.
    const nSbx = sandboxCount(agents.length);
    const bootMs = opts.bootMs ?? 1200;
    const sbx = Array.from({ length: nSbx }, (_, i) => ({
      info: {
        id: `replay-${config.runId}-${i + 1}`,
        label: `sbx-${i + 1}`,
        region: "replay",
        status: "booting",
        agentIds: [],
        startedAt: new Date(started).toISOString(),
        costUsd: 0,
      } as SandboxInfo,
      bootReal: (bootMs * (1 + 0.35 * i)) / speed,
      agents: [] as Agent[],
      actions: 0,
    }));
    agents.forEach((a, i) => {
      sbx[i % nSbx].agents.push(a);
      sbx[i % nSbx].info.agentIds.push(a.agentId);
    });
    const sbxOf = new Map(sbx.flatMap((s) => s.agents.map((a) => [a, s] as const)));
    let lastTopo = "";
    const writeTopology = async () => {
      const now = Date.now();
      for (const s of sbx) {
        const end = s.info.endedAt ? Date.parse(s.info.endedAt) : now;
        s.info.costUsd = +(((end - started) / 1000) * REPLAY_COST.sandboxUsdPerSecond + s.actions * REPLAY_COST.usdPerAction).toFixed(4);
      }
      const topo: SwarmTopology = { runId: config.runId, backend: "replay", sandboxes: sbx.map((s) => s.info), updatedAt: new Date(now).toISOString() };
      const key = JSON.stringify(topo.sandboxes);
      if (key === lastTopo) return;
      lastTopo = key;
      await writeJson(join(out, "swarm.json"), topo);
    };
    await writeTopology();

    const rewrite = async (a: Agent, e: Event): Promise<Event> => {
      const ev: Event = {
        ...e,
        runId: config.runId,
        agentId: a.agentId,
        personaId: a.personaId,
        seed: a.seed,
        ts: Math.round(started + sbxOf.get(a)!.bootReal + (e.ts - a.t0)),
        ...(e.url && { url: e.url.replace(swarmTag, `swarm=${config.runId}`) }),
      };
      if (e.screenshot) {
        const name = basename(e.screenshot);
        const renamed = name.startsWith(`${a.srcId}-`) ? `${a.agentId}-${name.slice(a.srcId.length + 1)}` : `${a.agentId}-${name}`;
        ev.screenshot = `screenshots/${renamed}`;
        await copyFile(join(dir, e.screenshot), join(out, ev.screenshot)).catch(() => delete ev.screenshot);
      }
      return ev;
    };

    while (agents.some((a) => a.sent < a.evs.length)) {
      if (opts.signal?.aborted) {
        for (const s of sbx) if (s.info.status !== "done") Object.assign(s.info, { status: "closed", endedAt: new Date().toISOString() });
        await writeTopology();
        throw new Error("cancelled");
      }
      for (const s of sbx) {
        const elapsed = (Date.now() - started - s.bootReal) * speed;
        if (elapsed < 0) continue;
        if (s.info.status === "booting") s.info.status = "running";
        for (const a of s.agents) {
          const due: Event[] = [];
          while (a.sent < a.evs.length && a.evs[a.sent].ts - a.t0 <= elapsed) due.push(a.evs[a.sent++]);
          if (!due.length) continue;
          s.actions += due.filter((e) => e.type === "action").length;
          const lines = await Promise.all(due.map((e) => rewrite(a, e)));
          await appendFile(join(out, "events", `${a.agentId}.jsonl`), lines.map((l) => JSON.stringify(l) + "\n").join(""));
        }
        if (s.info.status === "running" && s.agents.every((a) => a.sent >= a.evs.length))
          Object.assign(s.info, { status: "done", endedAt: new Date().toISOString() });
      }
      await writeTopology();
      if (agents.some((a) => a.sent < a.evs.length)) await sleep(tickMs);
    }
    for (const s of sbx) if (s.info.status !== "done") Object.assign(s.info, { status: "done", endedAt: new Date().toISOString() });
    await writeTopology();
  };
}

/** build-sha recorded in a replay folder, used in place of a live check. */
export const recordedBuildSha = async (dir: string) =>
  (await readJson<RunConfig>(join(dir, "config.json")))?.buildSha ?? "replay";
