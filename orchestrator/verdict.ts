import type { Metrics, PersonaComparison, PersonaId, PersonaMetrics, Verdict } from "../shared";

/** Completion must rise this many percentage points for at least one targeted persona. */
export const MIN_IMPROVEMENT_PTS = 20;

// Rates may not get worse at all. Effort medians are LLM-latency noisy, so they
// only count as worse past a tolerance.
const STEPS_TOLERANCE = 0.1;
const TIME_TOLERANCE = 0.25;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const rate = (count: number, n: number) => (n ? count / n : 0);

function regressions(before: PersonaMetrics, after: PersonaMetrics): string[] {
  const out: string[] = [];
  if (after.completionRate < before.completionRate)
    out.push(`completion ${pct(before.completionRate)} → ${pct(after.completionRate)}`);
  const gaveUp = [rate(before.gaveUp, before.n), rate(after.gaveUp, after.n)];
  if (gaveUp[1] > gaveUp[0]) out.push(`give-up ${pct(gaveUp[0])} → ${pct(gaveUp[1])}`);
  const invalid = [rate(before.invalidCompletions, before.n), rate(after.invalidCompletions, after.n)];
  if (invalid[1] > invalid[0]) out.push(`invalid completions ${pct(invalid[0])} → ${pct(invalid[1])}`);
  // Medians are over completers only; compare only when both runs have some
  if (before.completed && after.completed) {
    if (after.medianSteps > before.medianSteps * (1 + STEPS_TOLERANCE))
      out.push(`median steps ${before.medianSteps} → ${after.medianSteps}`);
    if (after.medianTimeMs > before.medianTimeMs * (1 + TIME_TOLERANCE))
      out.push(
        `median time ${Math.round(before.medianTimeMs / 1000)}s → ${Math.round(after.medianTimeMs / 1000)}s`,
      );
  }
  return out;
}

/** SPEC "Improvement threshold": completion +≥20 pts for at least one targeted
 * persona AND no metric worse for any persona, control included. */
export function compareRuns(
  before: Metrics,
  after: Metrics,
  targetedPersonas: PersonaId[],
): Verdict {
  const problems: string[] = [];
  const comparisons: PersonaComparison[] = [];

  for (const b of before.personas) {
    const a = after.personas.find((p) => p.personaId === b.personaId);
    if (!a) {
      problems.push(`${b.personaId}: missing from the re-test`);
      continue;
    }
    const c: PersonaComparison = {
      personaId: b.personaId,
      before: b,
      after: a,
      completionDeltaPts: Math.round((a.completionRate - b.completionRate) * 100),
      regressions: regressions(b, a),
    };
    comparisons.push(c);
    for (const r of c.regressions) problems.push(`${c.personaId}: ${r}`);
  }

  const gains = comparisons.filter(
    (c) => targetedPersonas.includes(c.personaId) && c.completionDeltaPts >= MIN_IMPROVEMENT_PTS,
  );
  const reasons = gains.length
    ? gains.map((g) => `${g.personaId}: completion +${g.completionDeltaPts} pts (N=${g.before.n}→${g.after.n})`)
    : [`no targeted persona (${targetedPersonas.join(", ")}) improved completion by ≥${MIN_IMPROVEMENT_PTS} pts`];

  const improved = gains.length > 0 && problems.length === 0;
  return { improved, targetedPersonas, comparisons, reasons: [...reasons, ...problems] };
}
