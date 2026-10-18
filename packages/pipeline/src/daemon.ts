// The orchestrator daemon: takes queued runs from the run store, runs the
// pipeline on local disk and mirrors every run file back to the store, where
// the dashboard reads it. No inbound connections: the store is the only link.
//
//   npm run orchestrator            (RUN_STORE=fs|blobs, see docs/DEPLOY.md)
//
// It also runs inside the Next server for local dev (ORCHESTRATOR=inline, see
// apps/dashboard/lib/orchestrator.ts).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunStatus } from "@frictionswarm/shared";
import {
  createStore,
  FsStore,
  HEARTBEAT_EVERY_MS,
  isValidRunId,
  KEYS,
  readSettings,
  readUsage,
  type CancelRequest,
  type OrchestratorHeartbeat,
  type QueuedRun,
  type RunStore,
  type Settings,
} from "@frictionswarm/store";
import { RunMirror } from "./mirror";
import { registerTenkiSwarmRunner } from "./swarm";
import {
  analysisConfig,
  buildDeps,
  CANCELLED,
  DEFAULT_SEEDS_PER_PERSONA,
  runPipeline,
  seedsFor,
  validateRequest,
  type PipelineDeps,
} from "./pipeline";
import { REPO_ROOT, writeJson } from "./runs";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

export type DepsFactory = (settings: Settings, ctx: { runId: string; signal: AbortSignal; workDir: string; log: Log }) => PipelineDeps;

export type DaemonOptions = {
  store: RunStore;
  /** Local runs dir the pipeline writes to. When the store is an FsStore on
   * the same folder, nothing needs mirroring. */
  workDir: string;
  host?: OrchestratorHeartbeat["host"];
  sandboxId?: string;
  version?: string;
  env?: Env;
  log?: Log;
  heartbeatMs?: number;
  /** Queue, cancel and mirror poll interval. */
  pollMs?: number;
  /** Runs at once. One by default: a run already uses all 5 sandboxes. */
  maxConcurrent?: number;
  /** With nothing running or queued for this long, onIdle is called once (the
   * autostarted sandbox shuts itself down). Default: never. */
  idleExitMs?: number;
  onIdle?: () => void | Promise<void>;
  /** Pipeline wiring per run (tests inject fakes). Default: buildDeps from settings. */
  makeDeps?: DepsFactory;
  now?: () => Date;
};

type Active = { runId: string; controller: AbortController; done: Promise<RunStatus> };

const TERMINAL = new Set(["done", "failed"]);
export const RESTARTED = "orchestrator restarted";

/** Default wiring: settings.json picks the swarm runner, fix loop and speed. */
export const settingsDeps =
  (env: Env = process.env): DepsFactory =>
  (settings, { workDir, signal, log }) =>
    buildDeps({
      runsDir: workDir,
      log,
      signal,
      swarmRunner: settings.swarmRunner,
      fixLoop: settings.fixLoop,
      swarmSpeed: settings.swarmSpeed,
      fixStageDelayMs: Number(env.FIX_STAGE_DELAY_MS ?? 1500),
      fixAttempts: env.FIX_ATTEMPTS ? Number(env.FIX_ATTEMPTS) : undefined,
    });

export class Orchestrator {
  readonly store: RunStore;
  readonly workDir: string;
  readonly active = new Map<string, Active>();
  readonly mirror?: RunMirror;
  #o: DaemonOptions;
  #log: Log;
  #startedAt = "";
  #queueDepth = 0;
  #timers: NodeJS.Timeout[] = [];
  #ticking?: Promise<void>;
  #stopped = false;
  #idleSince?: number;

  constructor(o: DaemonOptions) {
    this.#o = o;
    this.store = o.store;
    this.workDir = resolve(o.workDir);
    this.#log = o.log ?? ((l) => console.log(`[orchestrator] ${l}`));
    const sameDisk = o.store instanceof FsStore && o.store.root === this.workDir;
    if (!sameDisk) this.mirror = new RunMirror(o.store, this.workDir);
  }

  #now = () => (this.#o.now ?? (() => new Date()))();

  async start() {
    await mkdir(this.workDir, { recursive: true });
    this.#startedAt = this.#now().toISOString();
    await this.recover();
    await this.heartbeat();
    this.#timers.push(setInterval(() => void this.heartbeat().catch((e) => this.#log(`heartbeat failed: ${errMsg(e)}`)), this.#o.heartbeatMs ?? HEARTBEAT_EVERY_MS));
    this.#timers.push(setInterval(() => void this.tick(), this.#o.pollMs ?? 1000));
    this.#log(`started (${this.store.kind} store, work dir ${this.workDir}${this.mirror ? ", mirroring" : ""})`);
  }

  /** Stops polling. Active runs keep going unless `abort` (the next start marks them restarted). */
  async stop({ abort = false, wait = false } = {}) {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    await this.#ticking;
    if (abort) for (const a of this.active.values()) a.controller.abort();
    if (wait) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** Runs that were mid-flight when the orchestrator went away end failed. */
  async recover() {
    const prev = await this.store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat);
    const ids = new Set((prev?.activeRunIds ?? []).filter(isValidRunId));
    // fixture-* runs are frozen demo folders (fixture-live is deliberately mid-retest).
    for (const id of await this.store.listDirs("runs/")) if (isValidRunId(id) && !id.startsWith("fixture-")) ids.add(id);
    for (const runId of ids) {
      if (this.active.has(runId)) continue;
      const status = await this.store.getJson<RunStatus>(KEYS.runFile(runId, "status.json"));
      if (!status || TERMINAL.has(status.phase)) continue;
      const failed: RunStatus = { ...status, phase: "failed", message: `Interrupted during ${status.phase}`, error: RESTARTED, updatedAt: this.#now().toISOString() };
      await this.store.putJson(KEYS.runFile(runId, "status.json"), failed);
      // Keep the local copy in step so the mirror does not resurrect the old phase.
      if (existsSync(join(this.workDir, runId, "status.json"))) await writeJson(join(this.workDir, runId, "status.json"), failed);
      this.#log(`${runId}: was ${status.phase}, marked failed (${RESTARTED})`);
    }
  }

  async heartbeat() {
    const hb: OrchestratorHeartbeat = {
      host: this.#o.host ?? "local",
      ...(this.#o.sandboxId ? { sandboxId: this.#o.sandboxId } : {}),
      version: this.#o.version ?? "dev",
      startedAt: this.#startedAt,
      lastSeenAt: this.#now().toISOString(),
      activeRunIds: [...this.active.keys()],
      queueDepth: this.#queueDepth,
    };
    await this.store.putJson(KEYS.heartbeat, hb);
  }

  /** One poll: mirror + cancel checks for active runs, then take queued work. */
  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#tick()
      .catch((e) => this.#log(`tick failed: ${errMsg(e)}`))
      .finally(() => (this.#ticking = undefined));
    return this.#ticking;
  }

  async #tick() {
    for (const a of this.active.values()) {
      await this.#sync(a.runId);
      if (!a.controller.signal.aborted && (await this.store.getJson<CancelRequest>(KEYS.cancel(a.runId)))) {
        this.#log(`${a.runId}: cancel requested`);
        a.controller.abort();
      }
    }
    if (this.#stopped) return;
    const queued = await this.queue();
    this.#queueDepth = queued.length;
    const max = this.#o.maxConcurrent ?? 1;
    for (const item of queued) {
      if (this.active.size >= max || this.#stopped) break;
      await this.take(item);
      this.#queueDepth--;
    }
    this.#checkIdle(queued.length);
  }

  #checkIdle(queued: number) {
    const { idleExitMs, onIdle } = this.#o;
    if (!idleExitMs || !onIdle) return;
    const now = this.#now().getTime();
    if (this.active.size > 0 || queued > 0) this.#idleSince = undefined;
    else if (this.#idleSince === undefined) this.#idleSince = now;
    else if (now - this.#idleSince >= idleExitMs && !this.#stopped) {
      this.#log(`idle for ${Math.round((now - this.#idleSince) / 60_000)} min, shutting down`);
      this.#stopped = true;
      void Promise.resolve(onIdle()).catch((e) => this.#log(`idle shutdown failed: ${errMsg(e)}`));
    }
  }

  /** Queued runs, oldest first. Unreadable entries are dropped. */
  async queue(): Promise<QueuedRun[]> {
    const out: QueuedRun[] = [];
    for (const key of await this.store.list(KEYS.queue)) {
      const q = await this.store.getJson<QueuedRun>(key);
      if (q?.runId && q.req && q.requestId) out.push(q);
      else {
        this.#log(`dropping unreadable queue entry ${key}`);
        await this.store.delete(key);
      }
    }
    return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** Starts a queued run (or ends it failed right away: invalid, over the cap, cancelled). */
  async take(item: QueuedRun) {
    const { runId, req } = item;
    const queueKey = KEYS.queued(item.requestId);
    if (!isValidRunId(runId) || this.active.has(runId) || (await this.store.getJson(KEYS.runFile(runId, "config.json")))) {
      this.#log(`dropping queue entry ${item.requestId}: run ${runId} invalid or already exists`);
      await this.store.delete(queueKey);
      return;
    }
    const settings = await readSettings(this.store, this.#o.env);
    const usage = await readUsage(this.store, this.#now());
    const nextSeed = usage.nextSeed ?? 1;
    const n = Math.max(1, Math.min(10, Math.floor(req.seedsPerPersona ?? settings.defaultSeedsPerPersona ?? DEFAULT_SEEDS_PER_PERSONA) || 1));
    const seeds = Array.from({ length: n }, (_, i) => nextSeed + i);
    let refusal: string | undefined;
    try {
      validateRequest(req);
    } catch (e) {
      refusal = errMsg(e);
    }
    const config = await analysisConfig(runId, refusal ? { flowId: req.flowId, autoFix: false } : req, this.#now());
    const dir = join(this.workDir, runId);
    const writeStatus = (s: Partial<RunStatus>) =>
      writeJson(join(dir, "status.json"), { runId, phase: "analyzing", updatedAt: this.#now().toISOString(), ...s });

    if (!refusal && (await this.store.getJson(KEYS.cancel(runId)))) refusal = CANCELLED;
    if (!refusal && usage.runs >= settings.maxRunsPerDay) refusal = `Run cap reached: ${usage.runs}/${settings.maxRunsPerDay} runs today`;

    await writeJson(join(dir, "config.json"), config);
    await writeJson(join(dir, "request.json"), req); // for retry
    if (refusal) {
      await writeStatus({ phase: "failed", message: "Not started", error: refusal });
      await this.#sync(runId);
      await this.store.delete(queueKey);
      this.#log(`${runId}: not started (${refusal})`);
      return;
    }
    await this.store.putJson(KEYS.usage, { date: usage.date, runs: usage.runs + 1, nextSeed: nextSeed + n });
    await writeStatus({ message: "Starting" });
    await this.#sync(runId);
    await this.store.delete(queueKey);

    const controller = new AbortController();
    const log: Log = (l) => this.#log(`${runId} ${l}`);
    const deps = (this.#o.makeDeps ?? settingsDeps(this.#o.env))(settings, { runId, signal: controller.signal, workDir: this.workDir, log });
    this.#log(`${runId}: starting (${settings.swarmRunner} swarm, ${settings.fixLoop} fix loop, ${config.posthog.source} source, retest x${n} per persona)`);
    const done = runPipeline(runId, { autoFix: req.autoFix, retestSeeds: seedsFor(seeds) }, {
      ...deps,
      runsDir: this.workDir,
      signal: controller.signal,
      onStatus: (s) => {
        deps.onStatus?.(s);
        log(`${s.phase}: ${s.message ?? ""}${s.error ? ` (error: ${s.error})` : ""}`);
      },
    }).finally(async () => {
      // Let the last status write land, then push everything one final time.
      await new Promise((r) => setTimeout(r, 50));
      await this.#sync(runId).catch((e) => this.#log(`${runId}: final mirror failed: ${errMsg(e)}`));
      this.active.delete(runId);
      await this.heartbeat().catch(() => {});
    });
    this.active.set(runId, { runId, controller, done });
    await this.heartbeat();
  }

  /** Mirrors a run and its retest folders (<runId>-retestN) to the store. */
  async #sync(runId: string) {
    if (!this.mirror) return;
    const ids = [runId];
    try {
      for (const d of readdirSync(this.workDir)) if (d.startsWith(`${runId}-retest`)) ids.push(d);
    } catch {
      /* work dir missing */
    }
    for (const id of ids) await this.mirror.sync(id);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function gitVersion(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

/** Orchestrator configured from env (RUN_STORE, RUNS_DIR, ORCHESTRATOR_WORK_DIR, ...). */
/** Plugs P2's tenki swarm (orchestrator/swarm/pipeline-runner.ts) into tenkiSwarmRunner. Entry
 * points only: the Next server (inline orchestrator) can't load it, use ORCHESTRATOR=daemon there. */
export async function registerP2SwarmRunner() {
  const { tenkiRunnerFactory } = await import(/*turbopackIgnore: true*/ "../../../orchestrator/swarm/pipeline-runner");
  registerTenkiSwarmRunner(tenkiRunnerFactory());
}

export function orchestratorFromEnv(env: Env = process.env, log?: Log, extra: Partial<DaemonOptions> = {}): Orchestrator {
  const runsDir = resolve(/*turbopackIgnore: true*/ env.RUNS_DIR ?? join(REPO_ROOT, "runs"));
  const store = createStore(runsDir, env);
  // With a Blobs store the pipeline still needs a local folder; under /home/tenki in the sandbox.
  const workDir = resolve(env.ORCHESTRATOR_WORK_DIR ?? (store.kind === "fs" ? runsDir : join(REPO_ROOT, ".orchestrator-work")));
  return new Orchestrator({
    store,
    workDir,
    host: env.ORCHESTRATOR_HOST === "tenki" ? "tenki" : "local",
    sandboxId: env.TENKI_SANDBOX_ID || undefined,
    version: env.ORCHESTRATOR_VERSION ?? gitVersion(),
    env,
    log,
    maxConcurrent: Number(env.ORCHESTRATOR_MAX_CONCURRENT ?? 1),
    ...(Number(env.ORCHESTRATOR_IDLE_EXIT_MS) > 0 && { idleExitMs: Number(env.ORCHESTRATOR_IDLE_EXIT_MS) }),
    ...extra,
  });
}

/** Autostarted in a sandbox (packages/store/src/launch.ts): clear the launch
 * record and close our own sandbox, so an idle orchestrator stops billing. */
async function shutdownSandbox(o: Orchestrator, env: Env) {
  await o.stop();
  await o.store.delete(KEYS.launch).catch(() => {});
  if (env.TENKI_SANDBOX_ID && (env.TENKI_API_KEY || env.TENKI_AUTH_TOKEN)) {
    const { tenkiClient } = await import("@frictionswarm/store/launch");
    const client = await tenkiClient(env);
    const session = await client.get(env.TENKI_SANDBOX_ID);
    console.log(`[orchestrator] closing sandbox ${env.TENKI_SANDBOX_ID}`);
    await session.closeIfOpen();
  }
  process.exit(0);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const envFile = join(REPO_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  await registerP2SwarmRunner();
  const o: Orchestrator = orchestratorFromEnv(process.env, undefined, { onIdle: () => shutdownSandbox(o, process.env) });
  await o.start();
  const shutdown = async (sig: string) => {
    console.log(`[orchestrator] ${sig}: stopping (active runs will be marked "${RESTARTED}" on next start)`);
    await o.stop();
    await o.heartbeat().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
