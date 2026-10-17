// Sandbox layout estimated from a swarm's agents, for runs without swarm.json
// (Replay plays a finished swarm back, and a runner may not report its topology).
import type { SandboxInfo, SwarmBackendKind, SwarmTopology } from "@/lib/control-types";
import type { AgentState } from "@/lib/types";

export const AGENTS_PER_SANDBOX = 6;
/** Rough estimate: sandbox minutes + one model call per action. */
const USD_PER_SANDBOX_MIN = 0.006;
const USD_PER_ACTION = 0.011;

/** Agents packed in order into sandboxes of ≤ 6 (30 agents → 5 sandboxes).
 * Times are event times, cost is an estimate. */
export function estimateTopology(runId: string, agents: AgentState[], backend: SwarmBackendKind): SwarmTopology {
  const sandboxes: SandboxInfo[] = [];
  const count = Math.max(1, Math.ceil(agents.length / AGENTS_PER_SANDBOX));
  for (let i = 0; i < count; i++) {
    const mine = agents.slice(i * AGENTS_PER_SANDBOX, (i + 1) * AGENTS_PER_SANDBOX);
    const started = mine.map((a) => a.startedAt).filter((t): t is number => !!t);
    const last = mine.map((a) => a.lastEventAt).filter((t): t is number => !!t);
    const allDone = mine.length > 0 && mine.every((a) => a.state !== "running");
    const status: SandboxInfo["status"] = !started.length ? (allDone ? "done" : "booting") : allDone ? "done" : "running";
    const startedAt = started.length ? Math.min(...started) : undefined;
    const endedAt = allDone && last.length ? Math.max(...last) : undefined;
    const minutes = startedAt ? ((endedAt ?? Math.max(...last, startedAt)) - startedAt) / 60000 : 0;
    const actions = mine.reduce((n, a) => n + a.actions, 0);
    sandboxes.push({
      id: `${runId}-sbx-${i + 1}`,
      label: `sbx-${i + 1}`,
      region: backend,
      status,
      agentIds: mine.map((a) => a.agentId),
      startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
      endedAt: endedAt ? new Date(endedAt).toISOString() : undefined,
      costUsd: minutes * USD_PER_SANDBOX_MIN + actions * USD_PER_ACTION,
    });
  }
  return { runId, backend, sandboxes, updatedAt: new Date().toISOString() };
}
