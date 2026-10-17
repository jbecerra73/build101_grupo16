// Pure derivations from the event log. Runs on the server (API) and in the
// browser (Replay), so it must not import node modules.
import {
  actionBudget,
  MAX_ACTIONS_PER_AGENT,
  PERSONAS,
  type Event,
  type Flow,
  type FunnelStep,
  type Metrics,
  type PersonaMetrics,
  type RunConfig,
} from "@frictionswarm/shared";
import type { AgentOutcome, AgentState } from "./types";

export const agentIdsOf = (config: RunConfig) =>
  config.personaIds.flatMap((p) => (config.seeds[p] ?? []).map((seed) => ({ agentId: `${p}-${seed}`, personaId: p, seed })));

/** The agent's action budget, drawn by seed for personas with a range (Kai: 8–12). */
export const budgetOf = (personaId: string, seed: number) => {
  const persona = PERSONAS[personaId];
  return persona ? actionBudget(persona, seed) : MAX_ACTIONS_PER_AGENT;
};

export function groupByAgent(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    const list = map.get(e.agentId);
    if (list) list.push(e);
    else map.set(e.agentId, [e]);
  }
  for (const list of map.values()) list.sort((a, b) => a.ts - b.ts);
  return map;
}

/** Dashboard-side completion validity (SPEC: success condition + every required
 * step in the log + confirmation echoes the required fields + no more actions
 * than the seeded budget). The analyzer owns the authoritative version; this
 * mirrors it for live tiles and replay. */
export function invalidReason(evs: Event[], flow?: Flow): string | undefined {
  const success = evs.findLast((e) => e.type === "success");
  if (!success) return undefined;
  const actions = evs.filter((e) => e.type === "action").length;
  const budget = budgetOf(success.personaId, success.seed);
  if (actions > budget) return `Exceeded action budget (${actions}/${budget})`;
  const steps = new Set(evs.map((e) => e.step).filter(Boolean));
  const missing = (flow?.required.steps ?? []).filter((s) => !steps.has(s));
  if (missing.length) return `Reached confirmation without ${missing.join(", ")}`;
  const c = success.confirmation ?? {};
  const echoed = ["email", "address", "cardLast4"].filter((k) => !c[k as keyof typeof c]);
  if (flow && echoed.length) return `Confirmation did not echo ${echoed.join(", ")}`;
  return undefined;
}

function outcomeOf(evs: Event[], flow: Flow | undefined, live: boolean): { state: AgentOutcome; note?: string } {
  const last = evs.findLast((e) => e.type === "give_up" || e.type === "success");
  if (last?.type === "give_up") return { state: "gave-up", note: last.note };
  if (last?.type === "success") {
    const why = invalidReason(evs, flow);
    return why ? { state: "invalid", note: why } : { state: "success" };
  }
  return { state: live ? "running" : "stopped", note: live ? undefined : "No terminal event in the log" };
}

/** Per-agent live state. Agents from the config with no events yet appear as running. */
export function deriveAgents(config: RunConfig, events: Event[], flow: Flow | undefined, live: boolean): AgentState[] {
  const byAgent = groupByAgent(events);
  const known = agentIdsOf(config);
  const extra = [...byAgent.keys()].filter((id) => !known.some((k) => k.agentId === id));
  const all = [
    ...known,
    ...extra.map((id) => {
      const e = byAgent.get(id)![0];
      return { agentId: id, personaId: e.personaId, seed: e.seed };
    }),
  ];
  return all.map(({ agentId, personaId, seed }) => {
    const evs = byAgent.get(agentId) ?? [];
    const { state, note } = evs.length ? outcomeOf(evs, flow, live) : { state: (live ? "running" : "stopped") as AgentOutcome, note: undefined };
    const actions = evs.filter((e) => e.type === "action");
    return {
      agentId,
      personaId,
      seed,
      state,
      step: evs.findLast((e) => e.step)?.step,
      actions: actions.length,
      missedActions: actions.filter((e) => e.action?.missed).length,
      budget: budgetOf(personaId, seed),
      latestScreenshot: evs.findLast((e) => e.screenshot)?.screenshot,
      lastNote: evs.findLast((e) => e.type === "think_aloud" && e.note)?.note,
      outcomeNote: note,
      startedAt: evs[0]?.ts,
      lastEventAt: evs.at(-1)?.ts,
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
function funnelSteps(flow: Flow | undefined, events: Event[]): string[] {
  if (!flow) return [...new Set(events.map((e) => e.step).filter((s): s is string => !!s))];
  const seen = new Set(events.map((e) => e.step));
  const required = new Set(flow.required.steps);
  return flow.steps.map((s) => s.name).filter((n) => required.has(n) || seen.has(n) || !/fail/i.test(n));
}

/** Provisional metrics computed from events so far (live runs and Replay).
 * Mirrors the analyzer's conventions: steps = actions, time = first→last event,
 * medians over valid completions only. */
export function deriveMetrics(config: RunConfig, events: Event[], flow: Flow | undefined): Metrics {
  const byAgent = groupByAgent(events);
  const agents = deriveAgents(config, events, flow, true);
  const steps = funnelSteps(flow, events);
  const personas: PersonaMetrics[] = config.personaIds.map((personaId) => {
    const mine = agents.filter((a) => a.personaId === personaId);
    const ok = mine.filter((a) => a.state === "success");
    const ended = mine.filter((a) => a.state === "gave-up" || a.state === "invalid");
    const evsOf = (id: string) => byAgent.get(id) ?? [];
    const funnel: FunnelStep[] = steps.map((step) => ({
      step,
      reached: mine.filter((a) => evsOf(a.agentId).some((e) => e.step === step)).length,
      droppedHere: ended.filter((a) => a.step === step).length,
    }));
    return {
      personaId,
      n: mine.length,
      completed: ok.length,
      completionRate: mine.length ? ok.length / mine.length : 0,
      gaveUp: mine.filter((a) => a.state === "gave-up").length,
      invalidCompletions: mine.filter((a) => a.state === "invalid").length,
      medianSteps: median(ok.map((a) => a.actions)),
      medianTimeMs: median(ok.map((a) => (a.lastEventAt ?? 0) - (a.startedAt ?? 0))),
      funnel,
    };
  });
  return { runId: config.runId, flowId: config.flowId, buildSha: config.buildSha, personas };
}

export type GiveUpGroup = {
  step: string;
  quotes: { agentId: string; personaId: string; note: string }[];
};

/** Give-up reasons grouped by the step where agents left, largest group first. */
export function giveUpGroups(events: Event[]): GiveUpGroup[] {
  const groups = new Map<string, GiveUpGroup>();
  for (const evs of groupByAgent(events).values()) {
    const g = evs.findLast((e) => e.type === "give_up");
    if (!g) continue;
    const step = g.step ?? evs.findLast((e) => e.step)?.step ?? "Unknown step";
    const group = groups.get(step) ?? { step, quotes: [] };
    group.quotes.push({ agentId: g.agentId, personaId: g.personaId, note: g.note ?? "(no reason given)" });
    groups.set(step, group);
  }
  return [...groups.values()].sort((a, b) => b.quotes.length - a.quotes.length);
}
