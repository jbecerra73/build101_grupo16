import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, PersonaMetrics, Verdict } from "../shared";
import { PERSONAS } from "../shared";

/** Runs the gh CLI and returns stdout. Injected so tests can record calls. */
export type Gh = (args: string[]) => Promise<string>;

export const gh: Gh = (args) =>
  new Promise((resolve, reject) =>
    execFile("gh", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr || err.message}`)) : resolve(stdout.trim()),
    ),
  );

export const EVIDENCE_BRANCH = "frictionswarm-evidence";
export const NOT_PROVEN_LABEL = "not-proven";

export type PrContext = {
  repo: string;
  prNumber: number;
  baselineRunId: string;
  retestRunId: string;
  baselineSha: string;
  retestSha: string;
  verdict: Verdict;
  /** The findings the fix targeted. */
  findings: Finding[];
  /** Hosted URL per run-folder screenshot path, from uploadEvidence. */
  screenshotUrls: Record<string, string>;
  /** Where the full report can be opened; omitted when there is none. */
  reportUrl?: string;
};

const pct = (m: PersonaMetrics) => `${Math.round(m.completionRate * 100)}%`;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const short = (sha: string) => sha.slice(0, 7);
const personaName = (id: string) => PERSONAS[id]?.name ?? id;

export function renderComparisonTable(verdict: Verdict): string {
  const rows = verdict.comparisons.map(({ personaId, before: b, after: a, completionDeltaPts, regressions }) => {
    const role = PERSONAS[personaId]?.control ? " (control)" : verdict.targetedPersonas.includes(personaId) ? " (targeted)" : "";
    const status = regressions.length ? `⚠️ ${regressions.join("; ")}` : "✓";
    return `| ${personaName(personaId)}${role} | ${pct(b)} (${b.completed}/${b.n}) | ${pct(a)} (${a.completed}/${a.n}) | ${signed(completionDeltaPts)} pts | ${b.gaveUp}/${b.n} → ${a.gaveUp}/${a.n} | ${b.medianSteps || "–"} → ${a.medianSteps || "–"} | ${status} |`;
  });
  return [
    "| Persona | Completion before | Completion after | Δ | Gave up | Median steps (completers) | Regressions |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const runsLine = (ctx: PrContext) =>
  `Baseline \`${ctx.baselineRunId}\` on production \`${short(ctx.baselineSha)}\` vs re-test \`${ctx.retestRunId}\` on this PR's preview \`${short(ctx.retestSha)}\`, same personas with fresh seeds. N is shown for every number; small samples, no significance claims.`;

const reportLine = (ctx: PrContext) => (ctx.reportUrl ? `\n\n[Full report](${ctx.reportUrl})` : "");

function renderFinding(f: Finding, urls: Record<string, string>): string {
  const shots = f.evidence.screenshots.filter((s) => urls[s]).slice(0, 2);
  return [
    `### ${f.title}`,
    `${f.severity} · ${f.personas.map(personaName).join(", ")} · step **${f.step}** (\`${f.page}\`) · ${f.evidence.agentCount} agent(s)`,
    ...f.evidence.quotes.slice(0, 2).map((q) => `> ${q}`),
    shots.length ? `Before:\n\n${shots.map((s) => `<img src="${urls[s]}" width="360">`).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderReadyBody(ctx: PrContext, agentSummary = ""): string {
  return `## ✅ FrictionSwarm: improvement proven

${ctx.verdict.reasons.map((r) => `- ${r}`).join("\n")}

${renderComparisonTable(ctx.verdict)}

${runsLine(ctx)}${reportLine(ctx)}

## Fixed findings

${ctx.findings.map((f) => renderFinding(f, ctx.screenshotUrls)).join("\n\n")}
${agentSummary ? `\n## What changed\n\n${agentSummary}\n` : ""}`;
}

export function renderNotProvenComment(ctx: PrContext): string {
  return `## ❌ FrictionSwarm: fix attempted, not proven

The re-test did not meet the bar (completion +≥20 pts for a targeted persona and no persona worse), so this PR is closed and labelled \`${NOT_PROVEN_LABEL}\`.

${ctx.verdict.reasons.map((r) => `- ${r}`).join("\n")}

${renderComparisonTable(ctx.verdict)}

${runsLine(ctx)}${reportLine(ctx)}`;
}

/** Publish the findings' before-screenshots on an evidence branch of the
 * storefront repo so the PR body can show them. Returns path → raw URL. */
export async function uploadEvidence(
  repo: string,
  runDir: string,
  runId: string,
  findings: Finding[],
  ghImpl: Gh = gh,
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const shots = [...new Set(findings.flatMap((f) => f.evidence.screenshots.slice(0, 2)))];
  if (shots.length === 0) return urls;

  const exists = await ghImpl(["api", `repos/${repo}/branches/${EVIDENCE_BRANCH}`, "--jq", ".name"]).catch(() => "");
  if (!exists) {
    const mainSha = await ghImpl(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
    await ghImpl(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${EVIDENCE_BRANCH}`, "-f", `sha=${mainSha}`]);
  }
  for (const shot of shots) {
    const path = `evidence/${runId}/${shot.split("/").at(-1)}`;
    const content = (await readFile(join(runDir, shot))).toString("base64");
    const existing = await ghImpl(["api", `repos/${repo}/contents/${path}?ref=${EVIDENCE_BRANCH}`, "--jq", ".sha"]).catch(() => "");
    await ghImpl([
      "api", "-X", "PUT", `repos/${repo}/contents/${path}`,
      "-f", `message=FrictionSwarm evidence for ${runId}`,
      "-f", `branch=${EVIDENCE_BRANCH}`,
      "-f", `content=${content}`,
      ...(existing ? ["-f", `sha=${existing}`] : []),
    ]);
    urls[shot] = `https://raw.githubusercontent.com/${repo}/${EVIDENCE_BRANCH}/${path}`;
  }
  return urls;
}

/** Improved → rewrite the body and mark ready for review. Otherwise comment
 * the metrics, label not-proven and close. */
export async function finalizePr(ctx: PrContext, agentSummary = "", ghImpl: Gh = gh): Promise<"ready" | "not-proven"> {
  const pr = String(ctx.prNumber);
  if (ctx.verdict.improved) {
    await ghImpl(["pr", "edit", pr, "--repo", ctx.repo, "--body", renderReadyBody(ctx, agentSummary)]);
    await ghImpl(["pr", "ready", pr, "--repo", ctx.repo]);
    return "ready";
  }
  await ghImpl(["pr", "comment", pr, "--repo", ctx.repo, "--body", renderNotProvenComment(ctx)]);
  await ghImpl([
    "label", "create", NOT_PROVEN_LABEL, "--repo", ctx.repo, "--force",
    "--color", "B60205", "--description", "FrictionSwarm could not prove this fix helps",
  ]);
  await ghImpl(["pr", "edit", pr, "--repo", ctx.repo, "--add-label", NOT_PROVEN_LABEL]);
  await ghImpl(["pr", "close", pr, "--repo", ctx.repo]);
  return "not-proven";
}
