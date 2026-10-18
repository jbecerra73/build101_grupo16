// Markdown the MCP tools reply with: flow cards, analysis reports, the run story
// and the decision package. Pure functions over the dashboard API's JSON, sized
// to read well in a terminal.
import { DIFF_UNAVAILABLE, type EventMatch, type FixAttempt, type Finding, type Flow, type PersonaComparison, type RunPhase, type Severity } from "@frictionswarm/shared";
import type { SwarmTopology } from "../../dashboard/lib/control-types";
import type { RunDetail } from "../../dashboard/lib/types";

export type Links = { dashboard: (path: string) => string };

/** Diff lines shown in the decision package before it is cut. */
export const MAX_DIFF_LINES = 300;
const TOP_FINDINGS = 5;
const REPLAYS_PER_FINDING = 3;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ratio = (a: number, b: number) => (b ? a / b : 0);
const sha7 = (sha?: string) => (sha ? sha.slice(0, 7) : "?");
const signed = (pts: number) => `${pts >= 0 ? "+" : "−"}${Math.abs(pts).toFixed(1)} pts`;

export const runLink = (links: Links, runId: string) => links.dashboard(`/runs/${encodeURIComponent(runId)}`);
export const flowLink = (links: Links, flowId: string) => links.dashboard(`/flows/${encodeURIComponent(flowId)}`);

/** Rehearsal fixes (fake fix loop) open no PR: prNumber 0. */
export const isRehearsal = (a: FixAttempt) => a.prNumber === 0 || a.decision?.rehearsal === true;

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
/** Same order as the dashboard's rankFindings: severity, then affected sessions. */
export const rankFindings = (findings: Finding[]) =>
  findings.toSorted((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.evidence.sessions - a.evidence.sessions);

const successRule = (flow: Flow) =>
  [flow.success.urlPattern && `URL matches ${flow.success.urlPattern}`, flow.success.visibleText && `page shows "${flow.success.visibleText}"`]
    .filter(Boolean)
    .join(" and ");

const eventMatchText = (m: EventMatch) => {
  const where = Object.entries(m.where ?? {}).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.map(String).join(" | ") : String(v)}`);
  return `\`${m.event}\`${where.length ? ` (${where.join(", ")})` : ""}`;
};

/** The flow review card, in the dashboard flow page's order: goal, start URL, success, required fields, steps.
 * The rest of the flow (completion events, attempt filter, done instruction, personas) sits between the
 * required fields and the steps, so nothing the coding agent and swarm use is hidden from the review. */
export function flowCard(flow: Flow, changes?: string[]): string {
  const lines = [
    `### Flow \`${flow.id}\``,
    `Goal: ${flow.goal}`,
    `Start URL: ${flow.startUrl}`,
    `Success: ${successRule(flow)}`,
    `Required fields: ${flow.required.fields.length ? flow.required.fields.join(", ") : "none"}`,
    `Completion events: ${flow.completion?.length ? flow.completion.map(eventMatchText).join(", ") : "none"}`,
    `Counts as attempting (real users): ${flow.attempt ? `sessions with ${eventMatchText(flow.attempt)}` : "every session"}`,
    `Done when: ${flow.doneWhen || "from the success rule"}`,
    `Personas: ${flow.personas?.length ? flow.personas.join(", ") : "every segment's persona"}`,
    "",
    "Steps (🔒 = required, the coding agent may not remove it):",
    ...flow.steps.map((s, i) => `${i + 1}. ${s.route} → ${flow.required.steps.includes(s.name) ? "🔒 " : ""}${s.name}`),
  ];
  if (changes) lines.push("", changes.length ? "Changed:" : "No changes against the saved flow.", ...changes.map((c) => `- ${c}`));
  return lines.join("\n");
}

const findingLine = (f: Finding, replayBase?: string) => {
  const e = f.evidence;
  const since = e.sinceRelease ? ` · since release "${e.sinceRelease.name}" (${e.sinceRelease.date})` : "";
  const lines = [`- **${f.id}** [${f.severity}] at ${f.step}: ${f.title} · ${e.sessions} sessions / ${e.users} users${since}`];
  if (replayBase && e.exampleSessions.length) {
    const replays = e.exampleSessions.slice(0, REPLAYS_PER_FINDING).map((id) => `${replayBase}${encodeURIComponent(id)}`);
    lines.push(`  Replays: ${replays.join(" ")}`);
  }
  return lines.join("\n");
};

/** Segment funnels, releases and top findings of a finished analysis. */
export function analysisReport(run: RunDetail, links: Links): string {
  const { config } = run;
  const window = config.window ? `${config.window.from} → ${config.window.to}` : "current release, last 28 days";
  const lines = [`## Analysis of \`${config.flowId}\` · ${window} · ${config.posthog.source} data`];
  const segments = run.metrics?.segments ?? [];
  if (!segments.some((s) => s.n > 0)) {
    lines.push("", "No real-user sessions for this flow in the window (N = 0), so there is no funnel to show.");
  } else {
    for (const s of segments) {
      lines.push("", `### Segment \`${s.segmentId}\` · N ${s.n} sessions · ${pct(s.completionRate)} completed (${s.completed})`);
      if (!s.n) continue;
      lines.push("| Step | Conversion | Drop-off | N |", "|---|---|---|---|");
      for (const f of s.funnel) lines.push(`| ${f.step} | ${pct(ratio(f.reached, s.n))} | ${pct(ratio(f.droppedHere, f.reached))} | ${f.reached} |`);
    }
  }
  const releases = run.metrics?.trend?.releases ?? run.releases ?? [];
  if (releases.length) lines.push("", `Releases in the data: ${releases.map((r) => `"${r.name}" (${r.date}, ${sha7(r.sha)})`).join(", ")}`);

  const findings = rankFindings(run.findings ?? []);
  lines.push("", findings.length ? `### Top findings (${Math.min(TOP_FINDINGS, findings.length)} of ${findings.length})` : "No findings.");
  for (const f of findings.slice(0, TOP_FINDINGS)) lines.push(findingLine(f, run.replayBase));
  lines.push("", `Run: ${runLink(links, run.runId)}`);
  return lines.join("\n");
}

const PHASE_LABEL: Record<RunPhase, string> = {
  analyzing: "analyzing real users",
  fixing: "fixing",
  "waiting-preview": "waiting for the deploy preview",
  retesting: "re-testing with persona agents",
  collecting: "waiting for PostHog ingestion",
  comparing: "comparing before and after",
  "awaiting-decision": "awaiting your decision",
  done: "done",
  failed: "failed",
};
const FINISHED: RunPhase[] = ["done", "failed"];
const SANDBOX_FINISHED = new Set(["done", "failed", "closed"]);

const lastAttempt = (run: RunDetail) => run.fix?.attempts.at(-1);

const verdictWord = (a?: FixAttempt) => (a?.verdict ? (a.verdict.improved ? "improved" : "not proven") : undefined);

/** One line per phase change (consecutive duplicates collapsed), with the fix attempt's milestones woven in,
 * then live re-test progress from the swarm topology. */
export function story(run: RunDetail, swarm?: SwarmTopology): string[] {
  const history = run.status.history?.length ? run.status.history : [{ phase: run.status.phase, at: run.status.updatedAt, message: run.status.message }];
  const entries = history.filter((h, i) => i === 0 || h.phase !== history[i - 1].phase || h.message !== history[i - 1].message);
  const live = !FINISHED.includes(run.status.phase) && run.status.phase !== "awaiting-decision";
  const attempt = lastAttempt(run);

  const entryLine = (h: (typeof entries)[number], i: number) => {
    const current = i === entries.length - 1;
    const mark = h.phase === "failed" ? "✗" : current && live ? "…" : "✓";
    if (h.phase === "awaiting-decision") {
      const v = verdictWord(attempt);
      return `${mark} ${v ? `verdict: ${v} — ` : ""}awaiting your decision`;
    }
    return `${mark} ${PHASE_LABEL[h.phase]}${h.message ? ` · ${h.message}` : ""}`;
  };

  // The attempt's milestones, each right after the last entry of the phase that produced it (else at the end).
  const milestones: { after?: RunPhase; line: string }[] = [];
  // A retry pushes onto attempt 1's branch, so its PR is the same one, updated.
  const retried = (attempt?.attempt ?? 1) > 1;
  if (attempt?.prNumber !== undefined)
    milestones.push({
      after: "fixing",
      line: isRehearsal(attempt)
        ? `✓ change committed${retried ? ` (attempt ${attempt.attempt})` : ""} (rehearsal — no PR opened)`
        : retried
          ? `✓ PR #${attempt.prNumber} updated (attempt ${attempt.attempt}, same PR)`
          : `✓ PR #${attempt.prNumber} opened (draft)`,
    });
  if (attempt?.previewUrl) milestones.push({ after: "waiting-preview", line: `✓ preview live (${sha7(attempt.commitSha)})` });
  if (attempt?.status === "failed") milestones.push({ line: `✗ fix failed${attempt.error ? `: ${attempt.error}` : ""}` });
  const anchorOf = (phase?: RunPhase) => (phase ? entries.findLastIndex((h) => h.phase === phase) : -1);

  const lines: string[] = [];
  entries.forEach((h, i) => {
    lines.push(entryLine(h, i));
    for (const m of milestones) if (anchorOf(m.after) === i) lines.push(m.line);
  });
  for (const m of milestones) if (anchorOf(m.after) === -1) lines.push(m.line);

  if (run.status.phase === "retesting" && swarm) {
    const total = swarm.sandboxes.reduce((t, s) => t + s.agentIds.length, 0);
    const done = swarm.sandboxes.reduce((t, s) => t + (SANDBOX_FINISHED.has(s.status) ? s.agentIds.length : 0), 0);
    if (total) lines.push(`… re-test ${done}/${total} agents done`);
  }
  return lines;
}

const changedFiles = (diff: string) => [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);

const comparisonRow = (c: PersonaComparison, targeted: boolean) =>
  `| ${c.segmentId} ↔ ${c.personaId}${targeted ? " (targeted)" : ""} | ${pct(c.before.completionRate)} → ${pct(c.after.completionRate)} | Δ ${signed(c.completionDeltaPts)} | N ${c.before.n} / ${c.after.n} | ${c.regressions.length ? c.regressions.join("; ") : "none"} |`;

function stepTable(c: PersonaComparison): string[] {
  const steps = [...new Set([...c.before.funnel.map((f) => f.step), ...c.after.funnel.map((f) => f.step)])];
  const reach = (funnel: { step: string; reached: number }[], n: number, step: string) => {
    const reached = funnel.find((f) => f.step === step)?.reached ?? 0;
    return `${pct(ratio(reached, n))} (${reached}/${n})`;
  };
  return [
    `**${c.personaId}** vs real \`${c.segmentId}\` users (reached each step)`,
    "| Step | Before (real users, reached/N) | After (agents, reached/N) |",
    "|---|---|---|",
    ...steps.map((s) => `| ${s} | ${reach(c.before.funnel, c.before.n, s)} | ${reach(c.after.funnel, c.after.n, s)} |`),
  ];
}

/** Everything the PO needs to accept or reject a fix, in the spec's seven sections. */
export function decisionPackage(run: RunDetail, diff: string | undefined, links: Links): string {
  const a = lastAttempt(run);
  if (!a) return `No fix attempt on run ${run.runId}.\n\nRun: ${runLink(links, run.runId)}`;
  const v = a.verdict;
  const rehearsal = isRehearsal(a);
  const targeted = new Set(v?.targetedPersonas ?? []);
  const out: string[] = [`## Decision for run \`${run.runId}\` · fix attempt ${a.attempt}${rehearsal ? " (rehearsal)" : ""}`];

  if (a.decision) {
    const d = a.decision;
    const what = d.decision === "accept" ? `Accepted${d.mergeSha ? `, merged as ${sha7(d.mergeSha)}` : ""}` : `Rejected${d.reason ? `: ${d.reason}` : ""}`;
    out.push("", `**Already decided** (${d.decidedAt}): ${what}${d.rehearsal ? " (rehearsal)" : ""}. Read-only.`);
  }

  out.push(
    "",
    "### 1. Verdict",
    v ? `**${v.improved ? "Improved" : "Not proven"}** (status: ${a.status})` : `No verdict (status: ${a.status})`,
    ...(v?.reasons ?? []).map((r) => `- ${r}`),
    "",
    `Measured: before = real users (PostHog segments, production build ${sha7(run.metrics?.buildSha ?? run.config.posthog.buildSha)}); ` +
      `after = constrained persona agents (preview build ${sha7(a.commitSha)}).`,
  );

  out.push("", "### 2. Completion, segment ↔ persona");
  if (v?.comparisons.length) {
    out.push("| Segment ↔ persona | Completion before → after | Δ | N before / after | Regressions |", "|---|---|---|---|---|");
    for (const c of v.comparisons) out.push(comparisonRow(c, targeted.has(c.personaId)));
  } else out.push("No comparisons.");

  out.push("", "### 3. Per-step conversion, targeted personas");
  const targetedComparisons = (v?.comparisons ?? []).filter((c) => targeted.has(c.personaId));
  if (targetedComparisons.length) out.push(...targetedComparisons.flatMap((c, i) => [...(i ? [""] : []), ...stepTable(c)]));
  else out.push("None.");

  out.push("", "### 4. Findings addressed");
  // Retries build on the same PR: attempt 1's findings (the analysis's) are what it fixes; a retry's
  // targets come from the previous re-test, whose ids are that run's, not the analysis's.
  const first = run.fix?.attempts[0] ?? a;
  for (const id of first.findingIds) {
    const f = run.findings?.find((x) => x.id === id);
    out.push(f ? findingLine(f, run.replayBase) : `- **${id}**`);
  }
  if (a.attempt > 1 && a.targets?.length) {
    out.push("", `Attempt ${a.attempt} also targeted what the swarm hit on the previous re-test:`);
    for (const t of a.targets) out.push(`- [${t.severity}] at ${t.step}: ${t.title}`);
  }

  out.push(
    "",
    "### 5. The change",
    a.summary ? `Coding agent${a.attempt > 1 ? ` (attempt ${a.attempt})` : ""}: ${a.summary}` : "No summary from the coding agent.",
    ...(a.attempt > 1 && !rehearsal ? [`The diff is the whole PR: attempts 1–${a.attempt} pushed onto the same branch.`] : []),
  );
  if (diff === undefined) out.push("", "Diff not available.");
  else if (diff.startsWith(DIFF_UNAVAILABLE)) out.push("", diff.split("\n")[0].slice(2).replace(/\.?$/, "."));
  else {
    const files = changedFiles(diff);
    const lines = diff.replace(/\n$/, "").split("\n");
    const fence = "`".repeat(Math.max(4, ...[...diff.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    out.push("", `Changed files (${files.length}): ${files.join(", ") || "none"}`, "", `${fence}diff`, ...lines.slice(0, MAX_DIFF_LINES), fence);
    if (lines.length > MAX_DIFF_LINES) out.push(`… ${lines.length - MAX_DIFF_LINES} more lines; files: ${files.join(", ")}`);
  }

  out.push("", "### 6. Links");
  if (!rehearsal && a.prUrl) out.push(`- PR: ${a.prUrl}`);
  if (a.previewUrl) out.push(`- Preview: ${a.previewUrl}`);
  out.push(`- Dashboard run: ${runLink(links, run.runId)}`);

  out.push("", "### 7. Your call", "Accept merges to production main; reject closes the PR.");
  if (rehearsal) out.push("This is a rehearsal: the decision is recorded only (rehearsal — no PR merged).");
  if (v && !v.improved && !a.decision) out.push("The fix is not proven: accepting needs an explicit override.");
  return out.join("\n");
}
