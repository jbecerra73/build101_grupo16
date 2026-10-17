import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StartRunRequest } from "@frictionswarm/shared";
import { KEYS, onNetlify, readSettings, readUsage, type QueuedRun } from "@frictionswarm/store";
import { listQueue, runsDir } from "./runs";
import { runStore } from "./store";

/**
 * Server-process setup, done once when this module loads:
 * - loads the repo-root `.env.local` (e.g. CLAUDE_CODE_OAUTH_TOKEN for the
 *   analyzer); variables already set in the environment win;
 * - fills in the offline demo defaults (file PostHog source, offline swarm,
 *   rehearsal fix loop) for anything not set. See apps/dashboard/.env.example.
 * Paths are passed explicitly because the pipeline's own repo-root detection
 * relies on import.meta.url, which points into .next/ once bundled.
 */
function setupEnv() {
  const runs = runsDir();
  const root = dirname(runs);
  const envFile = join(/*turbopackIgnore: true*/ root, ".env.local");
  if (!onNetlify() && existsSync(/*turbopackIgnore: true*/ envFile)) process.loadEnvFile(envFile);
  const defaults: Record<string, string> = {
    RUNS_DIR: runs,
    SWARM_RUNNER: "offline",
    POSTHOG_SOURCE: "file",
    POSTHOG_DATA_DIR: join(root, "data", "posthog"),
    SWARM_SHOTS_DIR: join(root, "apps", "dashboard", "scripts", "shots"),
    ORCHESTRATOR_WORK_DIR: join(root, ".orchestrator-work"),
    ORCHESTRATOR_VERSION: "inline",
  };
  // Empty values (KEY= in .env.local) count as unset.
  for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
}
setupEnv();

/** ORCHESTRATOR=inline|daemon. inline (the local default) runs the orchestrator
 * loop inside this Next server; daemon (always on Netlify) leaves the queue to
 * `npm run orchestrator`, locally or in a tenki sandbox. */
export function orchestratorMode(env = process.env): "inline" | "daemon" {
  if (onNetlify(env)) return "daemon";
  return env.ORCHESTRATOR === "daemon" ? "daemon" : "inline";
}

const g = globalThis as { __frictionswarmInline?: Promise<unknown> };

/** Starts the in-process orchestrator once (inline mode only). Safe to call on every request. */
export function ensureInlineOrchestrator(): Promise<unknown> | undefined {
  if (orchestratorMode() !== "inline") return undefined;
  g.__frictionswarmInline ??= (async () => {
    const { orchestratorFromEnv } = await import("@frictionswarm/pipeline");
    const o = orchestratorFromEnv(process.env, (line) => console.log(`[orchestrator] ${line}`));
    await o.start();
    return o;
  })().catch((e) => {
    console.error("[orchestrator] inline start failed:", e);
    g.__frictionswarmInline = undefined;
  });
  return g.__frictionswarmInline;
}

export class RunCapError extends Error {}

/** Sortable, unique: 2026-10-17T21-05-00-ab12 (UTC), as packages/pipeline/src/runs.ts. */
export const newRunId = (now = new Date()) =>
  `${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${randomBytes(2).toString("hex")}`;

/** Queues a run for the orchestrator. Refuses when today's runs plus the queue
 * already reach the cap (the orchestrator checks again when it takes the run). */
export async function enqueueRun(req: StartRunRequest): Promise<{ runId: string }> {
  const store = runStore();
  const [settings, usage, queue] = await Promise.all([readSettings(store), readUsage(store), listQueue()]);
  if (usage.runs + queue.length >= settings.maxRunsPerDay)
    throw new RunCapError(`Run cap reached: ${usage.runs} run(s) today and ${queue.length} queued, max ${settings.maxRunsPerDay} per day`);
  const now = new Date();
  const runId = newRunId(now);
  const q: QueuedRun = { requestId: `${runId}-${randomBytes(3).toString("hex")}`, runId, req, requestedAt: now.toISOString() };
  await store.putJson(KEYS.queued(q.requestId), q);
  void ensureInlineOrchestrator();
  return { runId };
}

