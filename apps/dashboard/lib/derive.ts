// Pure derivations from a re-test swarm's PostHog events (one session per
// agent). Runs on the server (API) and in the browser (Replay), so it must not
// import node modules. The analyzer owns the authoritative metrics; these are
// for the live grid, the swarm map and Replay.
import {
  actionBudget,
  MAX_ACTIONS_PER_AGENT,
  PERSONAS,
  resolveStep,
  type Flow,
  type FunnelStep,
  type Metrics,
  type PersonaMetrics,
  type PostHogEvent,
  type RunConfig,
} from "@frictionswarm/shared";
import type { AgentOutcome, AgentState, ScreenshotIndex } from "./types";

export const agentIdsOf = (config: RunConfig) =>
  config.personaIds.flatMap((p) => (config.seeds[p] ?? []).map((seed) => ({ agentId: `${p}-${seed}`, personaId: p, seed })));

/** The agent's action budget, drawn by seed for personas with a range (Kai: 8–12). */
export const budgetOf = (personaId: string, seed: number) => {
  const persona = PERSONAS[personaId];
  return persona ? actionBudget(persona, seed) : MAX_ACTIONS_PER_AGENT;
};

export const tsOf = (e: PostHogEvent) => Date.parse(e.timestamp);

/** Swarm events by agent (swarm_agent), each in time order. */
export function groupByAgent(events: PostHogEvent[]): Map<string, PostHogEvent[]> {
  const map = new Map<string, PostHogEvent[]>();
  for (const e of events) {
    const id = String(e.properties.swarm_agent ?? e.properties.$session_id);
    const list = map.get(id);
    if (list) list.push(e);
    else map.set(id, [e]);
  }
  for (const list of map.values()) list.sort((a, b) => tsOf(a) - tsOf(b));
  return map;
}

const stepOf = (flow: Flow | undefined, e: PostHogEvent) => (flow && e.properties.$current_url ? resolveStep(flow, e.properties.$current_url) : undefined);
const prop = (e: PostHogEvent | undefined, k: string) => (e?.properties as Record<string, unknown> | undefined)?.[k];

/** Steps the agent's $pageviews resolve to, in order. */
export const visitedSteps = (evs: PostHogEvent[], flow?: Flow) =>
  evs.filter((e) => e.event === "$pageview").map((e) => stepOf(flow, e)).filter((s): s is string => !!s);

/** SPEC completion validity: reached the success step, every required step in its
 * $pageviews, shipping and payment submitted successfully, order_completed fired. */
export function invalidReason(evs: PostHogEvent[], flow?: Flow): string | undefined {
  const steps = new Set(visitedSteps(evs, flow));
  const missing = (flow?.required.steps ?? []).filter((s) => !steps.has(s));
  if (missing.length) return `Reached the end without ${missing.join(", ")}`;
  const ok = (name: string) => evs.some((e) => e.event === name && prop(e, "success") === true);
  if (!ok("shipping_submitted")) return "No successful shipping_submitted";
  if (!ok("payment_submitted")) return "No successful payment_submitted";
  if (!evs.some((e) => e.event === "order_completed")) return "No order_completed";
  return undefined;
}

function outcomeOf(evs: PostHogEvent[], flow: Flow | undefined, live: boolean): { state: AgentOutcome; note?: string } {
  const end = evs.findLast((e) => e.event === "swarm_give_up" || e.event === "swarm_done");
  if (end?.event === "swarm_give_up") return { state: "gave-up", note: String(prop(end, "reason") ?? "") || undefined };
  if (end?.event === "swarm_done") {
    const why = invalidReason(evs, flow);
    return why ? { state: "invalid", note: why } : { state: "success" };
  }
  return { state: live ? "running" : "stopped", note: live ? undefined : "No swarm_done / swarm_give_up in PostHog" };
}

/** Per-agent state. Agents from the config with no events yet appear as running
 * (live) or stopped; the screenshot manifest moves the step ahead of ingestion. */
export function deriveAgents(
  config: RunConfig,
  events: PostHogEvent[],
  flow: Flow | undefined,
  live: boolean,
  shots: { index?: ScreenshotIndex; files?: Set<string> } = {},
): AgentState[] {
  const byAgent = groupByAgent(events);
  const known = agentIdsOf(config);
  const extra = [...byAgent.keys()].filter((id) => !known.some((k) => k.agentId === id));
  const all = [
    ...known,
    ...extra.map((agentId) => {
      const e = byAgent.get(agentId)![0];
      const personaId = String(e.properties.swarm_persona ?? agentId.split("-")[0]);
      return { agentId, personaId, seed: Number(agentId.split("-").at(-1)) || 0 };
    }),
  ];
  return all.map(({ agentId, personaId, seed }) => {
    const evs = byAgent.get(agentId) ?? [];
    const { state, note } = evs.length ? outcomeOf(evs, flow, live) : { state: (live ? "running" : "stopped") as AgentOutcome, note: undefined };
    const shot = shots.index?.[agentId];
    const hasShot = !!shot || !!shots.files?.has(`${agentId}.png`);
    const pageStep = visitedSteps(evs, flow).at(-1);
    return {
      agentId,
      personaId,
      seed,
      state,
      step: (state === "running" && shot?.step) || pageStep || shot?.step,
      actions: evs.filter((e) => e.event === "$autocapture").length,
      missedActions:
        evs.filter((e) => e.event === "$rageclick").length +
        evs.filter((e) => e.event.endsWith("_submitted") && prop(e, "success") === false).length,
      budget: budgetOf(personaId, seed),
      latestScreenshot: hasShot ? `screenshots/${agentId}.png` : undefined,
      screenshotVersion: shot ? `${shot.n}` : hasShot ? `${evs.length}` : undefined,
      lastNote: String(prop(evs.findLast((e) => e.event === "swarm_think_aloud"), "note") ?? "") || undefined,
      outcomeNote: note,
      sessionId: evs[0]?.properties.$session_id,
      startedAt: evs[0] ? tsOf(evs[0]) : undefined,
      lastEventAt: evs.at(-1) ? tsOf(evs.at(-1)!) : undefined,
    };
  });
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Funnel steps to show: the flow's steps minus side branches nobody reached. */
export function funnelSteps(flow: Flow | undefined, seen: Set<string>): string[] {
  if (!flow) return [...seen];
  const required = new Set(flow.required.steps);
  return flow.steps.map((s) => s.name).filter((n) => required.has(n) || seen.has(n) || !/fail/i.test(n));
}

/** Provisional persona metrics from the swarm's sessions so far (live grid, Replay). */
export function deriveMetrics(config: RunConfig, events: PostHogEvent[], flow: Flow | undefined): Metrics {
  const byAgent = groupByAgent(events);
  const agents = deriveAgents(config, events, flow, true);
  const seen = new Set(events.map((e) => (e.event === "$pageview" ? stepOf(flow, e) : undefined)).filter((s): s is string => !!s));
  const steps = funnelSteps(flow, seen);
  const personas: PersonaMetrics[] = config.personaIds.map((personaId) => {
    const mine = agents.filter((a) => a.personaId === personaId);
    const ok = mine.filter((a) => a.state === "success");
    const ended = mine.filter((a) => a.state === "gave-up" || a.state === "invalid");
    const stepsOf = (id: string) => new Set(visitedSteps(byAgent.get(id) ?? [], flow));
    const funnel: FunnelStep[] = steps.map((step) => ({
      step,
      reached: mine.filter((a) => stepsOf(a.agentId).has(step)).length,
      droppedHere: ended.filter((a) => a.step === step).length,
    }));
    return {
      personaId,
      n: mine.length,
      users: mine.length,
      completed: ok.length,
      completionRate: mine.length ? ok.length / mine.length : 0,
      gaveUp: mine.filter((a) => a.state === "gave-up").length,
      invalidCompletions: mine.filter((a) => a.state === "invalid").length,
      medianSteps: median(ok.map((a) => a.actions)),
      medianTimeMs: median(ok.map((a) => (a.lastEventAt ?? 0) - (a.startedAt ?? 0))),
      funnel,
    };
  });
  return { runId: config.runId, flowId: config.flowId, buildSha: config.posthog.buildSha, segments: [], personas };
}

export type GiveUpGroup = {
  step: string;
  quotes: { agentId: string; personaId: string; note: string }[];
};

/** swarm_give_up reasons grouped by the step agents left at, largest group first. */
export function giveUpGroups(events: PostHogEvent[], flow?: Flow): GiveUpGroup[] {
  const groups = new Map<string, GiveUpGroup>();
  for (const [agentId, evs] of groupByAgent(events)) {
    const g = evs.findLast((e) => e.event === "swarm_give_up");
    if (!g) continue;
    const step = String(prop(g, "step") ?? "") || visitedSteps(evs, flow).at(-1) || "Unknown step";
    const group = groups.get(step) ?? { step, quotes: [] };
    group.quotes.push({ agentId, personaId: String(g.properties.swarm_persona ?? ""), note: String(prop(g, "reason") ?? "(no reason given)") });
    groups.set(step, group);
  }
  return [...groups.values()].sort((a, b) => b.quotes.length - a.quotes.length);
}
