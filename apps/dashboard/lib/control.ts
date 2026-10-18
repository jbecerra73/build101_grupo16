// Server side of the control center (see lib/control-types.ts for the contract).
import "server-only";
import type { DecisionRequest, FixRequest, FixResult, Finding, RunConfig, RunStatus, Severity, StartRunRequest } from "@frictionswarm/shared";
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
import type { ControlOverview } from "./control-types";
import { enqueueRun } from "./orchestrator";
import { isValidRunId, listQueue, listRuns, placeholderConfig } from "./runs";
import { runStore } from "./store";
import { MAX_SEEDS_PER_PERSONA } from "./validate";
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
  return {
    active: runs.filter(isActive),
    recent: runs.filter((r) => !isActive(r)).slice(0, RECENT),
    queued,
    usage: { date: usage.date, runs: usage.runs, max: settings.maxRunsPerDay },
    settings,
    // Omitted when missing or stale: the UI shows the orchestrator offline.
    ...(isOnline(hb, now) ? { orchestrator: hb } : {}),
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

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const DEFAULT_FIX_FINDINGS = 3;

/** Same ordering as rankFindings in @frictionswarm/pipeline (severity, then affected sessions), kept here so the
 * route does not load the pipeline package. */
const rankFindings = (findings: Finding[]) =>
  findings.toSorted((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.evidence.sessions - a.evidence.sessions);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Asks the orchestrator to fix findings of a finished analysis: writes fix-request.json, which the daemon picks up. */
export async function requestFix(runId: string, body: unknown): Promise<ControlResult<{ ok: true; findingIds: string[] }>> {
  if (!isValidRunId(runId)) return { ok: false, status: 404, error: "Run not found" };
  const store = runStore();
  const [config, status] = await Promise.all([
    store.getJson<RunConfig>(KEYS.runFile(runId, "config.json")),
    store.getJson<RunStatus>(KEYS.runFile(runId, "status.json")),
  ]);
  if (!config || !status) return { ok: false, status: 404, error: "Run not found" };

  const b = body === undefined ? {} : body;
  if (!isRecord(b)) return { ok: false, status: 400, error: "Body must be a JSON object" };
  const { findingIds, seedsPerPersona } = b;
  if (findingIds !== undefined) {
    if (!Array.isArray(findingIds) || findingIds.some((id) => typeof id !== "string")) return { ok: false, status: 400, error: "findingIds must be an array of strings" };
    if (!findingIds.length) return { ok: false, status: 400, error: "findingIds must not be empty" };
  }
  if (seedsPerPersona !== undefined && (typeof seedsPerPersona !== "number" || !Number.isInteger(seedsPerPersona) || seedsPerPersona < 1 || seedsPerPersona > MAX_SEEDS_PER_PERSONA))
    return { ok: false, status: 400, error: `seedsPerPersona must be an integer from 1 to ${MAX_SEEDS_PER_PERSONA}` };

  if (config.kind !== "analysis") return { ok: false, status: 409, error: "Only an analysis run can be fixed" };
  if (status.phase !== "done") return { ok: false, status: 409, error: `Run is ${status.phase}: fixes start from a finished analysis` };
  if (await store.getJson(KEYS.runFile(runId, "fix.json"))) return { ok: false, status: 409, error: "This analysis already has a fix" };
  if (await store.getJson(KEYS.fixRequest(runId))) return { ok: false, status: 409, error: "A fix is already requested" };

  const findings = (await store.getJson<Finding[]>(KEYS.runFile(runId, "findings.json"))) ?? [];
  const ids = (findingIds as string[] | undefined) ?? rankFindings(findings).slice(0, DEFAULT_FIX_FINDINGS).map((f) => f.id);
  for (const id of ids) if (!findings.some((f) => f.id === id)) return { ok: false, status: 400, error: `Unknown finding "${id}"` };
  if (!ids.length) return { ok: false, status: 400, error: "This analysis has no findings to fix" };

  const req: FixRequest = { runId, findingIds: ids, ...(seedsPerPersona !== undefined ? { seedsPerPersona: seedsPerPersona as number } : {}), requestedAt: new Date().toISOString() };
  await store.putJson(KEYS.fixRequest(runId), req);
  return { ok: true, value: { ok: true, findingIds: ids } };
}

/** Accepts or rejects the fix of a run awaiting a decision: writes decision.json, which the daemon applies. */
export async function requestDecision(runId: string, body: unknown): Promise<ControlResult<{ ok: true }>> {
  if (!isValidRunId(runId)) return { ok: false, status: 404, error: "Run not found" };
  const store = runStore();
  const status = await store.getJson<RunStatus>(KEYS.runFile(runId, "status.json"));
  if (!status) return { ok: false, status: 404, error: "Run not found" };

  if (!isRecord(body)) return { ok: false, status: 400, error: "Body must be a JSON object" };
  const { decision, reason, override } = body;
  if (decision !== "accept" && decision !== "reject") return { ok: false, status: 400, error: "decision must be accept or reject" };
  if (reason !== undefined && typeof reason !== "string") return { ok: false, status: 400, error: "reason must be a string" };
  if (override !== undefined && typeof override !== "boolean") return { ok: false, status: 400, error: "override must be a boolean" };

  if (status.phase !== "awaiting-decision") return { ok: false, status: 409, error: `Run is ${status.phase}: no fix is waiting for a decision` };
  if (await store.getJson(KEYS.decision(runId))) return { ok: false, status: 409, error: "A decision is already pending" };
  const fix = await store.getJson<FixResult>(KEYS.runFile(runId, "fix.json"));
  const last = fix?.attempts.at(-1);
  if (!last || (last.status !== "ready" && last.status !== "not-proven")) return { ok: false, status: 409, error: "No fix awaiting a decision" };
  if (decision === "accept" && last.status === "not-proven" && !override) return { ok: false, status: 409, error: "Fix not proven: pass override to accept anyway" };

  const req: DecisionRequest = {
    runId,
    decision,
    ...(reason ? { reason: reason.slice(0, 500) } : {}),
    ...(override ? { override: true } : {}),
    requestedAt: new Date().toISOString(),
  };
  await store.putJson(KEYS.decision(runId), req);
  return { ok: true, value: { ok: true } };
}
