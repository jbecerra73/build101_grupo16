import type { SandboxInfo, SwarmTopology } from "@frictionswarm/store";
import type { SwarmRunner } from "../../../orchestrator/fix-loop";

export type { SandboxInfo, SwarmTopology };

/** SPEC: 5 concurrent sandboxes, up to 6 browser contexts each. */
export const MAX_SANDBOXES = 5;
export const AGENTS_PER_SANDBOX = 6;

/** Sandboxes for n agents: spread over up to 5, never more than 6 agents in one. */
export const sandboxCount = (n: number) => Math.max(Math.ceil(n / AGENTS_PER_SANDBOX), Math.min(n, MAX_SANDBOXES), 1);

/**
 * Hook for P2's tenki swarm runner (Settings.swarmRunner = "tenki").
 *
 * The factory gets the run folder root and must return a SwarmRunner that
 * leaves runs/<runId>/events/<agentId>.jsonl and screenshots/ in `runsDir`
 * (the orchestrator mirrors that folder to the run store), calls
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
