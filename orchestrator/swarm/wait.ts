// Waiting for the swarm's tracks. The real wait is PostHogSource.waitForSwarm (#32, not built
// yet): it polls PostHog until every agent's swarm_done / swarm_give_up is ingested. Until then
// the orchestrator depends on just that method, and the CLI uses localResultsWaiter.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The slice of PostHogSource (SPEC.md, "PostHog source") the swarm needs. */
export type SwarmWaiter = {
  waitForSwarm(q: { runId: string; agentIds: string[]; timeoutMs: number }): Promise<void>;
};

export class SwarmWaitTimeout extends Error {
  constructor(readonly missing: string[]) {
    super(`Timed out waiting for ${missing.length} agent(s): ${missing.join(", ")}`);
  }
}

/** Stand-in for PostHogSource.waitForSwarm: resolves once every agent's `agents/<agentId>.json`
 * has been copied into the local run folder. It proves the agents ended, NOT that PostHog has
 * ingested their events; swap in the real source when #32 lands. */
export function localResultsWaiter(runsDir: string, pollMs = 1000): SwarmWaiter {
  return {
    async waitForSwarm({ runId, agentIds, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const missing = agentIds.filter((a) => !existsSync(join(runsDir, runId, "agents", `${a}.json`)));
        if (missing.length === 0) return;
        if (Date.now() >= deadline) throw new SwarmWaitTimeout(missing);
        await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      }
    },
  };
}
