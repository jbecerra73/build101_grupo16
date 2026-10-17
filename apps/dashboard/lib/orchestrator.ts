import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FLOWS, type RunConfig, type RunStatus, type StartRunRequest } from "@frictionswarm/shared";
import { runsDir } from "./runs";

/**
 * Starts the FrictionSwarm pipeline (verify build → swarm → analyze → fix → retest).
 *
 * TODO(P3): wire to the real orchestrator once it lands:
 *
 *   import { startPipeline as start } from "@frictionswarm/pipeline";
 *   export const startPipeline = (req: StartRunRequest) => start(req);
 *
 * Until then this STUB only creates the run folder (config.json + a status.json
 * stuck in "verifying") so the New run → Run page flow can be exercised. No
 * agents are launched and nothing else is written.
 */
export async function startPipeline(req: StartRunRequest): Promise<{ runId: string }> {
  const flow = FLOWS[req.flowId];
  const now = new Date();
  const runId = `run-${now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(2).toString("hex")}`;
  const seeds = Object.fromEntries(req.personaIds.map((p) => [p, Array.from({ length: req.seedsPerPersona }, (_, i) => i + 1)]));
  const config: RunConfig = {
    runId,
    kind: "baseline",
    flowId: req.flowId,
    personaIds: req.personaIds,
    seeds,
    targetUrl: req.targetUrl ?? flow.startUrl,
    buildSha: "pending",
    createdAt: now.toISOString(),
  };
  const status: RunStatus = {
    runId,
    phase: "verifying",
    updatedAt: now.toISOString(),
    message: `Orchestrator not wired yet (dashboard stub, lib/orchestrator.ts). autoFix=${req.autoFix}`,
  };
  const dir = join(/*turbopackIgnore: true*/ runsDir(), runId);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  await writeFile(/*turbopackIgnore: true*/ join(dir, "status.json"), JSON.stringify(status, null, 2) + "\n");
  return { runId };
}
