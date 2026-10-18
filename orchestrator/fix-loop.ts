import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApplyDecision } from "@frictionswarm/pipeline";
import {
  flowOf,
  PERSONAS,
  previewUrl,
  flowPersonas,
  PRODUCTION_URL,
  type FixAttempt,
  type FixResult,
  type Finding,
  type Flow,
  type Verdict,
  type Metrics,
  type RunConfig,
  unavailableDiff,
} from "../shared";
import { runCodingAgent, STOREFRONT_REPO, type CodingAgentInput } from "./coding-agent";
import { topFindings } from "./fix-prompt";
import { closePr, finalizePr, gh, mergePr, prDiff, renderRetryComment, uploadEvidence, type Gh, type PrContext } from "./pr";
import { waitForBuildSha } from "./preview";
import { tenkiShell, type Shell } from "./shell";
import { compareRuns } from "./verdict";

export const RUNS_DIR = join(import.meta.dirname, "..", "runs");

export const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + "\n");

/** Runs the retest swarm on the preview and resolves once every agent's tracks are in PostHog
 * (PostHogSource.waitForSwarm) (P2). */
export type SwarmRunner = (config: RunConfig) => Promise<void>;
/** Reads a run's PostHog events and writes metrics.json + findings.json (P3). */
export type Analyzer = (runId: string) => Promise<{ metrics: Metrics; findings: Finding[] }>;

/** Production must serve main's HEAD before an analysis, or findings can't name the build. */
export async function verifyProductionBuild(repo = STOREFRONT_REPO, ghImpl: Gh = gh): Promise<string> {
  const mainSha = await ghImpl(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
  await waitForBuildSha(PRODUCTION_URL, mainSha, { timeoutMs: 5 * 60_000 });
  return mainSha;
}

/** Re-test seeds: a fresh block of 1000 per attempt (1001–1010, then 2001–2010), so no seed
 * repeats across attempts. */
export function retestSeeds(personaIds: string[], perPersona: number, attempt: number): Record<string, number[]> {
  const seeds = Array.from({ length: perPersona }, (_, i) => attempt * 1000 + i + 1);
  return Object.fromEntries(personaIds.map((p) => [p, seeds]));
}

// Compatible with packages/pipeline's FixLoopOptions, so the pipeline loads runFixLoop as its real
// fix loop (FIX_LOOP=real); the extra fields are optional and default for that path.
export type FixLoopOptions = {
  baselineRunId: string;
  runSwarm: SwarmRunner;
  /** Waits until the swarm's events are in PostHog (waitForSwarm), when runSwarm doesn't. */
  collect?: (config: RunConfig) => Promise<void>;
  analyze: Analyzer;
  /** Segments vs personas; defaults to the analyzer's compareSegmentsToPersonas. */
  compare?: (analysis: Metrics, retest: Metrics, targetedPersonas: string[], flow?: Flow) => Verdict;
  /** Attempt 1's seeds per persona (the pipeline allocates fresh ones); each retry shifts them by
   * a block of 1000. Default: retestSeeds over every segment's persona. */
  retestSeeds?: Record<string, number[]>;
  /** A fresh shell per attempt (tenkiShell or localShell). Default: a tenki sandbox. */
  shell?: (attempt: number) => Promise<Shell>;
  /** Findings handed to the coding agent per attempt (SPEC: top 1–3). */
  maxFindings?: number;
  /** The findings the Product Owner chose: attempt 1 fixes exactly these, in order, without
   * re-ranking (unknown ids throw). A retry still takes the re-test's top findings. */
  findingIds?: string[];
  /** Attempts before giving up: each retry builds on the same PR with the re-test's findings. Default 1. */
  maxAttempts?: number;
  /** Agents per persona on the re-test (SPEC: 10). */
  seedsPerPersona?: number;
  repo?: string;
  runsDir?: string;
  reportUrl?: (runId: string) => string | undefined;
  log?: (line: string) => void;
  ghImpl?: Gh;
  codingAgent?: typeof runCodingAgent;
  waitForBuild?: typeof waitForBuildSha;
};

/** The findings with these ids, in this order. Throws on an unknown id. */
function chosenFindings(findings: Finding[], ids: string[]): Finding[] {
  return ids.map((id) => {
    const f = findings.find((x) => x.id === id);
    if (!f) throw new Error(`Unknown finding "${id}"`);
    return f;
  });
}

/** Analysis findings → coding agent → draft PR (diff saved to fix/pr.diff) → preview → re-test →
 * verdict → PR ready or labelled not-proven, left open for the Product Owner's decision.
 * Not proven with attempts left: the PR stays open, and the next attempt pushes onto the same branch,
 * told what the previous change was, how the swarm did and what it struggled with (the re-test's
 * findings, linked to the targets they show unresolved); fix/pr.diff is re-fetched after each push.
 * Progress is written to runs/<baseline>/fix.json after every stage for the dashboard. */
export async function runFixLoop(opts: FixLoopOptions): Promise<FixResult> {
  const { baselineRunId, maxFindings = 3, maxAttempts = 1, seedsPerPersona = 10, repo = STOREFRONT_REPO, runsDir = RUNS_DIR } = opts;
  const log = opts.log ?? console.log;
  const ghImpl = opts.ghImpl ?? gh;
  const codingAgent = opts.codingAgent ?? runCodingAgent;
  const waitForBuild = opts.waitForBuild ?? waitForBuildSha;
  const compare = opts.compare ?? ((a, r, t, f) => compareRuns(a, r, t, { flow: f }));
  const openShell = opts.shell ?? ((n: number) => tenkiShell(`fix-${baselineRunId}-${n}`));
  const baseDir = join(runsDir, baselineRunId);
  const config = await readJson<RunConfig>(join(baseDir, "config.json"));
  const baseline = await readJson<Metrics>(join(baseDir, "metrics.json"));
  const flow = flowOf(config);
  if (!flow) throw new Error(`unknown flow ${config.flowId}`);
  // The flow's personas re-test (by default every segment's, control included, so a fix can't
  // quietly hurt the others).
  const seedsFor = (n: number) =>
    opts.retestSeeds
      ? Object.fromEntries(Object.entries(opts.retestSeeds).map(([p, seeds]) => [p, seeds.map((x) => x + (n - 1) * 1000)]))
      : retestSeeds(flowPersonas(flow), seedsPerPersona, n);

  const result: FixResult = { baselineRunId, repo, attempts: [] };
  const save = () => writeJson(join(baseDir, "fix.json"), result);
  const findings = await readJson<Finding[]>(join(baseDir, "findings.json"));
  /** The Product Owner's chosen findings, else the top ones. Retries take the re-test's instead. */
  let targets = opts.findingIds ? chosenFindings(findings, opts.findingIds) : topFindings(findings, maxFindings);
  /** Attempt 1's targets: the real users' problems, which the PR reports on whatever the attempt. */
  const original = targets;
  let retry: CodingAgentInput["retry"];
  /** The last verdict's PR context, to label the PR not-proven with if a retry fails. */
  let lastCtx: PrContext | undefined;

  for (let n = 1; n <= maxAttempts; n++) {
    if (targets.length === 0) {
      log("no findings left to fix");
      break;
    }
    const attempt: FixAttempt = { attempt: n, findingIds: targets.map((f) => f.id), targets, status: "running" };
    result.attempts.push(attempt);
    await save();

    try {
      const shell = await openShell(n);
      let agent;
      try {
        agent = await codingAgent(shell, { runId: baselineRunId, attempt: n, flow, findings: targets, repo, log, ...(retry && { retry }) });
      } finally {
        await shell.close();
      }
      Object.assign(attempt, {
        branch: agent.branch,
        commitSha: agent.commitSha,
        prNumber: agent.prNumber,
        prUrl: agent.prUrl,
        summary: agent.summary,
        previewUrl: previewUrl(agent.prNumber),
        status: "draft",
      });
      await save();
      // Saved for the dashboard and the PO's decision; the deployed dashboard has no GitHub access.
      // On failure a placeholder replaces it, so a retry never shows the previous attempt's diff.
      const diffFile = join(baseDir, "fix", "pr.diff");
      await mkdir(join(baseDir, "fix"), { recursive: true });
      await prDiff(repo, agent.prNumber, ghImpl)
        .then((diff) => writeFile(diffFile, diff + "\n"))
        .catch(async (e) => {
          const reason = e instanceof Error ? e.message : String(e);
          log(`could not save the PR diff: ${reason}`);
          await writeFile(diffFile, unavailableDiff(agent.prNumber, reason)).catch(() => {});
        });

      log(`waiting for ${attempt.previewUrl} to serve ${agent.commitSha.slice(0, 7)}`);
      await waitForBuild(attempt.previewUrl!, agent.commitSha, {
        onPoll: (seen) => log(`  preview serves ${seen?.slice(0, 7) ?? "nothing yet"}`),
      });

      const retestRunId = `${baselineRunId}-retest${n}`;
      const seeds = seedsFor(n);
      const personaIds = Object.keys(seeds);
      const retestConfig: RunConfig = {
        runId: retestRunId,
        kind: "retest",
        flowId: flow.id,
        flow: config.flow,
        ...(config.goal ? { goal: config.goal } : {}),
        posthog: { source: config.posthog.source, buildSha: agent.commitSha },
        personaIds,
        seeds,
        targetUrl: attempt.previewUrl!,
        baselineRunId,
        fix: {
          attempt: n,
          targets: targets.map(({ id, title, step, page, selector, suggestedFix }) => ({ id, title, step, page, ...(selector ? { selector } : {}), suggestedFix })),
          ...(agent.summary ? { summary: agent.summary } : {}),
        },
        createdAt: new Date().toISOString(),
      };
      await mkdir(join(runsDir, retestRunId), { recursive: true });
      await writeJson(join(runsDir, retestRunId, "config.json"), retestConfig);
      Object.assign(attempt, { retestRunId, status: "retesting" });
      await save();

      log(`re-testing ${personaIds.join(", ")} on the preview (run ${retestRunId})`);
      await opts.runSwarm(retestConfig);
      await opts.collect?.(retestConfig);
      const retest = await opts.analyze(retestRunId);

      // The real users' problems stay the goal; a retry also targets whoever the swarm still saw struggle.
      const targeted = [...new Set([...original, ...targets].flatMap((f) => f.personas))].filter((p) => !PERSONAS[p]?.control);
      const verdict = compare(baseline, retest.metrics, targeted, flow);
      attempt.verdict = verdict;
      log(`verdict: ${verdict.improved ? "improved" : "not proven"}\n  ${verdict.reasons.join("\n  ")}`);

      const ctx: PrContext = {
        repo,
        prNumber: agent.prNumber,
        baselineRunId,
        retestRunId,
        baselineSha: baseline.buildSha,
        retestSha: agent.commitSha,
        verdict,
        findings: original,
        screenshotUrls: {},
        reportUrl: opts.reportUrl?.(baselineRunId),
        attempt: n,
      };
      const next = topFindings(retest.findings, maxFindings);
      if (!verdict.improved && n < maxAttempts) {
        // No friction the analyzer could name: the same targets again, with the verdict as the feedback.
        const nextTargets = next.length ? next : targets;
        await ghImpl(["pr", "comment", String(agent.prNumber), "--repo", repo, "--body", renderRetryComment(ctx, next)]);
        lastCtx = ctx;
        attempt.status = "not-proven";
        await save();
        const persisting = next.filter((f) => f.persistsFrom).length;
        log(`retrying on PR #${agent.prNumber} with ${nextTargets.length} finding(s) from the re-test (${persisting} still unresolved from this attempt)`);
        retry = {
          attempt: n + 1,
          original,
          previousTargets: targets,
          previousSummary: agent.summary,
          previousVerdict: verdict,
          branch: agent.branch,
          prNumber: agent.prNumber,
          prUrl: agent.prUrl,
        };
        targets = nextTargets;
        continue;
      }

      ctx.screenshotUrls = await uploadEvidence(repo, baseDir, baselineRunId, original, ghImpl).catch((e) => {
        log(`could not upload evidence screenshots: ${e.message}`);
        return {};
      });
      attempt.status = await finalizePr(ctx, agent.summary, ghImpl);
      await save();
      break;
    } catch (e) {
      attempt.status = "failed";
      attempt.error = e instanceof Error ? e.message : String(e);
      await save();
      // A failed retry: report the last verdict we have on the PR (labelled not-proven, left open).
      if (lastCtx) await finalizePr(lastCtx, retry?.previousSummary, ghImpl).catch((err) => log(`could not label PR #${lastCtx!.prNumber}: ${err.message}`));
      throw e;
    }
  }
  return result;
}

/** The Product Owner's decision on the last attempt's PR: accept → squash-merge (records the merge
 * sha), reject → comment the reason and close. Updates fix.json. Plugs into the pipeline as its
 * real ApplyDecision; ghImpl is for tests. */
export const applyDecision = async ({
  runsDir,
  runId,
  request,
  log,
  ghImpl = gh,
}: Parameters<ApplyDecision>[0] & { ghImpl?: Gh }): ReturnType<ApplyDecision> => {
  const file = join(runsDir, runId, "fix.json");
  const result = await readJson<FixResult>(file);
  const attempt = result.attempts.at(-1);
  if (!attempt?.prNumber) throw new Error("No PR to decide on");
  const { decision, reason, override } = request;
  const recorded = { decision, ...(reason ? { reason } : {}), ...(override ? { override: true } : {}) };
  if (decision === "accept") {
    const mergeSha = await mergePr(result.repo, attempt.prNumber, ghImpl);
    Object.assign(attempt, { status: "merged", decision: { ...recorded, decidedAt: new Date().toISOString(), mergeSha } } satisfies Partial<FixAttempt>);
    log(`merged PR #${attempt.prNumber} into main (${mergeSha.slice(0, 7)})`);
  } else {
    await closePr(result.repo, attempt.prNumber, reason, ghImpl);
    Object.assign(attempt, { status: "rejected", decision: { ...recorded, decidedAt: new Date().toISOString() } } satisfies Partial<FixAttempt>);
    log(`closed PR #${attempt.prNumber}${reason ? `: ${reason}` : ""}`);
  }
  await writeJson(file, result);
  return attempt;
};
