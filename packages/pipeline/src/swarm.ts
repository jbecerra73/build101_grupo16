import type { RunConfig } from "@frictionswarm/shared";
import type { SandboxInfo, SwarmTopology } from "@frictionswarm/store";

export type { SandboxInfo, SwarmTopology };

/** Runs a retest swarm against `config.targetUrl` (the deploy preview).
 *
 * Agents leave PostHog tracks through the storefront's own snippet; the runner
 * itself only writes runs/<runId>/screenshots/<agentId>.png (latest screenshot
 * per agent, display only) and, optionally, runs/<runId>/swarm.json. Resolves
 * when every agent has finished; the pipeline then waits for PostHog ingestion
 * (source.waitForSwarm) before analyzing. */
export type SwarmRunner = (config: RunConfig) => Promise<void>;

/** SPEC: 5 concurrent sandboxes, up to 6 browser contexts each. */
export const MAX_SANDBOXES = 5;
export const AGENTS_PER_SANDBOX = 6;

/** Sandboxes for n agents: spread over up to 5, never more than 6 agents in one. */
export const sandboxCount = (n: number) => Math.max(Math.ceil(n / AGENTS_PER_SANDBOX), Math.min(n, MAX_SANDBOXES), 1);

/**
 * Hook for P2's tenki swarm runner (Settings.swarmRunner = "tenki").
 *
 * The factory gets the run folder root and must return a SwarmRunner that
 * opens `<targetUrl>/?swarm=<runId>&agent=<personaId>-<seed>&persona=<personaId>`
 * for each agent in config.seeds, leaves runs/<runId>/screenshots/<agentId>.png
 * in `runsDir` (the orchestrator mirrors that folder to the run store), calls
 * `reportTopology` whenever a sandbox changes state (it writes swarm.json),
 * and stops its sandboxes when `signal` aborts (then rejects with "cancelled").
 */
export type TenkiSwarmRunnerFactory = (ctx: {
  runsDir: string;
  signal: AbortSignal;
  reportTopology: (t: SwarmTopology) => Promise<void>;
  log: (line: string) => void;
}) => SwarmRunner;

let tenkiFactory: TenkiSwarmRunnerFactory | undefined;

/** Called once by P2's runner module (e.g. at the top of the daemon entry). */
export function registerTenkiSwarmRunner(factory: TenkiSwarmRunnerFactory) {
  tenkiFactory = factory;
}

export function tenkiSwarmRunner(ctx: Parameters<TenkiSwarmRunnerFactory>[0]): SwarmRunner {
  if (tenkiFactory) return tenkiFactory(ctx);
  return async () => {
    throw new Error("The tenki swarm runner is not wired yet (P2: registerTenkiSwarmRunner in packages/pipeline/src/swarm.ts)");
  };
}
