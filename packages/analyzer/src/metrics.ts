// Deterministic metrics, no LLM. Definitions (also in the README of this package):
//   N            sessions ($session_id); users = distinct distinct_id
//   completed    valid completions (validateCompletion)
//   gaveUp       retest: sessions with swarm_give_up; analysis: sessions that never reached success
//   steps        funnel $pageviews + $autocapture actions (clicks/submits), per session
//   time         first event → first success $pageview
//   medianSteps / medianTimeMs  over valid completions only (0 when none)
//   funnel       per flow step reached by anyone in the run (plus required steps):
//                reached = sessions whose $pageviews include it; droppedHere = sessions that
//                didn't complete and whose last $pageview step was this one
import {
  PERSONAS,
  SEGMENTS,
  type Flow,
  type FunnelStep,
  type Metrics,
  type PersonaMetrics,
  type PostHogEvent,
  type RunConfig,
  type SegmentMetrics,
} from "@frictionswarm/shared";
import { historyFromSummaries, type History } from "./history";
import { summarizeSessions, type SessionSummary } from "./sessions";

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = xs.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Flow steps reached by anyone in the run, plus the required ones, in flow order. */
export function funnelSteps(flow: Flow, sessions: SessionSummary[]): string[] {
  const reached = new Set(sessions.flatMap((s) => s.steps));
  return flow.steps.map((s) => s.name).filter((n) => reached.has(n) || flow.required.steps.includes(n));
}

type Group = Omit<SegmentMetrics, "segmentId">;

export function groupMetrics(sessions: SessionSummary[], steps: string[], swarm: boolean): Group {
  const n = sessions.length;
  const done = sessions.filter((s) => s.valid);
  const funnel: FunnelStep[] = steps.map((step) => ({
    step,
    reached: sessions.filter((s) => s.steps.includes(step)).length,
    droppedHere: sessions.filter((s) => !s.valid && s.lastStep === step).length,
  }));
  return {
    n,
    users: new Set(sessions.map((s) => s.distinctId)).size,
    completed: done.length,
    completionRate: n ? done.length / n : 0,
    gaveUp: swarm ? sessions.filter((s) => s.notes.some((x) => x.kind === "give_up")).length : sessions.filter((s) => !s.success).length,
    invalidCompletions: sessions.filter((s) => s.success && !s.valid).length,
    medianSteps: median(done.map((s) => s.pageviews + s.actions)),
    medianTimeMs: median(done.map((s) => s.timeToCompleteMs ?? 0)),
    funnel,
  };
}

export type MetricsOptions = {
  /** Analysis runs: the history behind the weekly trend and release markers. Default: the events themselves. */
  history?: History;
};

/** Pure: PostHog events (or their session summaries) → metrics.json.
 * Analysis runs get every segment (SEGMENTS order) plus the trend; retests get the configured
 * personas (config order, then any other persona seen). */
export function computeMetrics(
  config: RunConfig,
  flow: Flow,
  input: PostHogEvent[] | SessionSummary[],
  opts: MetricsOptions = {},
): Metrics {
  const sessions = isSummaries(input) ? input : summarizeSessions(flow, input);
  const steps = funnelSteps(flow, sessions);
  const base = { runId: config.runId, flowId: config.flowId, buildSha: config.posthog.buildSha };
  if (config.kind === "retest") {
    const ids = [...new Set([...config.personaIds, ...sessions.map((s) => s.personaId).filter((p): p is string => !!p)])];
    const personas = ids.map((personaId): PersonaMetrics => ({
      personaId,
      ...groupMetrics(sessions.filter((s) => s.personaId === personaId), steps, true),
    }));
    return { ...base, segments: [], personas };
  }
  const segments = SEGMENTS.map((seg): SegmentMetrics => ({
    segmentId: seg.id,
    ...groupMetrics(sessions.filter((s) => s.segment === seg.id), steps, false),
  }));
  const history =
    opts.history ??
    historyFromSummaries(sessions, { from: config.window?.from ?? "", to: config.window?.to ?? "" });
  return { ...base, segments, personas: [], trend: { points: history.trend, releases: history.releases } };
}

const isSummaries = (x: PostHogEvent[] | SessionSummary[]): x is SessionSummary[] => !!x.length && "steps" in x[0];

/** Persona ↔ segment helpers. */
export const segmentOfPersona = (personaId: string) => SEGMENTS.find((s) => s.personaId === personaId)?.id;
export const personaName = (personaId: string) => PERSONAS[personaId]?.name ?? personaId;
