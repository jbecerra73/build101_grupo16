// Server side of the control center (see lib/control-types.ts for the contract).
import "server-only";
import type { RunConfig, RunStatus, StartRunRequest } from "@frictionswarm/shared";
import {
  isOnline,
  KEYS,
  parseSettings,
  readSettings,
  readUsage,
  type CancelRequest,
  type OrchestratorHeartbeat,
  type Settings,
  type SwarmTopology,
} from "@frictionswarm/store";
import type { ControlOverview, OrchestratorLaunch } from "./control-types";
import { enqueueRun } from "./orchestrator";
import { isValidRunId, listQueue, listRuns, placeholderConfig } from "./runs";
import { runStore } from "./store";
import type { RunSummary } from "./types";

const TERMINAL = new Set(["done", "failed"]);
const RECENT = 20;

/** Active = not done/failed. Retests are shown through their baseline, and the
 * frozen fixture-* demo folders are never active. */
export const isActive = (r: RunSummary) => !TERMINAL.has(r.status.phase) && r.config.kind !== "retest" && !r.runId.startsWith("fixture-");

export async function getControlOverview(now = Date.now()): Promise<ControlOverview> {
  const store = runStore();
  const [runs, queued, settings, usage, hb] = await Promise.all([
    listRuns(),
    listQueue(),
    readSettings(store),
    readUsage(store, new Date(now)),
    store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat).catch(() => undefined),
  ]);
  const online = isOnline(hb, now);
  const launch = online ? undefined : await store.getJson<OrchestratorLaunch>(KEYS.launch).catch(() => undefined);
  return {
    active: runs.filter(isActive),
    recent: runs.filter((r) => !isActive(r)).slice(0, RECENT),
    queued,
    usage: { date: usage.date, runs: usage.runs, max: settings.maxRunsPerDay },
    settings,
    // Omitted when missing or stale: the UI shows the orchestrator offline.
    ...(online ? { orchestrator: hb } : {}),
    ...(launch ? { launch: { state: launch.state, requestedAt: launch.requestedAt, updatedAt: launch.updatedAt, sandboxId: launch.sandboxId, error: launch.error } } : {}),
  };
}

export const getSwarm = (runId: string) =>
  isValidRunId(runId) ? runStore().getJson<SwarmTopology>(KEYS.swarm(runId)) : Promise.resolve(undefined);

export const getSettings = () => readSettings(runStore());

export async function updateSettings(body: unknown): Promise<{ ok: true; value: Settings } | { ok: false; errors: string[] }> {
  const parsed = parseSettings(body, await getSettings());
  if (parsed.ok) await runStore().putJson(KEYS.settings, parsed.value);
  return parsed;
}

export type ControlResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Cancels a queued or running run. A queued run is removed from the queue and
 * ends failed right away; a running one gets cancel.json, which the
 * orchestrator checks between phases. */
export async function cancelRun(runId: string, reason?: string): Promise<ControlResult<{ ok: true }>> {
  if (!isValidRunId(runId)) return { ok: false, status: 404, error: "Run not found" };
  const store = runStore();
  const req: CancelRequest = { runId, requestedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  const queued = (await listQueue()).find((q) => q.runId === runId);
  if (queued) {
    // cancel.json first: if the orchestrator takes the run meanwhile, it drops it.
    await store.putJson(KEYS.cancel(runId), req);
    await store.delete(KEYS.queued(queued.requestId));
    if (!(await store.getJson(KEYS.runFile(runId, "config.json")))) {
      const config: RunConfig = placeholderConfig(runId, queued.req, queued.requestedAt);
      const status: RunStatus = { runId, phase: "failed", message: "Cancelled before it started", error: "cancelled", updatedAt: req.requestedAt };
      await store.putJson(KEYS.runFile(runId, "config.json"), config);
      await store.putJson(KEYS.runFile(runId, "status.json"), status);
    }
    return { ok: true, value: { ok: true } };
  }
  const status = await store.getJson<RunStatus>(KEYS.runFile(runId, "status.json"));
  if (!status) return { ok: false, status: 404, error: "Run not found" };
  if (TERMINAL.has(status.phase)) return { ok: false, status: 409, error: `Run already ${status.phase}` };
  await store.putJson(KEYS.cancel(runId), req);
  return { ok: true, value: { ok: true } };
}

/** Cancels every queued run (each ends failed, "Cancelled before it started");
 * running ones are untouched. */
export async function clearQueue(reason = "Queue cleared"): Promise<{ cleared: string[] }> {
  const cleared: string[] = [];
  for (const q of await listQueue()) if ((await cancelRun(q.runId, reason)).ok) cleared.push(q.runId);
  return { cleared };
}

/** The request a run was started with: request.json (written by the
 * orchestrator), else rebuilt from config.json. A retest retries its analysis. */
async function requestOf(runId: string): Promise<StartRunRequest | undefined> {
  const store = runStore();
  const saved = await store.getJson<StartRunRequest>(KEYS.runFile(runId, "request.json"));
  if (saved?.flowId) return saved;
  const config = await store.getJson<RunConfig>(KEYS.runFile(runId, "config.json"));
  if (!config) return undefined;
  if (config.kind === "retest" && config.baselineRunId && config.baselineRunId !== runId) return requestOf(config.baselineRunId);
  const hasFix = !!(await store.getJson(KEYS.runFile(runId, "fix.json")));
  return {
    flowId: config.flowId,
    ...(config.window ? { window: config.window } : {}),
    source: config.posthog?.source ?? "file",
    autoFix: hasFix,
  };
}

/** Queues the same request again; the orchestrator allocates fresh seeds. */
export async function retryRun(runId: string): Promise<ControlResult<{ runId: string }>> {
  if (!isValidRunId(runId)) return { ok: false, status: 404, error: "Run not found" };
  const req = await requestOf(runId);
  if (!req) return { ok: false, status: 404, error: "Run not found" };
  return { ok: true, value: await enqueueRun(req) };
}
