import type { Event, Flow, Metrics, PersonaMetrics, RunConfig } from "@frictionswarm/shared";
import { groupByAgent } from "./run";
import { validateCompletion } from "./validity";

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = xs.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const lastStep = (evs: Event[]) => evs.findLast((e) => e.step)?.step;

/** Funnel steps: a flow step is shown if any agent in the run reached it or it is required. */
export function funnelSteps(flow: Flow, events: Event[]): string[] {
  const reached = new Set(events.map((e) => e.step));
  return flow.steps.map((s) => s.name).filter((n) => reached.has(n) || flow.required.steps.includes(n));
}

/** Deterministic metrics. N counts agents that wrote at least one event; personas follow config order. */
export function computeMetrics(config: RunConfig, flow: Flow, events: Event[]): Metrics {
  const byAgent = groupByAgent(events);
  const steps = funnelSteps(flow, events);
  const personaIds = [...new Set([...config.personaIds, ...events.map((e) => e.personaId)])];

  const personas = personaIds.map((personaId): PersonaMetrics => {
    const agents = [...byAgent.values()].filter((evs) => evs[0].personaId === personaId);
    const results = agents.map((evs) => ({
      evs,
      valid: validateCompletion(flow, evs).valid,
      success: evs.some((e) => e.type === "success"),
      steps: new Set(evs.map((e) => e.step)),
    }));
    const n = agents.length;
    const done = results.filter((r) => r.valid).map((r) => r.evs);
    const completed = done.length;
    return {
      personaId,
      n,
      completed,
      completionRate: n ? completed / n : 0,
      gaveUp: results.filter((r) => r.evs.some((e) => e.type === "give_up")).length,
      invalidCompletions: results.filter((r) => r.success && !r.valid).length,
      medianSteps: median(done.map((evs) => evs.filter((e) => e.type === "action").length)),
      medianTimeMs: median(done.map((evs) => evs.at(-1)!.ts - evs[0].ts)),
      funnel: steps.map((step) => ({
        step,
        reached: results.filter((r) => r.steps.has(step)).length,
        droppedHere: results.filter((r) => !r.valid && lastStep(r.evs) === step).length,
      })),
    };
  });
  return { runId: config.runId, flowId: config.flowId, buildSha: config.buildSha, personas };
}
