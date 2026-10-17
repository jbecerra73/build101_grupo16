// REHEARSAL fix loop: the offline stand-in for P1's runFixLoop. Same fix.json
// transitions (running → draft → retesting → ready | not-proven), a real
// retest through the injected swarm runner, PostHog collection and analyzer,
// and the analyzer's own verdict (compareSegmentsToPersonas). No coding agent,
// no git, no PR: every PR field says "rehearsal".
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PERSONAS, type FixAttempt, type FixResult, type Finding, type Metrics, type RunConfig } from "@frictionswarm/shared";
import { rankFindings, retestConfig, type FixLoop } from "./fixLoop";
import { readJson, writeJson } from "./runs";
import { trapOf, type TrapId } from "./traps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const STOREFRONT_REPO = "FrissA/demo-ecommerce";
export const REHEARSAL_PREVIEW = "https://deploy-preview-rehearsal--swarm-ecommerce.netlify.app";

export type FakeFixOptions = {
  /** Delay of each simulated stage (coding agent, preview build), ms. */
  stageDelayMs?: number;
  maxFindings?: number;
  /** Fix the findings behind these traps (the demo fixes T1 + T2). Falls back
   * to the top findings when none of the findings maps to them. */
  traps?: TrapId[];
};

/** The findings the rehearsal "fixes". */
export function pickTargets(findings: Finding[], traps: TrapId[] | undefined, max: number): Finding[] {
  const ranked = rankFindings(findings);
  const byTrap = traps?.length ? ranked.filter((f) => traps.includes(trapOf(f)!)) : [];
  return (byTrap.length ? byTrap : ranked).slice(0, max);
}

export const fakeFixLoop =
  ({ stageDelayMs = 1500, maxFindings = 3, traps = ["T1", "T2"] }: FakeFixOptions = {}): FixLoop =>
  async ({ baselineRunId, runsDir, log, retestSeeds, runSwarm, collect, analyze, compare }) => {
    const baseDir = join(runsDir, baselineRunId);
    const config = (await readJson<RunConfig>(join(baseDir, "config.json")))!;
    const analysis = (await readJson<Metrics>(join(baseDir, "metrics.json")))!;
    const targets = pickTargets((await readJson<Finding[]>(join(baseDir, "findings.json"))) ?? [], traps, maxFindings);
    const result: FixResult = { baselineRunId, repo: `${STOREFRONT_REPO} (rehearsal)`, attempts: [] };
    if (!targets.length) return result;
    const attempt: FixAttempt = { attempt: 1, findingIds: targets.map((f) => f.id), status: "running" };
    result.attempts.push(attempt);
    const save = () => writeJson(join(baseDir, "fix.json"), result);

    try {
      await save();
      log(`[rehearsal] coding agent fixing ${attempt.findingIds.join(", ")}`);
      await sleep(stageDelayMs);
      // Hex like a real sha (the UI shows 7 chars); branch, summary and prNumber 0 mark the rehearsal.
      const commitSha = randomBytes(20).toString("hex");
      Object.assign(attempt, {
        branch: `frictionswarm/rehearsal-${baselineRunId}`,
        commitSha,
        prNumber: 0,
        prUrl: "about:blank#rehearsal-no-pr-opened",
        previewUrl: REHEARSAL_PREVIEW,
        summary: `[rehearsal, no PR opened] Would fix: ${targets.map((f) => f.title).join("; ")}`,
        status: "draft",
      } satisfies Partial<FixAttempt>);
      await save();
      log("[rehearsal] waiting for the preview (simulated)");
      await sleep(stageDelayMs);

      const retest = retestConfig(config, { attempt: 1, commitSha, previewUrl: REHEARSAL_PREVIEW, seeds: retestSeeds });
      await writeJson(join(runsDir, retest.runId, "config.json"), retest);
      Object.assign(attempt, { retestRunId: retest.runId, status: "retesting" });
      await save();
      await runSwarm(retest);
      await collect(retest);
      const after = await analyze(retest.runId);

      const targeted = [...new Set(targets.flatMap((f) => f.personas))].filter((p) => !PERSONAS[p]?.control);
      attempt.verdict = compare(analysis, after.metrics, targeted);
      attempt.status = attempt.verdict.improved ? "ready" : "not-proven";
      log(`[rehearsal] verdict: ${attempt.status}\n  ${attempt.verdict.reasons.join("\n  ")}`);
      await save();
      return result;
    } catch (e) {
      attempt.status = "failed";
      attempt.error = e instanceof Error ? e.message : String(e);
      await save();
      throw e;
    }
  };
