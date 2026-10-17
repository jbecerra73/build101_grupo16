// P1 commands that work before the swarm and analyzer are wired in:
//
//   tsx orchestrator/cli.ts open-pr <analysisRunId> [--local] [--findings 2]
//       coding agent → draft PR; writes runs/<id>/fix.json
//   tsx orchestrator/cli.ts wait-preview <prNumber> <sha>
//   tsx orchestrator/cli.ts verdict <analysisRunId> <retestRunId> --pr <n> [--dry-run]
//       compare segments (analysis) to personas (retest) and mark the PR ready or close it not-proven
//   tsx orchestrator/cli.ts check-prod
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { flowOf, PERSONAS, previewUrl, type FixResult, type Finding, type Metrics, type RunConfig } from "../shared";
import { runCodingAgent, STOREFRONT_REPO } from "./coding-agent";
import { readJson, RUNS_DIR, verifyProductionBuild } from "./fix-loop";
import { topFindings } from "./fix-prompt";
import { finalizePr, renderNotProvenComment, renderReadyBody, uploadEvidence } from "./pr";
import { waitForBuildSha } from "./preview";
import { localShell, tenkiShell } from "./shell";
import { compareRuns } from "./verdict";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    local: { type: "boolean", default: false },
    findings: { type: "string", default: "3" },
    pr: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const [command, ...args] = positionals;
const log = (line: string) => console.log(line);

async function openPr(baselineRunId: string) {
  const dir = join(RUNS_DIR, baselineRunId);
  const config = await readJson<RunConfig>(join(dir, "config.json"));
  const findings = topFindings(await readJson<Finding[]>(join(dir, "findings.json")), Number(values.findings));
  const flow = flowOf(config);
  if (!flow) throw new Error(`unknown flow ${config.flowId}`);
  const shell = values.local ? localShell(await mkdtemp(join(tmpdir(), "frictionswarm-fix-"))) : await tenkiShell(`fix-${baselineRunId}`);
  log(`shell: ${values.local ? `local ${shell.home}` : "tenki sandbox"}`);
  try {
    const agent = await runCodingAgent(shell, { runId: baselineRunId, attempt: 1, flow, findings, log });
    const fix: FixResult = {
      baselineRunId,
      repo: STOREFRONT_REPO,
      attempts: [{ attempt: 1, findingIds: findings.map((f) => f.id), ...agent, previewUrl: previewUrl(agent.prNumber), status: "draft" }],
    };
    await writeFile(join(dir, "fix.json"), JSON.stringify(fix, null, 2) + "\n");
    log(`draft PR: ${agent.prUrl}\ncommit: ${agent.commitSha}\npreview: ${previewUrl(agent.prNumber)}`);
  } finally {
    await shell.close();
  }
}

async function verdict(baselineRunId: string, retestRunId: string) {
  const prNumber = Number(values.pr);
  if (!prNumber) throw new Error("--pr <number> is required");
  const baseDir = join(RUNS_DIR, baselineRunId);
  const baseConfig = await readJson<RunConfig>(join(baseDir, "config.json"));
  const retestConfig = await readJson<RunConfig>(join(RUNS_DIR, retestRunId, "config.json"));
  const before = await readJson<Metrics>(join(baseDir, "metrics.json"));
  const after = await readJson<Metrics>(join(RUNS_DIR, retestRunId, "metrics.json"));
  const fix = await readJson<FixResult>(join(baseDir, "fix.json")).catch(() => undefined);
  const allFindings = await readJson<Finding[]>(join(baseDir, "findings.json"));
  const ids = fix?.attempts.at(-1)?.findingIds;
  const findings = ids ? allFindings.filter((f) => ids.includes(f.id)) : topFindings(allFindings, Number(values.findings));
  const targeted = [...new Set(findings.flatMap((f) => f.personas))].filter((p) => !PERSONAS[p]?.control);

  const v = compareRuns(before, after, targeted);
  const ctx = {
    repo: STOREFRONT_REPO, prNumber, baselineRunId, retestRunId,
    baselineSha: before.buildSha, retestSha: after.buildSha,
    verdict: v, findings, screenshotUrls: {} as Record<string, string>,
  };
  if (values["dry-run"]) {
    log(v.improved ? renderReadyBody(ctx) : renderNotProvenComment(ctx));
    return;
  }
  ctx.screenshotUrls = await uploadEvidence(STOREFRONT_REPO, baseDir, baselineRunId, findings);
  const status = await finalizePr(ctx, fix?.attempts.at(-1)?.summary ?? "");
  if (fix?.attempts.length) {
    Object.assign(fix.attempts.at(-1)!, { retestRunId, verdict: v, status });
    await writeFile(join(baseDir, "fix.json"), JSON.stringify(fix, null, 2) + "\n");
  }
  log(`PR #${prNumber}: ${status}\n  ${v.reasons.join("\n  ")}`);
}

const commands: Record<string, () => Promise<unknown>> = {
  "open-pr": () => openPr(args[0]),
  "wait-preview": () =>
    waitForBuildSha(previewUrl(Number(args[0])), args[1], { onPoll: (s) => log(`preview serves ${s ?? "nothing yet"}`) }),
  verdict: () => verdict(args[0], args[1]),
  "check-prod": async () => log(`production serves main @ ${await verifyProductionBuild()}`),
};

const fn = commands[command];
if (!fn) {
  console.error(`usage: cli.ts ${Object.keys(commands).join(" | ")} …`);
  process.exit(1);
}
await fn();
