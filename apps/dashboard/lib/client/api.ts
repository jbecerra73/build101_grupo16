// Typed browser client for the control-center API (see lib/control-types.ts).
//
// The routes below are built by the backend PR (store + orchestrator daemon).
// Until it lands they return 404 here, and every call falls back to a mock
// derived from what exists today (/api/runs, the run's agents, localStorage).
// Everything mock lives in ./mock.ts and is marked `mock: true` in the result so
// the UI can label it. Delete ./mock.ts and the `if (res.status === 404)`
// branches once the backend is merged.
import type { StartRunRequest } from "@frictionswarm/shared";
import type { ControlOverview, Settings, SwarmTopology } from "@/lib/control-types";
import type { AgentState, RunDetail, RunSummary } from "@/lib/types";
import { mockControl, mockSettings, mockTopology, saveMockSettings } from "./mock";

export type Sourced<T> = { data: T; mock: boolean };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors: string[] = [],
  ) {
    super(message);
  }
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
}

async function fail(res: Response): Promise<never> {
  let errors: string[] = [];
  try {
    const j = await res.json();
    errors = Array.isArray(j.errors) ? j.errors : j.error ? [String(j.error)] : [];
  } catch {
    /* not json */
  }
  throw new ApiError(errors[0] ?? `Request failed (${res.status})`, res.status, errors);
}

export async function listRuns(): Promise<RunSummary[]> {
  const res = await call("/api/runs");
  if (!res.ok) await fail(res);
  return res.json();
}

export async function getRun(runId: string): Promise<RunDetail> {
  const res = await call(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) await fail(res);
  return res.json();
}

/** GET /api/control. Mock: built from /api/runs + local settings. */
export async function getControl(): Promise<Sourced<ControlOverview>> {
  const res = await call("/api/control");
  if (res.ok) return { data: await res.json(), mock: false };
  if (res.status === 404) return { data: mockControl(await listRuns()), mock: true };
  return fail(res);
}

/** GET /api/runs/[id]/swarm. Mock (route missing, or no swarm.json yet): the run's
 * agents packed into sandboxes of ≤ 6. */
export async function getSwarm(runId: string, agents: AgentState[]): Promise<Sourced<SwarmTopology>> {
  const res = await call(`/api/runs/${encodeURIComponent(runId)}/swarm`);
  if (res.ok) return { data: await res.json(), mock: false };
  if (res.status === 404) return { data: mockTopology(runId, agents, mockSettings().swarmRunner), mock: true };
  return fail(res);
}

/** POST /api/runs/[id]/cancel. Mock: nothing to cancel against, reports `mock`. */
export async function cancelRun(runId: string, reason?: string): Promise<{ ok: boolean; mock: boolean }> {
  const res = await call(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
  if (res.ok) return { ok: true, mock: false };
  if (res.status === 404) return { ok: false, mock: true };
  return fail(res);
}

/** POST /api/runs/[id]/retry → { runId }. Mock: starts the same request through
 * the existing POST /api/runs (fresh seeds are drawn by the pipeline). */
export async function retryRun(run: RunSummary): Promise<{ runId: string; mock: boolean }> {
  const res = await call(`/api/runs/${encodeURIComponent(run.runId)}/retry`, { method: "POST" });
  if (res.ok) return { runId: (await res.json()).runId, mock: false };
  if (res.status !== 404) return fail(res);
  const c = run.config;
  const req: StartRunRequest = {
    flowId: c.flowId,
    personaIds: c.personaIds,
    seedsPerPersona: Math.max(1, ...c.personaIds.map((p) => c.seeds[p]?.length ?? 1)),
    targetUrl: c.targetUrl,
    autoFix: !!run.fixStatus,
  };
  const started = await call("/api/runs", { method: "POST", body: JSON.stringify(req) });
  if (!started.ok) return fail(started);
  return { runId: (await started.json()).runId, mock: true };
}

/** GET /api/settings. Mock: localStorage. */
export async function getSettings(): Promise<Sourced<Settings>> {
  const res = await call("/api/settings");
  if (res.ok) return { data: await res.json(), mock: false };
  if (res.status === 404) return { data: mockSettings(), mock: true };
  return fail(res);
}

/** PUT /api/settings (validated server-side; 400 → ApiError.errors). Mock: localStorage. */
export async function putSettings(s: Settings): Promise<Sourced<Settings>> {
  const res = await call("/api/settings", { method: "PUT", body: JSON.stringify(s) });
  if (res.ok) return { data: await res.json(), mock: false };
  if (res.status === 404) return { data: saveMockSettings(s), mock: true };
  return fail(res);
}
