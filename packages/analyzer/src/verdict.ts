// REFERENCE / REHEARSAL implementation of SPEC's improvement threshold. P1 owns the real
// verdict in orchestrator/verdict.ts (#13), which may reuse this. Pure.
import { FLOWS, SEGMENTS, type Flow, type Metrics, type PersonaComparison, type PersonaId, type Verdict } from "@frictionswarm/shared";

/** Completion must rise by at least this many percentage points for a targeted persona. */
export const IMPROVEMENT_PTS = 20;
/** A step only regresses when the persona is more than this many points below its segment… */
export const STEP_TOLERANCE_PTS = 15;
/** …and the segment's rate is above the persona's Wilson upper bound at this confidence. */
export const STEP_CONFIDENCE = 0.95;

export type VerdictOptions = {
  flow?: Flow;
  /** Default 15. */
  stepTolerancePts?: number;
  /** Two-sided confidence of the Wilson interval. Default 0.95. */
  confidence?: number;
};

type Funnel = Metrics["segments"][number]["funnel"];
const reachedOf = (funnel: Funnel, step: string) => funnel.find((f) => f.step === step)?.reached ?? 0;

/** Conversion into each required step from the previous one (entry → first required step uses N);
 * `n` is how many sessions could convert (reached the previous step). Required steps only, so a
 * fix that removes an optional step (e.g. a forced sign-up) isn't a regression. */
export function stepConversions(flow: Flow, g: { n: number; funnel: Funnel }): { step: string; rate: number | undefined; n: number }[] {
  let prev = g.n;
  return flow.required.steps.map((step) => {
    const r = reachedOf(g.funnel, step);
    // Capped at 100%: a shortcut can reach a later step without the earlier one.
    const out = { step, rate: prev ? Math.min(1, r / prev) : undefined, n: prev };
    prev = r;
    return out;
  });
}

/** Standard normal quantile (Acklam's approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Wilson score interval for a proportion `rate` observed over `n` trials. */
export function wilsonInterval(rate: number, n: number, confidence = STEP_CONFIDENCE): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const z2 = z * z;
  const center = (rate + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

const pts = (x: number) => Math.round(x * 1000) / 10;

/** Before = each segment's real users (analysis run); after = its persona's swarm (retest run).
 * Improved = some targeted persona's completion is ≥ 20 pts above its segment's AND no persona's
 * completion is below its segment's (strict) AND no required step regresses. With ~10 agents a
 * single agent is 10 pts, so a step only regresses when the persona is more than 15 pts below its
 * segment AND the segment's rate is above the persona's 95% Wilson upper bound for its N at that
 * step; steps with N = 0 are skipped. */
export function compareSegmentsToPersonas(
  analysis: Metrics,
  retest: Metrics,
  targetedPersonas: PersonaId[],
  opts: VerdictOptions = {},
): Verdict {
  const flow = opts.flow ?? (Object.hasOwn(FLOWS, analysis.flowId) ? FLOWS[analysis.flowId] : undefined);
  const tolerance = (opts.stepTolerancePts ?? STEP_TOLERANCE_PTS) / 100;
  const confidence = opts.confidence ?? STEP_CONFIDENCE;
  const comparisons: PersonaComparison[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];
  for (const after of retest.personas) {
    const seg = SEGMENTS.find((s) => s.personaId === after.personaId);
    const before = seg && analysis.segments.find((s) => s.segmentId === seg.id);
    if (!seg || !before) {
      reasons.push(`${after.personaId}: no segment baseline to compare against`);
      continue;
    }
    const regressions: string[] = [];
    if (after.completionRate < before.completionRate)
      regressions.push(`completion ${pts(after.completionRate)}% < ${pts(before.completionRate)}%`);
    if (flow) {
      const b = stepConversions(flow, before);
      const a = stepConversions(flow, after);
      for (let i = 0; i < a.length; i++) {
        const ra = a[i].rate, rb = b[i].rate, n = a[i].n;
        if (ra === undefined || rb === undefined || n === 0 || ra >= rb) continue;
        const { upper } = wilsonInterval(ra, n, confidence);
        const margin = `${Math.round(confidence * 100)}% upper bound ${pts(upper)}%`;
        if (rb - ra > tolerance && rb > upper) regressions.push(`${a[i].step} conversion ${pts(ra)}% (n=${n}) < ${pts(rb)}% (${margin})`);
        else notes.push(`${after.personaId} ${a[i].step} ${pts(ra)}% (n=${n}) vs ${pts(rb)}%: within small-N margin (${margin}, tolerance ${pts(tolerance)} pts), not a regression`);
      }
    }
    const completionDeltaPts = pts(after.completionRate - before.completionRate);
    comparisons.push({ personaId: after.personaId, segmentId: seg.id, before, after, completionDeltaPts, regressions });
    for (const r of regressions) reasons.push(`${after.personaId} vs ${seg.id}: ${r} (n=${after.n} vs ${before.n})`);
  }
  const lifted = comparisons.filter((c) => targetedPersonas.includes(c.personaId) && c.completionDeltaPts >= IMPROVEMENT_PTS);
  const regressed = comparisons.some((c) => c.regressions.length);
  for (const c of lifted) reasons.unshift(`${c.personaId}: +${c.completionDeltaPts} pts vs ${c.segmentId} (n=${c.after.n} vs ${c.before.n})`);
  if (!lifted.length) reasons.push(`no targeted persona (${targetedPersonas.join(", ") || "none"}) improved by ≥ ${IMPROVEMENT_PTS} pts`);
  reasons.push(...notes);
  return { improved: lifted.length > 0 && !regressed, targetedPersonas, comparisons, reasons };
}
