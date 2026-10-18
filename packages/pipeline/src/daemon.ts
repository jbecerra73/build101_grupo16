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
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DecisionRequest, FixAttempt, FixRequest, FixResult, RunConfig, RunStatus } from "@frictionswarm/shared";
import {
  createStore,
  FsStore,
  getFlow,
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
import {
  analysisConfig,
  buildDeps,
  CANCELLED,
  DEFAULT_SEEDS_PER_PERSONA,
  PARKED,
  resumeFix,
  runPipeline,
  seedsFor,
  validateRequest,
  type PipelineDeps,
} from "./pipeline";
import { readJson, REPO_ROOT, writeJson } from "./runs";

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
  /** Pipeline wiring per run (tests inject fakes). Default: buildDeps from settings. */
  makeDeps?: DepsFactory;
  now?: () => Date;
};

type Active = { runId: string; controller: AbortController; done: Promise<RunStatus> };
/** Queued work, oldest first: a new run, or a fix of a finished analysis. */
type Work = { requestedAt: string } & ({ kind: "run"; item: QueuedRun } | { kind: "fix"; request: FixRequest });

/** The run files a fix or a decision reads, pulled from the store when mirroring. */
const RUN_FILES = ["config.json", "request.json", "status.json", "metrics.json", "findings.json", "fix.json"];

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
    });

export class Orchestrator {
  readonly store: RunStore;
  readonly workDir: string;
  readonly active = new Map<string, Active>();
  /** Decisions being applied. Short jobs: they do not count against maxConcurrent. */
  readonly deciding = new Map<string, Promise<void>>();
  readonly mirror?: RunMirror;
  #o: DaemonOptions;
  #log: Log;
  #startedAt = "";
  #queueDepth = 0;
  #timers: NodeJS.Timeout[] = [];
  #ticking?: Promise<void>;
  #stopped = false;

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
    if (wait) await Promise.all([...[...this.active.values()].map((a) => a.done), ...this.deciding.values()]);
  }

  /** Runs that were mid-flight when the orchestrator went away end failed.
   * Parked runs (awaiting a decision) were not mid-flight and stay parked. */
  async recover() {
    const prev = await this.store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat);
    const ids = new Set((prev?.activeRunIds ?? []).filter(isValidRunId));
    // fixture-* runs are frozen demo folders (fixture-live is deliberately mid-retest).
    for (const id of await this.store.listDirs("runs/")) if (isValidRunId(id) && !id.startsWith("fixture-")) ids.add(id);
    for (const runId of ids) {
      if (this.active.has(runId)) continue;
      const status = await this.store.getJson<RunStatus>(KEYS.runFile(runId, "status.json"));
      if (!status || TERMINAL.has(status.phase) || PARKED.has(status.phase)) continue;
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

  /** One poll: mirror + cancel checks for active runs, then take queued work
   * (new runs and fix requests) and apply decisions on parked runs. */
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
    const { fixes, decisions } = await this.#requests();
    const work: Work[] = [
      ...(await this.queue()).map((item): Work => ({ kind: "run", item, requestedAt: item.requestedAt })),
      ...fixes.map((request): Work => ({ kind: "fix", request, requestedAt: request.requestedAt ?? "" })),
    ].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    this.#queueDepth = work.length;
    const max = this.#o.maxConcurrent ?? 1;
    for (const w of work) {
      if (this.active.size >= max || this.#stopped) break;
      if (w.kind === "run") await this.take(w.item);
      else await this.takeFix(w.request);
      this.#queueDepth--;
    }
    for (const runId of decisions) {
      if (this.#stopped) break;
      if (this.active.has(runId) || this.deciding.has(runId)) continue;
      const p = this.applyDecisionRequest(runId)
        .catch((e) => this.#log(`${runId}: decision failed: ${errMsg(e)}`))
        .finally(() => this.deciding.delete(runId));
      this.deciding.set(runId, p);
    }
  }

  /** Fix requests (unreadable ones dropped) and run ids with a decision.json, from one store listing. */
  async #requests(): Promise<{ fixes: FixRequest[]; decisions: string[] }> {
    const fixes: FixRequest[] = [];
    const decisions: string[] = [];
    for (const key of await this.store.list("runs/")) {
      const [, runId, file, extra] = key.split("/");
      if (extra !== undefined || !isValidRunId(runId)) continue;
      if (file === "decision.json") decisions.push(runId);
      if (file !== "fix-request.json" || this.active.has(runId)) continue;
      const r = await this.store.getJson<FixRequest>(key);
      if (r) fixes.push({ ...r, runId });
      else {
        this.#log(`dropping unreadable fix request ${key}`);
        await this.store.delete(key);
      }
    }
    return { fixes, decisions };
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
    const flow = await getFlow(this.store, req.flowId);
    try {
      validateRequest(req, flow);
    } catch (e) {
      refusal = errMsg(e);
    }
    const config = await analysisConfig(runId, refusal ? { flowId: req.flowId, autoFix: false } : req, this.#now(), flow);
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

    this.#log(`${runId}: starting (${settings.swarmRunner} swarm, ${settings.fixLoop} fix loop, ${config.posthog.source} source, retest x${n} per persona)`);
    await this.#launch(runId, settings, (deps) => runPipeline(runId, { autoFix: req.autoFix, retestSeeds: seedsFor(seeds) }, deps));
  }

  /** Starts the fix of a finished analysis run (or drops the request when the
   * run is not one). Seeds are allocated like take(); the analysis already
   * counted against the daily cap. */
  async takeFix(request: FixRequest) {
    const { runId } = request;
    const requestKey = KEYS.fixRequest(runId);
    if (this.active.has(runId)) return;
    await this.#pull(runId);
    const status = await readJson<RunStatus>(join(this.workDir, runId, "status.json"));
    const config = await readJson<RunConfig>(join(this.workDir, runId, "config.json"));
    const fixed = await readJson<FixResult>(join(this.workDir, runId, "fix.json"));
    if (status?.phase !== "done" || config?.kind !== "analysis" || fixed?.attempts.length) {
      this.#log(`dropping fix request for ${runId}: not a finished analysis without a fix (${status?.phase ?? "no status"})`);
      await this.store.delete(requestKey);
      return;
    }
    const settings = await readSettings(this.store, this.#o.env);
    const usage = await readUsage(this.store, this.#now());
    const nextSeed = usage.nextSeed ?? 1;
    const n = Math.max(1, Math.min(10, Math.floor(request.seedsPerPersona ?? settings.defaultSeedsPerPersona ?? DEFAULT_SEEDS_PER_PERSONA) || 1));
    const seeds = Array.from({ length: n }, (_, i) => nextSeed + i);
    await this.store.putJson(KEYS.usage, { ...usage, nextSeed: nextSeed + n });
    const findingIds = request.findingIds?.length ? request.findingIds : undefined;

    this.#log(`${runId}: fixing ${findingIds?.join(", ") ?? "the top findings"} (${settings.fixLoop} fix loop, retest x${n} per persona)`);
    let started!: () => void;
    const firstStatus = new Promise<void>((r) => (started = r));
    await this.#launch(runId, settings, (deps) =>
      resumeFix(runId, { autoFix: true, retestSeeds: seedsFor(seeds), findingIds }, { ...deps, onStatus: (s) => (deps.onStatus?.(s), started()) }),
    );
    // Remove the request once the store shows the run reopened, so it is never seen done without a request.
    await Promise.race([firstStatus, this.active.get(runId)?.done]);
    await new Promise((r) => setTimeout(r, 50));
    await this.#sync(runId);
    await this.store.delete(requestKey);
  }

  /** Runs the pipeline (or its fix half) as an active run: mirrored and cancellable. */
  async #launch(runId: string, settings: Settings, run: (deps: PipelineDeps) => Promise<RunStatus>) {
    const controller = new AbortController();
    const log: Log = (l) => this.#log(`${runId} ${l}`);
    const deps = (this.#o.makeDeps ?? settingsDeps(this.#o.env))(settings, { runId, signal: controller.signal, workDir: this.workDir, log });
    const done = run({
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

  /** Applies decision.json to a run parked in awaiting-decision: merged or
   * rejected → done; refused or failed → stays parked with status.error. The
   * request is deleted either way (the Product Owner retries with a new one).
   * A decision on a run that is not parked is dropped. */
  async applyDecisionRequest(runId: string) {
    const key = KEYS.decision(runId);
    const request = await this.store.getJson<DecisionRequest>(key);
    const current = await this.store.getJson<RunStatus>(KEYS.runFile(runId, "status.json"));
    if (!request || current?.phase !== "awaiting-decision") {
      this.#log(`${runId}: dropping decision (run is ${current?.phase ?? "unknown"})`);
      await this.store.delete(key);
      return;
    }
    await this.#pull(runId);
    const dir = join(this.workDir, runId);
    const status = (await readJson<RunStatus>(join(dir, "status.json")))!;
    const fix = await readJson<FixResult>(join(dir, "fix.json"));
    const refusal = decisionRefusal(request, fix?.attempts.at(-1));
    const save = async (s: RunStatus) => {
      await writeJson(join(dir, "status.json"), s);
      await this.#sync(runId);
      await this.store.delete(key);
    };
    const parked = (error: string) => {
      this.#log(`${runId}: decision ${request.decision} not applied (${error})`);
      return save({ ...status, error, updatedAt: this.#now().toISOString() });
    };
    if (refusal) return parked(refusal);

    const settings = await readSettings(this.store, this.#o.env);
    const log: Log = (l) => this.#log(`${runId} ${l}`);
    const deps = (this.#o.makeDeps ?? settingsDeps(this.#o.env))(settings, { runId, signal: new AbortController().signal, workDir: this.workDir, log });
    let attempt: FixAttempt;
    try {
      attempt = await deps.applyDecision({ runsDir: this.workDir, runId, request, log });
    } catch (e) {
      return parked(errMsg(e));
    }
    const message = decisionMessage(request.decision, attempt);
    const at = this.#now().toISOString();
    const { error: _error, ...rest } = status;
    log(`done: ${message}`);
    await save({ ...rest, phase: "done", message, updatedAt: at, history: [...(status.history ?? []), { phase: "done", at, message }] });
  }

  /** Copies the run's files from the store over the work dir (mirroring only):
   * the run is not active, so the store has its latest state, and after a
   * restart elsewhere the work dir may not have them at all. */
  async #pull(runId: string) {
    if (!this.mirror) return;
    for (const f of RUN_FILES) {
      const bytes = await this.store.getBytes(KEYS.runFile(runId, f));
      if (!bytes) continue;
      await mkdir(join(this.workDir, runId), { recursive: true });
      await writeFile(join(this.workDir, runId, f), bytes);
    }
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

/** Why a decision cannot be applied to this attempt, if it cannot. */
function decisionRefusal(r: DecisionRequest, last: FixAttempt | undefined): string | undefined {
  if (r.decision !== "accept" && r.decision !== "reject") return `Unknown decision "${String(r.decision)}" (accept|reject)`;
  if (last?.status !== "ready" && last?.status !== "not-proven") return `No fix awaiting a decision (last attempt: ${last?.status ?? "none"})`;
  if (r.decision === "accept" && last.status === "not-proven" && !r.override) return "Fix not proven: pass override to accept anyway";
  return undefined;
}

function decisionMessage(decision: DecisionRequest["decision"], a: FixAttempt): string {
  if (a.decision?.rehearsal) return decision === "accept" ? "Merged (rehearsal — no PR merged)" : "Rejected (rehearsal — no PR closed)";
  if (decision === "reject") return `Rejected: PR #${a.prNumber} closed`;
  const sha = a.decision?.mergeSha?.slice(0, 7);
  return `Merged PR #${a.prNumber}${sha ? ` (${sha})` : ""}`;
}

function gitVersion(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

/** Orchestrator configured from env (RUN_STORE, RUNS_DIR, ORCHESTRATOR_WORK_DIR, ...). */
export function orchestratorFromEnv(env: Env = process.env, log?: Log): Orchestrator {
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
  });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const envFile = join(REPO_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const o = orchestratorFromEnv();
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
