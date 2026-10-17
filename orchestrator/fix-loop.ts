import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLOWS,
  PERSONAS,
  previewUrl,
  SEGMENTS,
  PRODUCTION_URL,
  type FixAttempt,
  type FixResult,
  type Finding,
  type Metrics,
  type RunConfig,
} from "../shared";
import { runCodingAgent, STOREFRONT_REPO } from "./coding-agent";
import { topFindings } from "./fix-prompt";
import { finalizePr, gh, uploadEvidence, type Gh } from "./pr";
import { waitForBuildSha } from "./preview";
import type { Shell } from "./shell";
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

export type FixLoopOptions = {
  baselineRunId: string;
  runSwarm: SwarmRunner;
  analyze: Analyzer;
  /** A fresh shell per attempt (tenkiShell or localShell). */
  shell: () => Promise<Shell>;
  /** Findings handed to the coding agent per attempt (SPEC: top 1–3). */
  maxFindings?: number;
  /** 1 normally; 2 retries once with the re-test's findings (stretch). */
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

/** Analysis findings → coding agent → draft PR → preview → re-test → verdict → PR ready or closed.
 * Progress is written to runs/<baseline>/fix.json after every stage for the dashboard. */
export async function runFixLoop(opts: FixLoopOptions): Promise<FixResult> {
  const { baselineRunId, maxFindings = 3, maxAttempts = 1, seedsPerPersona = 10, repo = STOREFRONT_REPO, runsDir = RUNS_DIR } = opts;
  const log = opts.log ?? console.log;
  const ghImpl = opts.ghImpl ?? gh;
  const codingAgent = opts.codingAgent ?? runCodingAgent;
  const waitForBuild = opts.waitForBuild ?? waitForBuildSha;
  const baseDir = join(runsDir, baselineRunId);
  const config = await readJson<RunConfig>(join(baseDir, "config.json"));
  const baseline = await readJson<Metrics>(join(baseDir, "metrics.json"));
  const flow = FLOWS[config.flowId];
  if (!flow) throw new Error(`unknown flow ${config.flowId}`);
  // Every segment's persona re-tests, control included, so a fix can't quietly hurt the others.
  const personaIds = SEGMENTS.map((s) => s.personaId);

  const result: FixResult = { baselineRunId, repo, attempts: [] };
  const save = () => writeJson(join(baseDir, "fix.json"), result);
  let findings = await readJson<Finding[]>(join(baseDir, "findings.json"));

  for (let n = 1; n <= maxAttempts; n++) {
    const targets = topFindings(findings, maxFindings);
    if (targets.length === 0) {
      log("no findings left to fix");
      break;
    }
    const attempt: FixAttempt = { attempt: n, findingIds: targets.map((f) => f.id), status: "running" };
    result.attempts.push(attempt);
    await save();

    try {
      const shell = await opts.shell();
      let agent;
      try {
        agent = await codingAgent(shell, { runId: baselineRunId, attempt: n, flow, findings: targets, repo, log });
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

      log(`waiting for ${attempt.previewUrl} to serve ${agent.commitSha.slice(0, 7)}`);
      await waitForBuild(attempt.previewUrl!, agent.commitSha, {
        onPoll: (seen) => log(`  preview serves ${seen?.slice(0, 7) ?? "nothing yet"}`),
      });

      const retestRunId = `${baselineRunId}-retest${n}`;
      const retestConfig: RunConfig = {
        runId: retestRunId,
        kind: "retest",
        flowId: flow.id,
        posthog: { source: config.posthog.source, buildSha: agent.commitSha },
        personaIds,
        seeds: retestSeeds(personaIds, seedsPerPersona, n),
        targetUrl: attempt.previewUrl!,
        baselineRunId,
        createdAt: new Date().toISOString(),
      };
      await mkdir(join(runsDir, retestRunId), { recursive: true });
      await writeJson(join(runsDir, retestRunId, "config.json"), retestConfig);
      Object.assign(attempt, { retestRunId, status: "retesting" });
      await save();

      log(`re-testing ${personaIds.join(", ")} on the preview (run ${retestRunId})`);
      await opts.runSwarm(retestConfig);
      const retest = await opts.analyze(retestRunId);

      const targeted = [...new Set(targets.flatMap((f) => f.personas))].filter((p) => !PERSONAS[p]?.control);
      const verdict = compareRuns(baseline, retest.metrics, targeted);
      attempt.verdict = verdict;
      log(`verdict: ${verdict.improved ? "improved" : "not proven"}\n  ${verdict.reasons.join("\n  ")}`);

      const lastChance = verdict.improved || n === maxAttempts;
      const screenshotUrls = await uploadEvidence(repo, baseDir, baselineRunId, targets, ghImpl).catch((e) => {
        log(`could not upload evidence screenshots: ${e.message}`);
        return {};
      });
      attempt.status = await finalizePr(
        {
          repo,
          prNumber: agent.prNumber,
          baselineRunId,
          retestRunId,
          baselineSha: baseline.buildSha,
          retestSha: agent.commitSha,
          verdict,
          findings: targets,
          screenshotUrls,
          reportUrl: opts.reportUrl?.(baselineRunId),
        },
        agent.summary,
        ghImpl,
      );
      await save();
      if (lastChance) break;
      log("retrying once with the re-test's findings");
      findings = retest.findings;
    } catch (e) {
      attempt.status = "failed";
      attempt.error = e instanceof Error ? e.message : String(e);
      await save();
      throw e;
    }
  }
  return result;
}
