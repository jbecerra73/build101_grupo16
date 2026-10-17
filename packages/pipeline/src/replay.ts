import { appendFile, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Event, RunConfig } from "@frictionswarm/shared";
import type { SwarmRunner } from "../../../orchestrator/fix-loop";
import { readJson, REPO_ROOT, runsDir as defaultRunsDir } from "./runs";

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
};

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

/** A SwarmRunner that replays a recorded run folder as if it were a live
 * swarm: events are appended to runs/<runId>/events/<agentId>.jsonl as they
 * "happen" (recorded pacing ÷ speed), with runId, agentId, seed and the
 * ?swarm= tag rewritten, and screenshots copied as events reference them.
 * Requested agents reuse recorded agents of the same persona round-robin.
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
        const evs = pool[i % pool.length];
        agents.push({ agentId: `${personaId}-${seed}`, personaId, seed, srcId: evs[0].agentId, evs, t0: evs[0].ts, sent: 0 });
      });
    }

    await rm(join(out, "events"), { recursive: true, force: true });
    await mkdir(join(out, "events"), { recursive: true });
    await mkdir(join(out, "screenshots"), { recursive: true });
    const started = Date.now();
    const swarmTag = new RegExp(`swarm=${escape(rec.runId)}`, "g");

    const rewrite = async (a: Agent, e: Event): Promise<Event> => {
      const ev: Event = {
        ...e,
        runId: config.runId,
        agentId: a.agentId,
        personaId: a.personaId,
        seed: a.seed,
        ts: started + (e.ts - a.t0),
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
      const elapsed = (Date.now() - started) * speed;
      for (const a of agents) {
        const due: Event[] = [];
        while (a.sent < a.evs.length && a.evs[a.sent].ts - a.t0 <= elapsed) due.push(a.evs[a.sent++]);
        if (!due.length) continue;
        const lines = await Promise.all(due.map((e) => rewrite(a, e)));
        await appendFile(join(out, "events", `${a.agentId}.jsonl`), lines.map((l) => JSON.stringify(l) + "\n").join(""));
      }
      if (agents.some((a) => a.sent < a.evs.length)) await sleep(tickMs);
    }
  };
}

/** build-sha recorded in a replay folder, used in place of a live check. */
export const recordedBuildSha = async (dir: string) =>
  (await readJson<RunConfig>(join(dir, "config.json")))?.buildSha ?? "replay";
