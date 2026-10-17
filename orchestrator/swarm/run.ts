// The re-test swarm: up to 5 sandboxes × 6 agents against a deploy preview.
//
//   reserve fresh seeds → plan persona × seed assignments →
//   create sandboxes and start one worker in each → poll their latest screenshots into
//   runs/<runId>/screenshots/ for the live grid → close every sandbox → waitForSwarm.
//
// Sandboxes are closed on success, on failure (any worker failing stops the whole swarm) and on
// abort (the CLI turns Ctrl-C into one). Agents' tracks go to PostHog; locally the run folder
// gets config.json, screenshots/ and agents/<agentId>.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonaId, RunConfig, SwarmAgentResult } from "../../shared";
import type { SwarmWorkerInput } from "../../worker/swarm";
import { reserveSeeds } from "./ledger";
import { freshSeeds, planSwarm, type SwarmPlan } from "./plan";
import { sandboxPath, type Sandbox, type SandboxProcess, type SandboxProvider } from "./provider";
import type { SwarmWaiter } from "./wait";

export type RunSwarmOptions = {
  runId: string;
  flowId: string;
  /** Deploy preview URL; agents open it with their swarm tag. */
  previewUrl: string;
  /** The preview's build_sha (RunConfig.posthog.buildSha). */
  buildSha: string;
  personaIds: PersonaId[];
  /** Explicit seeds (e.g. from a pipeline's RunConfig). Otherwise `seedsPerPersona` fresh ones. */
  seeds?: Record<PersonaId, number[]>;
  seedsPerPersona?: number;
  provider: SandboxProvider;
  /** PostHogSource (or a stand-in, see wait.ts). Omitted when the caller waits itself (the pipeline does). */
  waiter?: SwarmWaiter;
  runsDir: string;
  /** Seed ledger file (see ledger.ts). */
  ledgerFile: string;
  maxSandboxes?: number;
  agentsPerSandbox?: number;
  /** How often to pull screenshots for the live grid. */
  pollMs?: number;
  /** Per-agent wall clock inside the worker. */
  agentTimeoutMs?: number;
  /** Budget for waitForSwarm (PostHog ingestion lags ~30–90 s). */
  waitTimeoutMs?: number;
  /** Claude model for the agents. */
  model?: string;
  /** Environment for the workers (Claude credentials). */
  env?: Record<string, string>;
  baselineRunId?: string;
  /** Write runs/<runId>/config.json (default). The pipeline's fix loop writes its own first. */
  writeConfig?: boolean;
  /** Called whenever a sandbox changes state, with all of them (for the dashboard's swarm.json). */
  onSandboxes?: (sandboxes: SandboxState[]) => void;
  signal?: AbortSignal;
  log?: (line: string) => void;
  now?: () => Date;
};

export type SandboxState = {
  /** tenki's session id, once created. */
  id?: string;
  status: "booting" | "running" | "done" | "failed" | "closed";
  agentIds: string[];
  startedAt: string;
  endedAt?: string;
};

export type SwarmRunResult = { config: RunConfig; plan: SwarmPlan; results: SwarmAgentResult[] };

export class SwarmAbortedError extends Error {
  constructor() {
    super("Swarm aborted");
  }
}

const sleep = (ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((r) => (timer = setTimeout(r, ms)));
  return { promise, cancel: () => clearTimeout(timer) };
};

/** Settles with `p` or after `ms`, whichever is first, without leaving a timer behind. */
async function within(p: Promise<unknown>, ms: number) {
  const t = sleep(ms);
  try {
    await Promise.race([p.catch(() => {}), t.promise]);
  } finally {
    t.cancel();
  }
}

function abortion(signal?: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new SwarmAbortedError());
    signal.addEventListener("abort", () => reject(new SwarmAbortedError()), { once: true });
  });
  p.catch(() => {});
  return p;
}

/** Writes via a temp file so the dashboard never reads half a PNG. */
function writeAtomic(file: string, data: Uint8Array) {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

export async function runSwarm(o: RunSwarmOptions): Promise<SwarmRunResult> {
  const log = o.log ?? console.log;
  if (!/^[\w.-]+$/.test(o.runId)) throw new Error(`Invalid runId ${o.runId}`);
  if (o.signal?.aborted) throw new SwarmAbortedError();

  // 1. Fresh seeds, unless the pipeline gave them.
  const seedsPerPersona = o.seedsPerPersona ?? 10;
  const seeds = o.seeds ?? freshSeeds(o.personaIds, seedsPerPersona, reserveSeeds(o.ledgerFile, seedsPerPersona));

  // 2. Plan and run folder.
  const plan = planSwarm({ runId: o.runId, previewUrl: o.previewUrl, personaIds: o.personaIds, seeds, maxSandboxes: o.maxSandboxes, agentsPerSandbox: o.agentsPerSandbox });
  const runDir = join(o.runsDir, o.runId);
  mkdirSync(join(runDir, "screenshots"), { recursive: true });
  mkdirSync(join(runDir, "agents"), { recursive: true });
  const config: RunConfig = {
    runId: o.runId,
    kind: "retest",
    flowId: o.flowId,
    posthog: { source: "api", buildSha: o.buildSha },
    personaIds: o.personaIds,
    seeds,
    targetUrl: o.previewUrl,
    ...(o.baselineRunId ? { baselineRunId: o.baselineRunId } : {}),
    createdAt: (o.now?.() ?? new Date()).toISOString(),
  };
  if (o.writeConfig !== false) writeFileSync(join(runDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  log(`swarm ${o.runId}: ${plan.agents.length} agents in ${plan.sandboxes.length} ${o.provider.name} sandbox(es) · ${o.previewUrl}`);

  const remoteRun = sandboxPath("runs", o.runId);
  const sandboxes: (Sandbox | undefined)[] = plan.sandboxes.map(() => undefined);
  const creating: Promise<Sandbox>[] = [];
  const procs: SandboxProcess[] = [];
  const closed = new Set<Sandbox>();
  const copiedResults = new Set<string>();
  /** Set on the first failure or abort, so sandboxes that come up afterwards start nothing. */
  let stopping = false;
  const now = () => (o.now?.() ?? new Date()).toISOString();
  const states: SandboxState[] = plan.sandboxes.map((agents) => ({ status: "booting", agentIds: agents.map((a) => a.agentId), startedAt: now() }));
  const report = () => {
    try {
      o.onSandboxes?.(states.map((st) => ({ ...st })));
    } catch {
      // Reporting is best effort; it never stops the swarm.
    }
  };
  const setState = (i: number, change: Partial<SandboxState>) => {
    const ended = change.status === "done" || change.status === "failed" || change.status === "closed";
    states[i] = { ...states[i], ...change, ...(ended && !states[i].endedAt ? { endedAt: now() } : {}) };
    report();
  };
  report();

  /** Copies each agent's latest screenshot (and its result, once there) into the local run folder. */
  const pull = async () => {
    await Promise.all(
      plan.sandboxes.flatMap((agents, i) => {
        const sb = sandboxes[i];
        if (!sb || closed.has(sb)) return [];
        return agents.map(async ({ agentId }) => {
          try {
            const png = await sb.readFile(`${remoteRun}/screenshots/${agentId}.png`);
            if (png) writeAtomic(join(runDir, "screenshots", `${agentId}.png`), png);
            if (!copiedResults.has(agentId)) {
              const result = await sb.readFile(`${remoteRun}/agents/${agentId}.json`);
              if (result) {
                writeAtomic(join(runDir, "agents", `${agentId}.json`), result);
                copiedResults.add(agentId);
                log(`  ${agentId} ended (${copiedResults.size}/${plan.agents.length})`);
              }
            }
          } catch {
            // Best effort: the live grid can skip a frame.
          }
        });
      }),
    );
  };

  const closeAll = async () => {
    // A sandbox still being created when we fail or abort is closed once it exists.
    await Promise.allSettled(creating);
    await Promise.all(
      sandboxes.map(async (sb, i) => {
        if (!sb || closed.has(sb)) return;
        closed.add(sb);
        try {
          await sb.close();
          if (states[i].status === "booting" || states[i].status === "running") setState(i, { status: "closed" });
          log(`  sandbox ${i + 1} (${sb.id}) closed`);
        } catch (err) {
          log(`  sandbox ${i + 1} (${sb.id}) FAILED TO CLOSE, close it by hand: ${err instanceof Error ? err.message : err}`);
        }
      }),
    );
  };

  const runWorker = async (i: number) => {
    const created = o.provider.create({ name: `swarm-${o.runId}-${i + 1}`, env: { ...o.env, ...(o.model ? { AGENT_MODEL: o.model } : {}) } });
    creating.push(created);
    const sb = (sandboxes[i] = await created.catch((err) => {
      setState(i, { status: "failed" });
      throw err;
    }));
    setState(i, { id: sb.id });
    log(`  sandbox ${i + 1} (${sb.id}) up: ${plan.sandboxes[i].map((a) => a.agentId).join(", ")}`);
    if (stopping || o.signal?.aborted) throw new SwarmAbortedError();
    const input: SwarmWorkerInput = {
      runId: o.runId,
      flowId: o.flowId,
      targetUrl: o.previewUrl,
      agents: plan.sandboxes[i].map(({ personaId, seed }) => ({ personaId, seed })),
    };
    const inputPath = `${remoteRun}/worker-${i + 1}.json`;
    await sb.writeFile(inputPath, JSON.stringify(input, null, 2));
    const repo = o.provider.repoDir;
    const proc = sb.start(
      [
        `${repo}/node_modules/.bin/tsx`, `${repo}/worker/swarm-cli.ts`,
        "--input", inputPath,
        "--runs", sandboxPath("runs"),
        "--timeout-min", String((o.agentTimeoutMs ?? 10 * 60_000) / 60_000),
        ...(o.model ? ["--model", o.model] : []),
      ],
      { cwd: repo },
    );
    procs.push(proc);
    setState(i, { status: "running" });
    const { exitCode, output } = await proc.done;
    setState(i, { status: exitCode === 0 ? "done" : stopping || o.signal?.aborted ? "closed" : "failed" });
    if (exitCode !== 0) throw new Error(`Worker in sandbox ${i + 1} (${sb.id}) exited ${exitCode}: ${output.trim().slice(-500)}`);
  };

  // 3. Run every worker, polling screenshots until all have exited. The first failure or an
  //    abort stops the rest; either way every sandbox is closed before we return or throw.
  try {
    const aborted = abortion(o.signal);
    const all = Promise.all(plan.sandboxes.map((_, i) => runWorker(i)));
    let settled = false;
    all.then(() => (settled = true), () => (settled = true));
    while (!settled) {
      const tick = sleep(o.pollMs ?? 3000);
      try {
        await Promise.race([all.then(() => {}), tick.promise, aborted]);
      } finally {
        tick.cancel();
      }
      await pull();
    }
    await all;
    await pull();
  } catch (err) {
    stopping = true;
    log(`swarm ${o.runId} failed: ${err instanceof Error ? err.message : err}; stopping workers and closing sandboxes`);
    throw err;
  } finally {
    if (stopping) await Promise.all(procs.map((p) => within(p.stop(), 15_000)));
    await closeAll();
  }

  // 4. Agents are done; wait for PostHog to ingest their last events (sandboxes already closed).
  const agentIds = plan.agents.map((a) => a.agentId);
  if (o.waiter) {
    log(`waiting for PostHog to ingest ${agentIds.length} agents' tracks…`);
    await Promise.race([o.waiter.waitForSwarm({ runId: o.runId, agentIds, timeoutMs: o.waitTimeoutMs ?? 10 * 60_000 }), abortion(o.signal)]);
  }

  const results = agentIds.flatMap((a) => {
    const file = join(runDir, "agents", `${a}.json`);
    return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8")) as SwarmAgentResult] : [];
  });
  log(`swarm ${o.runId} done: ${results.filter((r) => r.outcome === "success").length}/${agentIds.length} succeeded`);
  return { config, plan, results };
}
