// Who runs where: persona × seed assignments spread over sandboxes.
import type { PersonaId } from "../../shared";
import { withSwarmTag } from "../../worker/session";

export const MAX_SANDBOXES = 5;
export const AGENTS_PER_SANDBOX = 6;

export type AgentAssignment = {
  agentId: string;
  personaId: PersonaId;
  seed: number;
  /** `<previewUrl>/?swarm=<runId>&agent=<agentId>&persona=<personaId>` */
  startUrl: string;
};

export type SwarmPlan = {
  agents: AgentAssignment[];
  /** One entry per sandbox, each at most agentsPerSandbox agents. */
  sandboxes: AgentAssignment[][];
};

/** `count` consecutive seeds for every persona, starting at `first` (see ledger.ts for freshness). */
export function freshSeeds(personaIds: PersonaId[], count: number, first: number): Record<PersonaId, number[]> {
  const seeds = Array.from({ length: count }, (_, i) => first + i);
  return Object.fromEntries(personaIds.map((p) => [p, [...seeds]]));
}

export function planSwarm(o: {
  runId: string;
  previewUrl: string;
  personaIds: PersonaId[];
  seeds: Record<PersonaId, number[]>;
  maxSandboxes?: number;
  agentsPerSandbox?: number;
}): SwarmPlan {
  const maxSandboxes = o.maxSandboxes ?? MAX_SANDBOXES;
  const perSandbox = o.agentsPerSandbox ?? AGENTS_PER_SANDBOX;
  // Interleave personas (rosa-1, kai-1, typical-1, rosa-2, …) so every sandbox gets a mix and a
  // slow sandbox doesn't hold back one persona.
  const rounds = Math.max(0, ...o.personaIds.map((p) => o.seeds[p]?.length ?? 0));
  const agents: AgentAssignment[] = [];
  const seen = new Set<string>();
  for (let r = 0; r < rounds; r++)
    for (const personaId of o.personaIds) {
      const seed = o.seeds[personaId]?.[r];
      if (seed === undefined) continue;
      const agentId = `${personaId}-${seed}`;
      if (seen.has(agentId)) throw new Error(`Duplicate agent ${agentId}`);
      seen.add(agentId);
      agents.push({ agentId, personaId, seed, startUrl: withSwarmTag(o.previewUrl, { runId: o.runId, agentId, personaId }) });
    }
  if (agents.length === 0) throw new Error("Nothing to run: no persona has seeds");
  const count = Math.ceil(agents.length / perSandbox);
  if (count > maxSandboxes)
    throw new Error(`${agents.length} agents need ${count} sandboxes of ${perSandbox}; the limit is ${maxSandboxes}`);
  const sandboxes: AgentAssignment[][] = Array.from({ length: count }, () => []);
  agents.forEach((a, i) => sandboxes[i % count].push(a));
  return { agents, sandboxes };
}
