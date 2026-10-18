import { PERSONAS, SEGMENTS, type Finding, type Flow, type Verdict } from "../shared";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** The 1–3 findings the coding agent should fix: most severe, then most sessions affected. */
export function topFindings(findings: Finding[], max = 3): Finding[] {
  return [...findings]
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.evidence.sessions - a.evidence.sessions,
    )
    .slice(0, max);
}

const segmentName = (id: string) => SEGMENTS.find((s) => s.id === id)?.name ?? id;
const personaName = (id: string) => PERSONAS[id]?.name ?? id;
const pct = (x: number) => `${Math.round(x * 100)}%`;

const describeFinding = (f: Finding, i: number) =>
  [
    `### ${i + 1}. ${f.title} (${f.severity})`,
    `- Step: ${f.step} — page \`${f.page}\`${f.selector ? ` — element \`${f.selector}\`` : ""}`,
    `- Affects: ${f.segments.map(segmentName).join(", ")} — ${f.evidence.sessions} sessions (${f.evidence.users} users)` +
      (f.evidence.dropOffRate !== undefined ? `, ${pct(f.evidence.dropOffRate)} drop off here` : "") +
      (f.evidence.rageClicks ? `, ${f.evidence.rageClicks} rage clicks` : ""),
    ...(f.evidence.sinceRelease
      ? [`- Started with release "${f.evidence.sinceRelease.name}" (${f.evidence.sinceRelease.date}, \`${f.evidence.sinceRelease.sha.slice(0, 7)}\`)`]
      : []),
    ...f.evidence.quotes.slice(0, 3).map((q) => `- Test shopper said: "${q}"`),
    `- Suggested direction: ${f.suggestedFix}`,
  ].join("\n");

/** A retry: the previous attempt's change is on the branch, and the persona swarm that shopped its
 * preview still struggled. */
export type RetryContext = {
  /** This attempt's number (2, 3, …). */
  attempt: number;
  /** What the real-user analysis found, which attempt 1 fixed: the loop's goal throughout. */
  original: Finding[];
  /** The findings the previous attempt targeted (persistsFrom on this attempt's findings points here). */
  previousTargets: Finding[];
  previousSummary: string;
  previousVerdict: Verdict;
};

const describeVerdict = (v: Verdict) =>
  v.comparisons
    .map((c) => {
      const role = v.targetedPersonas.includes(c.personaId) ? " (targeted)" : PERSONAS[c.personaId]?.control ? " (control)" : "";
      const regressions = c.regressions.length ? `; regressions: ${c.regressions.join("; ")}` : "";
      return `- ${personaName(c.personaId)}${role}: ${pct(c.after.completionRate)} of ${c.after.n} agents completed vs ${pct(c.before.completionRate)} of ${segmentName(c.segmentId)} real users (${c.completionDeltaPts > 0 ? "+" : ""}${c.completionDeltaPts} pts)${regressions}`;
    })
    .join("\n");

function describeRetry(r: RetryContext, findings: Finding[]): string {
  const title = (id: string) => r.previousTargets.find((t) => t.id === id)?.title ?? id;
  const persisting = findings.filter((f) => f.persistsFrom).map((f) => `- "${title(f.persistsFrom!)}" is still a problem (finding ${findings.indexOf(f) + 1} below)`);
  return `## This is attempt ${r.attempt}: the previous fix is already on this branch, and it was not enough

The real shoppers' original problems were:

${r.original.map((f) => `- ${f.title} (${f.step}, \`${f.page}\`)`).join("\n")}

The previous attempt's change (see \`git log -p\` on this branch), in its own words:

${r.previousSummary.trim() || "(no summary)"}

A swarm of AI shoppers with each segment's perception and action limits then shopped the deploy preview with that change:

${describeVerdict(r.previousVerdict)}

${r.previousVerdict.reasons.map((x) => `- ${x}`).join("\n")}
${persisting.length ? `\n${persisting.join("\n")}\n` : ""}
Below is what the swarm struggled with on that build, quoting what the agents said. Build on the previous change: keep what
helped, rework what didn't, and if the change itself caused a new problem, fix or revert that part.
`;
}

/** Prompt for Claude Code (headless) running in a clone of the storefront repo (on a retry, the
 * PR branch with the previous attempt's change). */
export function buildFixPrompt(flow: Flow, findings: Finding[], retry?: RetryContext): string {
  return `You are fixing UX friction in this Next.js storefront. Real shoppers' PostHog data shows they struggle with this task:

> ${flow.goal}
${retry ? `\n${describeRetry(retry, findings)}` : ""}
## Findings to fix${retry ? " (from the swarm's re-test of the previous attempt)" : ""}

${findings.map(describeFinding).join("\n\n")}

## Hard constraints (the change is rejected if any is broken)

- These checkout steps must still exist and be reachable in this order: ${flow.required.steps.join(" → ")}.
- These fields must still be collected and submitted: ${flow.required.fields.join(", ")}. Do not remove, hide, prefill with fake data or make them optional.
- The payment step must stay at \`/checkout?step=payment\` and the confirmation page at \`/checkout/success\`.
- The confirmation page must keep echoing email, address and the masked card (\`data-echo\` attributes).
- Keep the \`build-sha\` meta tag in \`src/app/layout.tsx\` and \`next.config.mjs\` as they are.
- Do not touch tracking: leave \`src/lib/analytics.ts\` and \`src/components/Analytics.tsx\` alone, and keep every analytics call with its event name and properties. The fix is measured through these events.
- Make one focused change that addresses the findings above and nothing else: no refactors, no dependency changes, no unrelated styling.${retry ? "\n- Do not undo the previous attempt wholesale unless it caused the problems above; then say so in your summary." : ""}

## How to work

1. Find the code behind each finding and fix the cause, following the existing code style and components.
2. Run \`npm run build\` and fix any error it reports.
3. Do not commit, push or open a pull request; that is done for you after you finish.
4. End with a summary for a product owner, not a developer: one short sentence per finding saying what shoppers will now see or do differently and why it helps them finish the task. No file names, code, components or technical details, and nothing else before or after.
`;
}
