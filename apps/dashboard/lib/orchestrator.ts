import "server-only";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { startPipeline as start } from "@frictionswarm/pipeline";
import type { StartRunRequest } from "@frictionswarm/shared";
import { runsDir } from "./runs";

/**
 * Server-process setup for the pipeline, done once when this module loads:
 * - loads the repo-root `.env.local` (e.g. CLAUDE_CODE_OAUTH_TOKEN for the
 *   analyzer); variables already set in the environment win;
 * - fills in the offline demo defaults (replayed swarm + rehearsal fix loop)
 *   for anything not set. See apps/dashboard/.env.example.
 * Paths are passed explicitly because the pipeline's own repo-root detection
 * relies on import.meta.url, which points into .next/ once bundled.
 */
function setupEnv() {
  const runs = runsDir();
  const root = dirname(runs);
  const envFile = join(/*turbopackIgnore: true*/ root, ".env.local");
  if (existsSync(/*turbopackIgnore: true*/ envFile)) process.loadEnvFile(envFile);
  const defaults: Record<string, string> = {
    RUNS_DIR: runs,
    SWARM_RUNNER: "replay",
    REPLAY_DIR: join(runs, "fixture-baseline"),
    REPLAY_RETEST_DIR: join(runs, "fixture-retest"),
    REPLAY_SPEED: "1.5",
  };
  for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
}
setupEnv();

const log = (line: string) => console.log(`[pipeline] ${line}`);

/**
 * Starts the FrictionSwarm pipeline (verify build → swarm → analyze → fix →
 * retest → compare) inside this Next server process and returns as soon as
 * runs/<runId>/ exists. Progress is written to the run folder, which the run
 * page polls; `done` is deliberately not awaited.
 */
export async function startPipeline(req: StartRunRequest): Promise<{ runId: string }> {
  const { runId, done } = await start(req, {
    runsDir: runsDir(),
    log,
    onStatus: (s) => log(`${s.runId} ${s.phase}: ${s.message ?? ""}${s.error ? ` (error: ${s.error})` : ""}`),
  });
  void done;
  return { runId };
}
