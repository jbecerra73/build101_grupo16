// Typed browser client for the dashboard API (see lib/control-types.ts).
import type { Flow, StartRunRequest } from "@frictionswarm/shared";
import type { ControlOverview, Settings, SwarmTopology } from "@/lib/control-types";
import type { RunDetail, RunSummary } from "@/lib/types";

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

const ok = async <T>(res: Response): Promise<T> => (res.ok ? res.json() : fail(res));

export const listRuns = async (): Promise<RunSummary[]> => ok(await call("/api/runs"));

export const getRun = async (runId: string): Promise<RunDetail> => ok(await call(`/api/runs/${encodeURIComponent(runId)}`));

/** POST /api/runs ("Analyze") → the queued run's id. */
export const startRun = async (req: StartRunRequest): Promise<{ runId: string }> =>
  ok(await call("/api/runs", { method: "POST", body: JSON.stringify(req) }));

/** GET /api/flows: seed flows overlaid with the custom flows in the store. */
export const listFlows = async (): Promise<Flow[]> => ok(await call("/api/flows"));

export const getControl = async (): Promise<ControlOverview> => ok(await call("/api/control"));

/** GET /api/runs/[id]/swarm; undefined until the swarm runner writes swarm.json. */
export async function getSwarm(runId: string): Promise<SwarmTopology | undefined> {
  const res = await call(`/api/runs/${encodeURIComponent(runId)}/swarm`);
  if (res.status === 404) return undefined;
  return ok(res);
}

export async function cancelRun(runId: string, reason?: string): Promise<void> {
  await ok(await call(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }));
}

/** POST /api/runs/[id]/retry → { runId } (same request, fresh seeds). */
export const retryRun = async (runId: string): Promise<{ runId: string }> =>
  ok(await call(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" }));

/** POST /api/runs/[id]/decision → 202; a 409 (not proven without override, decision pending) is an ApiError. */
export async function decideRun(runId: string, body: { decision: "accept" | "reject"; reason?: string; override?: boolean }): Promise<void> {
  await ok(await call(`/api/runs/${encodeURIComponent(runId)}/decision`, { method: "POST", body: JSON.stringify(body) }));
}

export const getSettings = async (): Promise<Settings> => ok(await call("/api/settings"));

/** PUT /api/settings (validated server-side; 400 → ApiError.errors). */
export const putSettings = async (s: Partial<Settings>): Promise<Settings> =>
  ok(await call("/api/settings", { method: "PUT", body: JSON.stringify(s) }));
