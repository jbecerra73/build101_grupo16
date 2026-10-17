// The demo loop (SPEC "Orchestrator & dashboard"):
//   analyzing        PostHog (real users, analysis window) → analyzer → report
//   fixing           coding agent fixes the top findings (autoFix only)
//   waiting-preview  draft PR open, waiting for the deploy preview
//   retesting        persona swarm on the preview, fresh seeds
//   collecting       waiting for PostHog to ingest the swarm's events
//   comparing        analyzer on the swarm's tracks, persona vs segment verdict
//   awaiting-decision  fix retested; parked until the Product Owner accepts or rejects the PR
//   done | failed
// There is no baseline swarm: "before" is real users, "after" is the swarm.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLOWS,
  PERSONAS,
  PRODUCTION_URL,
  type Flow,
  type FixResult,
  type PersonaId,
  type PostHogSourceKind,
  type RunConfig,
  type RunPhase,
  type RunStatus,
  type StartRunRequest,
} from "@frictionswarm/shared";
import type { PostHogSource } from "@frictionswarm/posthog";
import { fakeApplyDecision, fakeFixLoop } from "./fakeFix";
import { realApplyDecision, realFixLoop, type Analyzer, type ApplyDecision, type Compare, type FixLoop } from "./fixLoop";
import { defaultDataDir, offlineSwarmRunner } from "./offline";
import { allocateSeeds, newRunId, readJson, reserveRun, runsDir as defaultRunsDir, writeJson } from "./runs";
import { tenkiSwarmRunner, type SwarmRunner } from "./swarm";

export type { Analyzer, ApplyDecision, Compare, FixLoop, SwarmRunner };

/** The three personas of the re-test: Rosa and Kai stand in for the hurt
 * segments, Typical for the control. */
export const RETEST_PERSONAS: PersonaId[] = ["rosa", "kai", "typical"];
export const DEFAULT_SEEDS_PER_PERSONA = 10;
export const WINDOW_DAYS = 28;

export type PipelineDeps = {
  runsDir: string;
  /** PostHog source by kind (file = offline dataset, api = HogQL). */
  source: (kind: PostHogSourceKind) => PostHogSource;
  analyze: Analyzer;
  compare: Compare;
  runSwarm: SwarmRunner;
  fixLoop: FixLoop;
  /** Merges or closes the fix's PR once the Product Owner decides. */
  applyDecision: ApplyDecision;
  /** How long collecting waits for PostHog ingestion. Default 5 min. */
  collectTimeoutMs?: number;
  onStatus?: (s: RunStatus) => void;
  log?: (line: string) => void;
  /** How often fix.json is checked for the draft → waiting-preview transition. */
  fixWatchMs?: number;
  /** Cancels the run: checked between phases, and the current phase is abandoned.
   * The run ends failed with error "cancelled". */
  signal?: AbortSignal;
};

export type RunOptions = {
  autoFix: boolean;
  /** Fresh seeds per persona for the re-test swarm. */
  retestSeeds: Record<PersonaId, number[]>;
  /** The findings the Product Owner chose to fix (default: the fix loop picks). */
  findingIds?: string[];
};

export type StartOptions = Partial<PipelineDeps> & { maxRunsPerDay?: number };

const ORDER: RunPhase[] = ["analyzing", "fixing", "waiting-preview", "retesting", "collecting", "comparing", "awaiting-decision", "done"];
/** Phases where a run is parked, not progressing: it waits for a person. */
export const PARKED = new Set<RunPhase>(["awaiting-decision"]);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const CANCELLED = "cancelled";
const DAY = 86_400_000;
const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Resolves/rejects with `p`, or rejects with "cancelled" as soon as `signal` aborts. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error(CANCELLED));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(CANCELLED));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Default analysis window: the last 28 days, up to and including today ([from, to)). */
export function defaultWindow(now = new Date()): { from: string; to: string } {
  const to = Date.parse(isoDate(now.getTime())) + DAY;
  return { from: isoDate(to - WINDOW_DAYS * DAY), to: isoDate(to) };
}

type Manifest = { releases?: { sha: string; date: string; name: string }[] };

/** The current production release (build_sha) as far as we know without
 * querying: the file dataset's manifest. Empty when unknown (the analyzer then
 * measures every release in the window). */
export async function currentReleaseSha(kind: PostHogSourceKind, dataDir = defaultDataDir()): Promise<string> {
  if (kind === "api") return process.env.PRODUCTION_BUILD_SHA ?? "";
  const m = await readFile(join(dataDir, "events.manifest.json"), "utf8").then((t) => JSON.parse(t) as Manifest, () => undefined);
  return m?.releases?.at(-1)?.sha ?? "";
}

const DATE = /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/;

export function validateRequest(req: StartRunRequest, flow: Flow | undefined): void {
  if (!flow) throw new Error(`Unknown flow "${req.flowId}"`);
  if (typeof req.autoFix !== "boolean") throw new Error("autoFix must be a boolean");
  if (req.source !== undefined && req.source !== "file" && req.source !== "api") throw new Error(`Unknown source "${req.source}" (file|api)`);
  if (req.window) {
    const { from, to } = req.window;
    if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
      throw new Error("window.from and window.to must be ISO dates (YYYY-MM-DD)");
    if (Date.parse(from) >= Date.parse(to)) throw new Error("window.from must be before window.to");
  }
  const n = req.seedsPerPersona;
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 10)) throw new Error("seedsPerPersona must be an integer from 1 to 10");
}

/** The analysis run's config for a request. The default window (no
 * req.window) is the current production release over the last 28 days; an
 * explicit window covers every release in it. */
export async function analysisConfig(runId: string, req: StartRunRequest, now = new Date(), flow?: Flow): Promise<RunConfig> {
  const source = req.source ?? (process.env.POSTHOG_SOURCE === "api" ? "api" : "file");
  return {
    runId,
    kind: "analysis",
    flowId: req.flowId,
    flow,
    window: req.window ?? defaultWindow(now),
    posthog: { source, buildSha: req.window ? "" : await currentReleaseSha(source) },
    personaIds: [],
    seeds: {},
    targetUrl: PRODUCTION_URL,
    createdAt: now.toISOString(),
  };
}

/** The same fresh seeds for every re-test persona. */
export const seedsFor = (seeds: number[]): Record<PersonaId, number[]> => Object.fromEntries(RETEST_PERSONAS.map((p) => [p, seeds]));

/** Validate, enforce the runs/day cap, write config.json + status.json, and
 * run the pipeline in the background. Resolves as soon as the run exists. */
export async function startPipeline(
  req: StartRunRequest,
  opts: StartOptions = {},
): Promise<{ runId: string; done: Promise<RunStatus> }> {
  const flow = Object.hasOwn(FLOWS, req.flowId) ? FLOWS[req.flowId] : undefined;
  validateRequest(req, flow);
  const deps = { ...defaultDeps(opts.runsDir, opts.log), ...opts };
  await reserveRun(deps.runsDir, opts.maxRunsPerDay ?? Number(process.env.MAX_RUNS_PER_DAY ?? 10));
  const runId = newRunId();
  const seeds = await allocateSeeds(deps.runsDir, req.seedsPerPersona ?? DEFAULT_SEEDS_PER_PERSONA);
  await writeJson(join(deps.runsDir, runId, "config.json"), await analysisConfig(runId, req, new Date(), flow));
  await writeJson(join(deps.runsDir, runId, "request.json"), req);
  const status: RunStatus = { runId, phase: "analyzing", updatedAt: new Date().toISOString(), message: "Starting" };
  await writeJson(join(deps.runsDir, runId, "status.json"), status);
  const done = runPipeline(runId, { autoFix: req.autoFix, retestSeeds: seedsFor(seeds) }, deps);
  done.catch(() => {}); // runPipeline never rejects; belt and braces
  return { runId, done };
}

const range = (w?: { from: string; to: string }) => (w ? `${w.from} → ${w.to}` : "all time");

/** The demo loop for an analysis run whose config.json exists. Never rejects:
 * failures end in status.json phase "failed" (fix.json is kept by the fix loop). */
export async function runPipeline(runId: string, opts: RunOptions, deps: PipelineDeps): Promise<RunStatus> {
  const dir = join(deps.runsDir, runId);
  const log = deps.log ?? (() => {});
  let status: RunStatus = { runId, phase: "analyzing", updatedAt: new Date().toISOString() };
  let writes = Promise.resolve();
  const set = (phase: RunPhase, message: string, extra: Partial<RunStatus> = {}) => {
    if (phase !== "failed" && deps.signal?.aborted) return Promise.reject(new Error(CANCELLED));
    // Phases only move forward (the fix.json watcher may lag behind).
    if (phase !== "failed" && ORDER.indexOf(phase) < ORDER.indexOf(status.phase)) return writes;
    if (phase === status.phase && message === status.message && !Object.keys(extra).length) return writes;
    const at = new Date().toISOString();
    status = { ...status, ...extra, phase, message, updatedAt: at, history: [...(status.history ?? []), { phase, at, message }] };
    const snap = status;
    deps.onStatus?.(snap);
    return (writes = writes.catch(() => {}).then(() => writeJson(join(dir, "status.json"), snap)));
  };

  try {
    const config = (await readJson<RunConfig>(join(dir, "config.json")))!;
    const release = config.posthog.buildSha ? ` on ${config.posthog.buildSha.slice(0, 7)}` : "";
    await set("analyzing", `Reading real-user events from PostHog (${config.posthog.source}, ${range(config.window)}${release})`);
    const { findings } = await abortable(deps.analyze(runId), deps.signal);

    if (!opts.autoFix) return await set("done", `Report ready: ${findings.length} findings`).then(() => status);
    if (!findings.length) return await set("done", "No findings to fix").then(() => status);

    await set("fixing", opts.findingIds ? `Coding agent is fixing ${opts.findingIds.join(", ")}` : "Coding agent is fixing the top findings");
    const watcher = setInterval(async () => {
      const fix = await readJson<FixResult>(join(dir, "fix.json")).catch(() => undefined);
      const a = fix?.attempts.at(-1);
      if (a?.status === "draft")
        void set("waiting-preview", `Draft ${a.prNumber ? `PR #${a.prNumber}` : "PR (rehearsal)"}: waiting for the preview to deploy ${a.commitSha?.slice(0, 7)}`).catch(() => {});
    }, deps.fixWatchMs ?? 500);
    let result: FixResult;
    try {
      result = await abortable(
        deps.fixLoop({
          baselineRunId: runId,
          runsDir: deps.runsDir,
          log,
          retestSeeds: opts.retestSeeds,
          findingIds: opts.findingIds,
          compare: deps.compare,
          runSwarm: async (c) => {
            const n = Object.values(c.seeds).flat().length;
            await set("retesting", `Swarm re-testing the preview: ${n} agents (${c.personaIds.join(", ")}), fresh seeds`, { retestRunId: c.runId });
            await deps.runSwarm(c);
          },
          collect: async (c) => {
            await set("collecting", "Waiting for PostHog to ingest the swarm's events");
            const agentIds = c.personaIds.flatMap((p) => (c.seeds[p] ?? []).map((s) => `${p}-${s}`));
            await deps.source(c.posthog.source).waitForSwarm({ runId: c.runId, agentIds, timeoutMs: deps.collectTimeoutMs ?? 5 * 60_000 });
          },
          analyze: async (id) => {
            await set("comparing", "Analyzing the swarm's tracks and comparing each persona to its segment");
            return deps.analyze(id);
          },
        }),
        deps.signal,
      );
    } finally {
      clearInterval(watcher);
    }
    const last = result.attempts.at(-1);
    const pr = last?.prNumber ? `PR #${last.prNumber}` : undefined;
    const where = pr ?? "(rehearsal)";
    if (last?.status === "ready") return await set("awaiting-decision", `Improved: ${where} ready, awaiting your decision`).then(() => status);
    if (last?.status === "not-proven")
      return await set("awaiting-decision", `Not proven: ${where} labelled not-proven, awaiting your decision`).then(() => status);
    const msg = `Fix loop ended (${last?.status ?? "no attempt"})`;
    return await set("done", msg).then(() => status);
  } catch (e) {
    const cancelled = deps.signal?.aborted || errMsg(e) === CANCELLED;
    await set("failed", cancelled ? `Cancelled during ${status.phase}` : `Failed during ${status.phase}`, { error: cancelled ? CANCELLED : errMsg(e) }).catch(() => {});
    return status;
  }
}

// ---------------------------------------------------------------- wiring

type PostHogModule = typeof import("@frictionswarm/posthog");
type AnalyzerModule = typeof import("@frictionswarm/analyzer");

/** The PostHog package and the analyzer are loaded lazily, so a run can start
 * before the analyzer (and the Anthropic SDKs it pulls in) is loaded. The
 * specifiers are literals so bundlers (Next/Turbopack) can resolve them. */
let posthogMod: Promise<PostHogModule> | undefined;
let analyzerMod: Promise<AnalyzerModule> | undefined;
const loadPostHog = () => (posthogMod ??= import("@frictionswarm/posthog"));
const loadAnalyzer = () =>
  (analyzerMod ??= import("@frictionswarm/analyzer").catch((e) => {
    analyzerMod = undefined;
    throw new Error(`Analyzer unavailable: could not import @frictionswarm/analyzer (${errMsg(e)})`);
  }));

/** A PostHogSource that loads @frictionswarm/posthog on first use. */
export function lazySource(kind: PostHogSourceKind): PostHogSource {
  const real = loadPostHog().then((m) => m.createPostHogSource(kind));
  return {
    realUserEvents: (q) => ({ async *[Symbol.asyncIterator]() { yield* (await real).realUserEvents(q); } }),
    swarmEvents: (q) => ({ async *[Symbol.asyncIterator]() { yield* (await real).swarmEvents(q); } }),
    waitForSwarm: async (q) => (await real).waitForSwarm(q),
  };
}

export function sourcesByKind(): (kind: PostHogSourceKind) => PostHogSource {
  const cache = new Map<PostHogSourceKind, PostHogSource>();
  return (kind) => {
    let s = cache.get(kind);
    if (!s) cache.set(kind, (s = lazySource(kind)));
    return s;
  };
}

/** The analyzer for runs under `runsDir`, on the source each run's config names. */
export function moduleAnalyzer(runsDir: string, source: (kind: PostHogSourceKind) => PostHogSource, log?: (line: string) => void): Analyzer {
  return async (runId) => {
    const { createAnalyzer } = await loadAnalyzer();
    const config = await readJson<RunConfig>(join(runsDir, runId, "config.json"));
    const kind = config?.posthog.source ?? "file";
    const result = await createAnalyzer({ runsDir, source: source(kind), log } as Parameters<AnalyzerModule["createAnalyzer"]>[0])(runId);
    await ensureSnapshot(runsDir, runId, source(kind));
    return result;
  };
}

/** runs/<runId>/posthog.jsonl: what the analyzer read, so the run replays offline.
 * Written here only when the analyzer did not write it itself. */
export async function ensureSnapshot(runsDir: string, runId: string, source: PostHogSource) {
  const file = join(runsDir, runId, "posthog.jsonl");
  if (existsSync(file)) return;
  const config = await readJson<RunConfig>(join(runsDir, runId, "config.json"));
  if (!config) return;
  const { snapshot } = await loadPostHog();
  const events =
    config.kind === "retest"
      ? source.swarmEvents({ runId, buildSha: config.posthog.buildSha })
      : source.realUserEvents({ ...defaultWindow(), ...config.window, ...(config.posthog.buildSha ? { buildSha: config.posthog.buildSha } : {}) });
  await snapshot(events, join(runsDir, runId));
}

/** The analyzer's compareSegmentsToPersonas, loaded with the analyzer. Sync
 * callers (the fix loop) get it after the first analysis has loaded the module. */
export function moduleCompare(): Compare {
  let compare: Awaited<ReturnType<typeof loadAnalyzer>>["compareSegmentsToPersonas"] | undefined;
  void loadAnalyzer().then((m) => (compare = m.compareSegmentsToPersonas), () => {});
  return (a, r, t, flow) => {
    if (!compare) throw new Error("Analyzer not loaded yet: compareSegmentsToPersonas unavailable");
    return compare(a, r, t, { flow });
  };
}

export type DepsConfig = {
  runsDir: string;
  swarmRunner: "offline" | "tenki";
  fixLoop: "fake" | "real";
  /** Offline swarm speed (>1 is faster); 1 = ~30 s on screen. */
  swarmSpeed: number;
  fixStageDelayMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

/** Pipeline wiring from explicit settings (the daemon passes settings.json). */
export function buildDeps(c: DepsConfig): PipelineDeps {
  const log = c.log ?? (() => {});
  const signal = c.signal ?? new AbortController().signal;
  const source = sourcesByKind();
  const speed = c.swarmSpeed > 0 ? c.swarmSpeed : 1;
  const runSwarm: SwarmRunner =
    c.swarmRunner === "offline"
      ? offlineSwarmRunner({ runsDir: c.runsDir, durationMs: 30_000 / speed, ingestLagMs: 4_000 / speed, bootMs: 1_200 / speed, signal })
      : tenkiSwarmRunner({
          runsDir: c.runsDir,
          signal,
          log,
          reportTopology: (t) => writeJson(join(c.runsDir, t.runId, "swarm.json"), t),
        });
  return {
    runsDir: c.runsDir,
    source,
    runSwarm,
    analyze: moduleAnalyzer(c.runsDir, source, c.log),
    compare: moduleCompare(),
    signal: c.signal,
    log: c.log,
    fixLoop: c.fixLoop === "fake" ? fakeFixLoop({ stageDelayMs: c.fixStageDelayMs ?? 1500 }) : realFixLoop(),
    applyDecision: c.fixLoop === "fake" ? fakeApplyDecision : realApplyDecision(),
  };
}

/** Wiring from env: SWARM_RUNNER=offline|tenki (p2 is an alias), RUNS_DIR,
 * SWARM_SPEED, FIX_LOOP=real|fake (fake = offline rehearsal, default with the
 * offline swarm), FIX_STAGE_DELAY_MS. */
export function defaultDeps(runsDir = defaultRunsDir(), log?: (line: string) => void): PipelineDeps {
  const env = process.env.SWARM_RUNNER ?? "offline";
  if (!["offline", "replay", "tenki", "p2"].includes(env)) throw new Error(`Unknown SWARM_RUNNER "${env}" (offline|tenki)`);
  const swarmRunner = env === "tenki" || env === "p2" ? "tenki" : "offline";
  const fixMode = process.env.FIX_LOOP ?? (swarmRunner === "offline" ? "fake" : "real");
  if (fixMode !== "fake" && fixMode !== "real") throw new Error(`Unknown FIX_LOOP "${fixMode}" (real|fake)`);
  return buildDeps({
    runsDir,
    log,
    swarmRunner,
    fixLoop: fixMode,
    swarmSpeed: Number(process.env.SWARM_SPEED ?? process.env.REPLAY_SPEED ?? 1),
    fixStageDelayMs: Number(process.env.FIX_STAGE_DELAY_MS ?? 1500),
  });
}

/** Personas known to the shared presets (for validation in callers). */
export const knownPersona = (id: string) => !!PERSONAS[id];
