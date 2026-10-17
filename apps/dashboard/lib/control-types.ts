import type { StartRunRequest } from "@frictionswarm/shared";
import type { RunSummary } from "./types";

/** Contract between the orchestrator (local process or tenki sandbox), the run
 * store (disk locally, Netlify Blobs when deployed) and the dashboard's control
 * center, swarm monitor, settings and pitch mode.
 *
 * Store layout, relative to the store root (RUNS_DIR on disk, a Blobs store when deployed):
 *   runs/<runId>/...           the run folder (see shared/contracts.ts)
 *   runs/<runId>/swarm.json    SwarmTopology, written by the swarm runner
 *   runs/<runId>/cancel.json   CancelRequest, written by the dashboard
 *   queue/<requestId>.json     QueuedRun, written by the dashboard, deleted by the orchestrator once taken
 *   settings.json              Settings
 *   orchestrator.json          OrchestratorHeartbeat, rewritten every ~5s
 *   usage.json                 { date, runs }, the runs-per-day cap
 */

export type SwarmBackendKind = "replay" | "tenki";

export type SandboxStatus = "booting" | "running" | "done" | "failed" | "closed";

export type SandboxInfo = {
  id: string;
  /** Short display name, e.g. "sbx-3". */
  label: string;
  region?: string;
  status: SandboxStatus;
  /** Agents (personaId-seed) assigned to this sandbox, ≤ 6. */
  agentIds: string[];
  startedAt?: string;
  endedAt?: string;
  /** Running cost estimate in USD (sandbox time + model tokens), if known. */
  costUsd?: number;
};

export type SwarmTopology = {
  runId: string;
  backend: SwarmBackendKind;
  sandboxes: SandboxInfo[];
  updatedAt: string;
};

export type Settings = {
  swarmRunner: SwarmBackendKind;
  fixLoop: "fake" | "real";
  /** Replay time scale (>1 is faster). */
  replaySpeed: number;
  maxRunsPerDay: number;
  defaultSeedsPerPersona: number;
  /** Verify production build-sha before a baseline. */
  verifyBuild: boolean;
};

export type OrchestratorHeartbeat = {
  host: "local" | "tenki";
  sandboxId?: string;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  activeRunIds: string[];
  queueDepth: number;
};

export type QueuedRun = {
  requestId: string;
  /** Pre-assigned so the dashboard can redirect to the run page immediately. */
  runId: string;
  req: StartRunRequest;
  requestedAt: string;
};

export type CancelRequest = { runId: string; requestedAt: string; reason?: string };

/** GET /api/control */
export type ControlOverview = {
  active: RunSummary[];
  recent: RunSummary[];
  queued: QueuedRun[];
  usage: { date: string; runs: number; max: number };
  settings: Settings;
  /** Missing or stale (lastSeenAt > 20s ago) means the orchestrator is offline. */
  orchestrator?: OrchestratorHeartbeat;
};

/** API routes added alongside the existing /api/runs ones:
 *   GET  /api/control                 → ControlOverview
 *   GET  /api/runs/[id]/swarm         → SwarmTopology | 404
 *   POST /api/runs/[id]/cancel        → { ok: true }
 *   POST /api/runs/[id]/retry         → { runId }   (same StartRunRequest, fresh seeds)
 *   GET  /api/settings                → Settings
 *   PUT  /api/settings                → Settings   (validated)
 *   POST /api/runs                    → { runId }   (now enqueues a QueuedRun)
 */
