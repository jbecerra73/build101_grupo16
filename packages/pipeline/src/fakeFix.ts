import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PERSONAS, type FixAttempt, type FixResult, type Finding, type Metrics, type RunConfig } from "@frictionswarm/shared";
import { STOREFRONT_REPO } from "../../../orchestrator/coding-agent";
import { freshSeeds } from "../../../orchestrator/fix-loop";
import { topFindings } from "../../../orchestrator/fix-prompt";
import { compareRuns } from "../../../orchestrator/verdict";
import type { FixLoop } from "./pipeline";
import { readJson, writeJson } from "./runs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Offline rehearsal of P1's runFixLoop: same fix.json transitions
 * (running → draft → retesting → ready | not-proven) and a real retest +
 * verdict via the injected runSwarm/analyze and P1's compareRuns, but no
 * coding agent, no gh and no PR. PR fields are marked as rehearsal. */
export const fakeFixLoop =
  ({ stageDelayMs = 1500, maxFindings = 3 } = {}): FixLoop =>
  async ({ baselineRunId, runSwarm, analyze, runsDir, log = () => {} }) => {
    const baseDir = join(runsDir!, baselineRunId);
    const config = (await readJson<RunConfig>(join(baseDir, "config.json")))!;
    const baseline = (await readJson<Metrics>(join(baseDir, "metrics.json")))!;
    const targets = topFindings((await readJson<Finding[]>(join(baseDir, "findings.json"))) ?? [], maxFindings);
    const result: FixResult = { baselineRunId, repo: `${STOREFRONT_REPO} (rehearsal)`, attempts: [] };
    if (!targets.length) return result;
    const attempt: FixAttempt = { attempt: 1, findingIds: targets.map((f) => f.id), status: "running" };
    result.attempts.push(attempt);
    const save = () => writeJson(join(baseDir, "fix.json"), result);

    try {
      await save();
      log(`[rehearsal] coding agent fixing ${attempt.findingIds.join(", ")}`);
      await sleep(stageDelayMs);
      // Hex like a real sha: the UI shows its first 7 chars ("rehears" otherwise).
      // The branch, summary and prNumber 0 mark the attempt as a rehearsal.
      const commitSha = randomBytes(20).toString("hex");
      Object.assign(attempt, {
        branch: `frictionswarm/rehearsal-${baselineRunId}`,
        commitSha,
        prNumber: 0,
        prUrl: "about:blank#rehearsal-no-pr-opened",
        previewUrl: config.targetUrl,
        summary: `[rehearsal, no PR opened] Would fix: ${targets.map((f) => f.title).join("; ")}`,
        status: "draft",
      });
      await save();
      log("[rehearsal] waiting for preview (simulated)");
      await sleep(stageDelayMs);

      const retestRunId = `${baselineRunId}-retest1`;
      const retestConfig: RunConfig = {
        runId: retestRunId,
        kind: "retest",
        flowId: config.flowId,
        personaIds: config.personaIds,
        seeds: freshSeeds(config.seeds, 1),
        targetUrl: config.targetUrl,
        buildSha: commitSha,
        baselineRunId,
        createdAt: new Date().toISOString(),
      };
      await mkdir(join(runsDir!, retestRunId), { recursive: true });
      await writeJson(join(runsDir!, retestRunId, "config.json"), retestConfig);
      Object.assign(attempt, { retestRunId, status: "retesting" });
      await save();
      await runSwarm(retestConfig);
      const retest = await analyze(retestRunId);

      const targeted = [...new Set(targets.flatMap((f) => f.personas))].filter((p) => !PERSONAS[p]?.control);
      attempt.verdict = compareRuns(baseline, retest.metrics, targeted);
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
