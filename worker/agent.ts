import type { Event } from "../shared";
import type { Observation } from "./observe";
import { AgentSession, BROWSER_ACTIONS, withSwarmTag, type Outcome, type SessionOptions, type StepResult, type ToolCall } from "./session";

/** Decides the next tool calls from the latest screen. In production Claude Code drives the
 * session over MCP (see mcp-server.ts); this in-process loop lets tests script an agent. */
export interface Brain {
  decide(turn: { results: StepResult[]; observation: Observation }): Promise<ToolCall[]>;
}

export type AgentResult = { outcome: Outcome; actions: number; events: Event[] };

export type AgentOptions = SessionOptions & {
  brain: Brain;
  /** URL to open first; defaults to the flow's start URL with the swarm tag (see withSwarmTag). */
  startUrl?: string;
};

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const session = new AgentSession(o);
  await session.start(o.startUrl ?? withSwarmTag(o.flow.startUrl, { runId: o.runId, agentId: session.agentId, personaId: o.persona.id }));
  let results: StepResult[] = [];
  while (!session.outcome) {
    const calls = await o.brain.decide({ results, observation: session.observation! });
    results = [];
    if (calls.length === 0) results.push(await session.call({ name: "look", input: {} }));
    let acted = false;
    for (const call of calls) {
      // One browser action per turn: anything after it targets a stale screen.
      if (BROWSER_ACTIONS.has(call.name) && acted) {
        results.push({ text: "Skipped: look at the new screen first.", isError: true });
        continue;
      }
      acted ||= BROWSER_ACTIONS.has(call.name);
      results.push(await session.call(call));
      if (session.outcome) break;
    }
  }
  await session.close();
  return { outcome: session.outcome, actions: session.actions, events: session.events };
}
