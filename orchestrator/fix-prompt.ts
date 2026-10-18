import { SEGMENTS, type Finding, type Flow } from "../shared";

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

/** Prompt for Claude Code (headless) running in a clone of the storefront repo. */
export function buildFixPrompt(flow: Flow, findings: Finding[]): string {
  return `You are fixing UX friction in this Next.js storefront. Real shoppers' PostHog data shows they struggle with this task:

> ${flow.goal}

## Findings to fix

${findings.map(describeFinding).join("\n\n")}

## Hard constraints (the change is rejected if any is broken)

- These checkout steps must still exist and be reachable in this order: ${flow.required.steps.join(" → ")}.
- These fields must still be collected and submitted: ${flow.required.fields.join(", ")}. Do not remove, hide, prefill with fake data or make them optional.
- The payment step must stay at \`/checkout?step=payment\` and the confirmation page at \`/checkout/success\`.
- The confirmation page must keep echoing email, address and the masked card (\`data-echo\` attributes).
- Keep the \`build-sha\` meta tag in \`src/app/layout.tsx\` and \`next.config.mjs\` as they are.
- Do not touch tracking: leave \`src/lib/analytics.ts\` and \`src/components/Analytics.tsx\` alone, and keep every analytics call with its event name and properties. The fix is measured through these events.
- Make one focused change that addresses the findings above and nothing else: no refactors, no dependency changes, no unrelated styling.

## How to work

1. Find the code behind each finding and fix the cause, following the existing code style and components.
2. Run \`npm run build\` and fix any error it reports.
3. Do not commit, push or open a pull request; that is done for you after you finish.
4. End with a summary for a product owner, not a developer: one short sentence per finding saying what shoppers will now see or do differently and why it helps them finish the task. No file names, code, components or technical details, and nothing else before or after.
`;
}
