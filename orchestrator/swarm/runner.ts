// The swarm as the pipeline's SwarmRunner: given the retest RunConfig, leave the swarm's tracks
// where the analyzer's PostHogSource will read them.
//   liveSwarmRunner     real agents in sandboxes (tenki, or local) → PostHog
//   offlineSwarmRunner  `npm run posthog:generate -- --swarm <runId> …` → data/posthog/swarm-<runId>.jsonl
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { RunConfig } from "../../shared";
import { runSwarm, type RunSwarmOptions } from "./run";

/** Same shape as SwarmRunner in orchestrator/fix-loop.ts (p3/orchestrator, not on main yet). */
export type SwarmRunner = (config: RunConfig) => Promise<void>;

const REPO = resolve(import.meta.dirname, "..", "..");

export function liveSwarmRunner(
  o: Omit<RunSwarmOptions, "runId" | "flowId" | "goal" | "previewUrl" | "buildSha" | "personaIds" | "seeds" | "baselineRunId">,
): SwarmRunner {
  return async (config) => {
    const hasSeeds = config.personaIds.some((p) => (config.seeds[p]?.length ?? 0) > 0);
    await runSwarm({
      ...o,
      runId: config.runId,
      flowId: config.flowId,
      goal: config.goal,
      previewUrl: config.targetUrl,
      buildSha: config.posthog.buildSha,
      personaIds: config.personaIds,
      seeds: hasSeeds ? config.seeds : undefined,
      baselineRunId: config.baselineRunId,
    });
  };
}

/** Arguments for the generator's swarm mode. It takes one seed range shared by every persona. */
export function generateArgs(config: RunConfig, fixed: string[] = []): string[] {
  const ranges = config.personaIds.map((p) => {
    const s = [...(config.seeds[p] ?? [])].sort((a, b) => a - b);
    if (s.length === 0) throw new Error(`No seeds for persona ${p}`);
    if (s.some((x, i) => x !== s[0] + i)) throw new Error(`Seeds for ${p} are not a consecutive range: ${s.join(",")}`);
    return `${s[0]}-${s.at(-1)}`;
  });
  if (new Set(ranges).size > 1) throw new Error(`Personas have different seed ranges (${ranges.join(", ")}); the generator takes one`);
  return [
    "--swarm", config.runId,
    "--flow", config.flowId,
    "--sha", config.posthog.buildSha,
    "--host", new URL(config.targetUrl).host,
    "--personas", config.personaIds.join(","),
    "--seeds", ranges[0],
    ...(fixed.length ? ["--fixed", fixed.join(",")] : []),
  ];
}

/** Offline stand-in for a real re-test (SPEC: fake PostHog dataset, swarm mode). `fixed` names the
 * traps the fix removed (e.g. ["T1", "T2"]), which decides how well the fake swarm does. */
export function offlineSwarmRunner(o: { fixed?: string[] | ((config: RunConfig) => string[]) } = {}): SwarmRunner {
  return async (config) => {
    const fixed = typeof o.fixed === "function" ? o.fixed(config) : o.fixed;
    const args = ["run", "posthog:generate", "--", ...generateArgs(config, fixed)];
    const code = await new Promise<number | null>((done) => {
      const child = spawn("npm", args, { cwd: REPO, stdio: "inherit" });
      child.on("close", done);
      child.on("error", () => done(null));
    });
    if (code !== 0) throw new Error(`npm ${args.join(" ")} exited ${code}`);
  };
}
