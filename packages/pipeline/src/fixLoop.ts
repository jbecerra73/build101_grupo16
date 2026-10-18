// The fix loop seam. The pipeline hands a FixLoop the analysis run and three
// callbacks that move its phases (retesting → collecting → comparing). Two
// implementations:
//   - fakeFixLoop (./fakeFix.ts): offline rehearsal, no coding agent and no PR
//   - P1's runFixLoop (orchestrator/fix-loop.ts, PR #22): loaded by realFixLoop
//     below through a guarded dynamic import, so this package builds without it.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Finding, FixResult, Metrics, PersonaId, RunConfig, Severity, Verdict } from "@frictionswarm/shared";
import { REPO_ROOT } from "./runs";
import type { SwarmRunner } from "./swarm";

/** Analyzes runs/<runId>/ (writes metrics.json, findings.json, posthog.jsonl). */
export type Analyzer = (runId: string) => Promise<{ metrics: Metrics; findings: Finding[] }>;

/** The analyzer's compareSegmentsToPersonas: analysis (segments) vs retest (personas). */
export type Compare = (analysis: Metrics, retest: Metrics, targetedPersonas: PersonaId[]) => Verdict;

export type FixLoopOptions = {
  /** The analysis run whose findings get fixed (fix.json is written there). */
  baselineRunId: string;
  runsDir: string;
  log: (line: string) => void;
  /** Fresh, never-used seeds per persona for the retest swarm. */
  retestSeeds: Record<PersonaId, number[]>;
  /** Swarm on the preview. The pipeline moves to "retesting". */
  runSwarm: SwarmRunner;
  /** Waits until the swarm's events are in PostHog. The pipeline moves to "collecting". */
  collect: (config: RunConfig) => Promise<void>;
  /** Analyzes the retest's tracks. The pipeline moves to "comparing". */
  analyze: Analyzer;
  compare: Compare;
  /** Fix attempts per loop: each retry builds on the same PR with the re-test's findings (#16). */
  maxAttempts?: number;
};

/** Fixes the top findings, re-tests the preview and records everything in
 * runs/<baselineRunId>/fix.json (running → draft → retesting → ready | not-proven). */
export type FixLoop = (o: FixLoopOptions) => Promise<FixResult>;

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Findings by severity, then by affected sessions. */
export const rankFindings = (findings: Finding[]) =>
  findings.toSorted((a, b) => RANK[a.severity] - RANK[b.severity] || b.evidence.sessions - a.evidence.sessions);

/** The retest's config for a fix attempt. agentId = `${personaId}-${seed}`. */
export function retestConfig(analysis: RunConfig, o: { attempt: number; commitSha: string; previewUrl: string; seeds: Record<PersonaId, number[]> }): RunConfig {
  const personaIds = Object.keys(o.seeds).filter((p) => o.seeds[p]?.length);
  return {
    runId: `${analysis.runId}-retest${o.attempt}`,
    kind: "retest",
    flowId: analysis.flowId,
    ...(analysis.goal ? { goal: analysis.goal } : {}),
    posthog: { source: analysis.posthog.source, buildSha: o.commitSha },
    personaIds,
    seeds: o.seeds,
    targetUrl: o.previewUrl,
    baselineRunId: analysis.runId,
    createdAt: new Date().toISOString(),
  };
}

/** What P1's module must export (orchestrator/fix-loop.ts, or FIX_LOOP_MODULE). */
type P1Module = { runFixLoop?: FixLoop };

/** P1's real fix loop (coding agent in a tenki sandbox, draft PR, preview
 * polling, PR finalization), imported at call time from FIX_LOOP_MODULE or
 * <repo>/orchestrator/fix-loop.ts. The specifier is computed so neither tsc nor
 * the Next bundler needs the file; when it is missing the run fails with
 * "P1 fix loop not available". maxAttempts defaults to 3: up to two retries on
 * the same PR while the fix isn't proven (#16). */
export function realFixLoop(
  modulePath = process.env.FIX_LOOP_MODULE ?? join(REPO_ROOT, "orchestrator", "fix-loop.ts"),
  { maxAttempts = 3 }: { maxAttempts?: number } = {},
): FixLoop {
  return async (o) => {
    let mod: P1Module;
    try {
      const specifier = pathToFileURL(modulePath).href;
      mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)) as P1Module;
    } catch (e) {
      throw new Error(
        `P1 fix loop not available: could not load ${modulePath} (${e instanceof Error ? e.message : String(e)}). ` +
          "Use FIX_LOOP=fake for the offline rehearsal, or run the orchestrator with tsx once P1's PR #22 is merged.",
      );
    }
    if (typeof mod.runFixLoop !== "function") throw new Error(`P1 fix loop not available: ${modulePath} does not export runFixLoop`);
    return mod.runFixLoop({ maxAttempts, ...o });
  };
}
