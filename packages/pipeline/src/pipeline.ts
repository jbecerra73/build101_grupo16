import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS,
  PERSONAS,
  PRODUCTION_URL,
  type FixResult,
  type RunConfig,
  type RunPhase,
  type RunStatus,
  type StartRunRequest,
} from "@frictionswarm/shared";
import { runFixLoop, verifyProductionBuild, type Analyzer, type FixLoopOptions, type SwarmRunner } from "../../../orchestrator/fix-loop";
import { readBuildSha } from "../../../orchestrator/preview";
import { localShell, tenkiShell } from "../../../orchestrator/shell";
import { fakeFixLoop } from "./fakeFix";
import { recordedBuildSha, replaySwarmRunner } from "./replay";
import { tenkiSwarmRunner } from "./swarm";
import { allocateSeeds, newRunId, readJson, REPO_ROOT, reserveRun, runsDir as defaultRunsDir, writeJson } from "./runs";

export type { Analyzer, SwarmRunner };

/** The slice of P1's runFixLoop the pipeline drives (stubbed in tests). */
export type FixLoop = (
  opts: Pick<FixLoopOptions, "baselineRunId" | "runSwarm" | "analyze" | "runsDir" | "log">,
) => Promise<FixResult>;

export type PipelineDeps = {
  runsDir: string;
  runSwarm: SwarmRunner;
  analyze: Analyzer;
  /** Returns the build-sha the swarm will test at targetUrl. */
  verifyBuild: (targetUrl: string) => Promise<string>;
  fixLoop: FixLoop;
  onStatus?: (s: RunStatus) => void;
  log?: (line: string) => void;
  /** How often fix.json is checked for the draft → waiting-preview transition. */
  fixWatchMs?: number;
  /** Cancels the run: checked between phases, and the current phase is abandoned.
   * The run ends failed with error "cancelled". */
  signal?: AbortSignal;
};

export type StartOptions = Partial<PipelineDeps> & { maxRunsPerDay?: number };

const ORDER: RunPhase[] = ["verifying", "swarming", "analyzing", "fixing", "waiting-preview", "retesting", "comparing", "done"];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const CANCELLED = "cancelled";

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

export function validateRequest(req: StartRunRequest): void {
  if (!FLOWS[req.flowId]) throw new Error(`Unknown flow "${req.flowId}"`);
  if (!req.personaIds?.length) throw new Error("Pick at least one persona");
  const unknown = req.personaIds.filter((p) => !PERSONAS[p]);
  if (unknown.length) throw new Error(`Unknown persona(s): ${unknown.join(", ")}`);
  if (new Set(req.personaIds).size !== req.personaIds.length) throw new Error("Duplicate persona");
  if (!Number.isInteger(req.seedsPerPersona) || req.seedsPerPersona < 1 || req.seedsPerPersona > 10)
    throw new Error("seedsPerPersona must be an integer from 1 to 10");
  if (req.targetUrl) new URL(req.targetUrl);
}

/** Validate, enforce the runs/day cap, write config.json + status.json, and
 * run the pipeline in the background. Resolves as soon as the run exists. */
export async function startPipeline(
  req: StartRunRequest,
  opts: StartOptions = {},
): Promise<{ runId: string; done: Promise<RunStatus> }> {
  validateRequest(req);
  const deps = { ...defaultDeps(opts.runsDir, opts.log), ...opts };
  await reserveRun(deps.runsDir, opts.maxRunsPerDay ?? Number(process.env.MAX_RUNS_PER_DAY ?? 10));
  const runId = newRunId();
  const seedList = await allocateSeeds(deps.runsDir, req.seedsPerPersona);
  const config: RunConfig = {
    runId,
    kind: "baseline",
    flowId: req.flowId,
    personaIds: req.personaIds,
    seeds: Object.fromEntries(req.personaIds.map((p) => [p, seedList])),
    targetUrl: req.targetUrl ?? FLOWS[req.flowId].startUrl,
    buildSha: "unverified",
    createdAt: new Date().toISOString(),
  };
  await writeJson(join(deps.runsDir, runId, "config.json"), config);
  const status: RunStatus = { runId, phase: "verifying", updatedAt: new Date().toISOString(), message: "Starting" };
  await writeJson(join(deps.runsDir, runId, "status.json"), status);
  const done = runPipeline(runId, req.autoFix, deps);
  done.catch(() => {}); // runPipeline never rejects; belt and braces
  return { runId, done };
}

/** The demo loop for a run whose config.json exists. Never rejects: failures
 * end in status.json phase "failed" (fix.json is kept up to date by runFixLoop). */
export async function runPipeline(runId: string, autoFix: boolean, deps: PipelineDeps): Promise<RunStatus> {
  const dir = join(deps.runsDir, runId);
  const log = deps.log ?? (() => {});
  let status: RunStatus = { runId, phase: "verifying", updatedAt: new Date().toISOString() };
  let writes = Promise.resolve();
  const set = (phase: RunPhase, message: string, extra: Partial<RunStatus> = {}) => {
    if (phase !== "failed" && deps.signal?.aborted) return Promise.reject(new Error(CANCELLED));
    // Phases only move forward (the fix.json watcher may lag behind).
    if (phase !== "failed" && ORDER.indexOf(phase) < ORDER.indexOf(status.phase)) return writes;
    if (phase === status.phase && message === status.message) return writes;
    status = { ...status, ...extra, phase, message, updatedAt: new Date().toISOString() };
    const snap = status;
    deps.onStatus?.(snap);
    return (writes = writes.catch(() => {}).then(() => writeJson(join(dir, "status.json"), snap)));
  };

  try {
    const config = (await readJson<RunConfig>(join(dir, "config.json")))!;
    await set("verifying", `Checking the build at ${config.targetUrl}`);
    config.buildSha = await abortable(deps.verifyBuild(config.targetUrl), deps.signal);
    await writeJson(join(dir, "config.json"), config);

    const n = Object.values(config.seeds).flat().length;
    await set("swarming", `Swarm running: ${n} agents (${config.personaIds.join(", ")}) on ${config.buildSha.slice(0, 7)}`);
    await abortable(deps.runSwarm(config), deps.signal);

    await set("analyzing", "Analyzing events");
    const { findings } = await abortable(deps.analyze(runId), deps.signal);

    if (!autoFix) return await set("done", `Report ready: ${findings.length} findings`).then(() => status);
    if (!findings.length) return await set("done", "No findings to fix").then(() => status);

    await set("fixing", "Coding agent is fixing the top findings");
    const watcher = setInterval(async () => {
      const fix = await readJson<FixResult>(join(dir, "fix.json")).catch(() => undefined);
      const a = fix?.attempts.at(-1);
      if (a?.status === "draft") void set("waiting-preview", `Draft ${a.prNumber ? `PR #${a.prNumber}` : "PR (rehearsal)"}: waiting for the preview to deploy ${a.commitSha?.slice(0, 7)}`).catch(() => {});
    }, deps.fixWatchMs ?? 500);
    let result: FixResult;
    try {
      result = await abortable(deps.fixLoop({
        baselineRunId: runId,
        runsDir: deps.runsDir,
        log,
        runSwarm: async (c) => {
          await set("retesting", `Re-testing the preview with fresh seeds (${c.runId})`, { retestRunId: c.runId });
          await deps.runSwarm(c);
        },
        analyze: async (id) => {
          await set("comparing", "Analyzing the re-test and comparing before/after");
          return deps.analyze(id);
        },
      }), deps.signal);
    } finally {
      clearInterval(watcher);
    }
    const last = result.attempts.at(-1);
    const pr = last?.prNumber ? `PR #${last.prNumber}` : undefined;
    const msg =
      last?.status === "ready" ? `Improved: ${pr ? `${pr} marked ready for review` : "fix proven (rehearsal, no PR opened)"}`
      : last?.status === "not-proven" ? `Fix attempted, not proven: ${pr ? `${pr} closed` : "rehearsal, no PR opened"}`
      : `Fix loop ended (${last?.status ?? "no attempt"})`;
    return await set("done", msg).then(() => status);
  } catch (e) {
    const cancelled = deps.signal?.aborted || errMsg(e) === CANCELLED;
    await set("failed", cancelled ? `Cancelled during ${status.phase}` : `Failed during ${status.phase}`, { error: cancelled ? CANCELLED : errMsg(e) }).catch(() => {});
    return status;
  }
}

/** Analyzer from @frictionswarm/analyzer, loaded lazily so a run can start
 * before the analyzer (and the Anthropic SDKs it pulls in) is loaded. The
 * specifier is a literal so bundlers (Next/Turbopack) can resolve it; the
 * analyzer logs which findings path it used (agent-sdk | messages-api | heuristic). */
export function moduleAnalyzer(runsDir: string, log?: (line: string) => void): Analyzer {
  let loaded: Promise<Analyzer> | undefined;
  return async (runId) => {
    loaded ??= import("@frictionswarm/analyzer").then(
      ({ createAnalyzer }) => createAnalyzer({ runsDir, log }),
      (e) => {
        throw new Error(`Analyzer unavailable: could not import @frictionswarm/analyzer (${errMsg(e)}). Pass opts.analyze.`);
      },
    );
    return (await loaded)(runId);
  };
}

export type DepsConfig = {
  runsDir: string;
  swarmRunner: "replay" | "tenki";
  fixLoop: "fake" | "real";
  replaySpeed: number;
  verifyBuild: boolean;
  replayDir?: string;
  replayRetestDir?: string;
  fixStageDelayMs?: number;
  fixShell?: "tenki" | "local";
  signal?: AbortSignal;
  log?: (line: string) => void;
};

/** Pipeline wiring from explicit settings (the daemon passes settings.json). */
export function buildDeps(c: DepsConfig): PipelineDeps {
  const replayDir = c.replayDir ?? join(REPO_ROOT, "runs", "fixture-baseline");
  const log = c.log ?? (() => {});
  const signal = c.signal ?? new AbortController().signal;
  const runSwarm: SwarmRunner =
    c.swarmRunner === "replay"
      ? replaySwarmRunner({ runsDir: c.runsDir, sourceDir: replayDir, retestSourceDir: c.replayRetestDir, speed: c.replaySpeed, signal })
      : tenkiSwarmRunner({
          runsDir: c.runsDir,
          signal,
          log,
          reportTopology: (t) => writeJson(join(c.runsDir, t.runId, "swarm.json"), t),
        });
  return {
    runsDir: c.runsDir,
    runSwarm,
    analyze: moduleAnalyzer(c.runsDir, c.log),
    signal: c.signal,
    log: c.log,
    verifyBuild: async (url) => {
      if (!c.verifyBuild) return recordedBuildSha(replayDir);
      if (new URL(url).origin === new URL(PRODUCTION_URL).origin) return verifyProductionBuild();
      const sha = await readBuildSha(url);
      if (!sha) throw new Error(`No <meta name="build-sha"> at ${url}`);
      return sha;
    },
    fixLoop:
      c.fixLoop === "fake"
        ? fakeFixLoop({ stageDelayMs: c.fixStageDelayMs ?? 1500 })
        : (o) =>
            runFixLoop({
              ...o,
              shell: async () =>
                c.fixShell === "local"
                  ? localShell(await mkdtemp(join(tmpdir(), "frictionswarm-fix-")))
                  : tenkiShell(`fix-${o.baselineRunId}`),
            }),
  };
}

/** Wiring from env: SWARM_RUNNER=replay|tenki (p2 is an alias), RUNS_DIR, REPLAY_DIR,
 * REPLAY_RETEST_DIR, REPLAY_SPEED, VERIFY_BUILD=0|1, FIX_LOOP=real|fake (fake = offline
 * rehearsal, default with replay), FIX_STAGE_DELAY_MS, FIX_SHELL=tenki|local. */
export function defaultDeps(runsDir = defaultRunsDir(), log?: (line: string) => void): PipelineDeps {
  const env = process.env.SWARM_RUNNER ?? "replay";
  if (env !== "replay" && env !== "tenki" && env !== "p2") throw new Error(`Unknown SWARM_RUNNER "${env}" (replay|tenki)`);
  const swarmRunner = env === "replay" ? "replay" : "tenki";
  const fixMode = process.env.FIX_LOOP ?? (swarmRunner === "replay" ? "fake" : "real");
  if (fixMode !== "fake" && fixMode !== "real") throw new Error(`Unknown FIX_LOOP "${fixMode}" (real|fake)`);
  return buildDeps({
    runsDir,
    log,
    swarmRunner,
    fixLoop: fixMode,
    replaySpeed: Number(process.env.REPLAY_SPEED ?? 1),
    verifyBuild: process.env.VERIFY_BUILD ? process.env.VERIFY_BUILD !== "0" : swarmRunner !== "replay",
    replayDir: process.env.REPLAY_DIR,
    replayRetestDir: process.env.REPLAY_RETEST_DIR,
    fixStageDelayMs: Number(process.env.FIX_STAGE_DELAY_MS ?? 1500),
    fixShell: process.env.FIX_SHELL === "local" ? "local" : "tenki",
  });
}
