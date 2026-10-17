// REFERENCE / REHEARSAL implementation of SPEC's improvement threshold. P1 owns the real
// verdict in orchestrator/verdict.ts (#13), which may reuse this. Pure.
import { FLOWS, SEGMENTS, type Flow, type Metrics, type PersonaComparison, type PersonaId, type Verdict } from "@frictionswarm/shared";

/** Completion must rise by at least this many percentage points for a targeted persona. */
export const IMPROVEMENT_PTS = 20;

type Funnel = Metrics["segments"][number]["funnel"];
const reachedOf = (funnel: Funnel, step: string) => funnel.find((f) => f.step === step)?.reached ?? 0;

/** Conversion into each required step from the previous one (entry → first required step uses N).
 * Required steps only, so a fix that removes an optional step (e.g. a forced sign-up) isn't a regression. */
export function stepConversions(flow: Flow, g: { n: number; funnel: Funnel }): { step: string; rate: number | undefined }[] {
  let prev = g.n;
  return flow.required.steps.map((step) => {
    const r = reachedOf(g.funnel, step);
    const rate = prev ? r / prev : undefined;
    prev = r;
    return { step, rate };
  });
}

const pts = (x: number) => Math.round(x * 1000) / 10;

/** Before = each segment's real users (analysis run); after = its persona's swarm (retest run).
 * Improved = some targeted persona's completion is ≥ 20 pts above its segment's AND no persona is
 * below its segment on completion or on any required step's conversion (the control included). */
export function compareSegmentsToPersonas(
  analysis: Metrics,
  retest: Metrics,
  targetedPersonas: PersonaId[],
  flow: Flow = FLOWS[analysis.flowId],
): Verdict {
  const comparisons: PersonaComparison[] = [];
  const reasons: string[] = [];
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
        const ra = a[i].rate, rb = b[i].rate;
        if (ra !== undefined && rb !== undefined && ra < rb) regressions.push(`${a[i].step} conversion ${pts(ra)}% < ${pts(rb)}%`);
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
  return { improved: lifted.length > 0 && !regressed, targetedPersonas, comparisons, reasons };
}
