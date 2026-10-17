// The fix loop seam. The pipeline hands a FixLoop the analysis run and three
// callbacks that move its phases (retesting → collecting → comparing); once the
// Product Owner decides, ApplyDecision merges or closes the PR. Two
// implementations of each:
//   - fakeFixLoop (./fakeFix.ts): offline rehearsal, no coding agent and no PR
//   - P1's runFixLoop (orchestrator/fix-loop.ts, PR #22): loaded by realFixLoop
//     below through a guarded dynamic import, so this package builds without it.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { DecisionRequest, Finding, Flow, FixAttempt, FixResult, Metrics, PersonaId, RunConfig, Severity, Verdict } from "@frictionswarm/shared";
import { REPO_ROOT } from "./runs";
import type { SwarmRunner } from "./swarm";

/** Analyzes runs/<runId>/ (writes metrics.json, findings.json, posthog.jsonl). */
export type Analyzer = (runId: string) => Promise<{ metrics: Metrics; findings: Finding[] }>;

/** The analyzer's compareSegmentsToPersonas: analysis (segments) vs retest (personas). */
export type Compare = (analysis: Metrics, retest: Metrics, targetedPersonas: PersonaId[], flow?: Flow) => Verdict;

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
  /** The findings the Product Owner chose: fixed exactly, in this order, with no
   * re-ranking. Unknown ids throw `Unknown finding "<id>"`. Default: the loop picks. */
  findingIds?: string[];
};

/** Fixes the top findings, re-tests the preview and records everything in
 * runs/<baselineRunId>/fix.json (running → draft → retesting → ready | not-proven). */
export type FixLoop = (o: FixLoopOptions) => Promise<FixResult>;

/** Applies the Product Owner's accept (merge the PR) or reject (close it) to the
 * last attempt in runs/<runId>/fix.json (status → merged | rejected, decision
 * filled) and returns that attempt. */
export type ApplyDecision = (o: { runsDir: string; runId: string; request: DecisionRequest; log: (l: string) => void }) => Promise<FixAttempt>;

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Findings by severity, then by affected sessions. */
export const rankFindings = (findings: Finding[]) =>
  findings.toSorted((a, b) => RANK[a.severity] - RANK[b.severity] || b.evidence.sessions - a.evidence.sessions);

/** The findings with these ids, in this order. Throws on an unknown id. */
export function chosenFindings(findings: Finding[], ids: string[]): Finding[] {
  return ids.map((id) => {
    const f = findings.find((x) => x.id === id);
    if (!f) throw new Error(`Unknown finding "${id}"`);
    return f;
  });
}

/** The retest's config for a fix attempt. agentId = `${personaId}-${seed}`. */
export function retestConfig(analysis: RunConfig, o: { attempt: number; commitSha: string; previewUrl: string; seeds: Record<PersonaId, number[]> }): RunConfig {
  const personaIds = Object.keys(o.seeds).filter((p) => o.seeds[p]?.length);
  return {
    runId: `${analysis.runId}-retest${o.attempt}`,
    kind: "retest",
    flowId: analysis.flowId,
    flow: analysis.flow,
    posthog: { source: analysis.posthog.source, buildSha: o.commitSha },
    personaIds,
    seeds: o.seeds,
    targetUrl: o.previewUrl,
    baselineRunId: analysis.runId,
    createdAt: new Date().toISOString(),
  };
}

/** What P1's module must export (orchestrator/fix-loop.ts, or FIX_LOOP_MODULE). */
type P1Module = { runFixLoop?: FixLoop; applyDecision?: ApplyDecision };

const defaultModule = () => process.env.FIX_LOOP_MODULE ?? join(REPO_ROOT, "orchestrator", "fix-loop.ts");

/** P1's module, imported at call time. The specifier is computed so neither tsc
 * nor the Next bundler needs the file. */
async function loadP1(modulePath: string): Promise<P1Module> {
  try {
    const specifier = pathToFileURL(modulePath).href;
    return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)) as P1Module;
  } catch (e) {
    throw new Error(
      `P1 fix loop not available: could not load ${modulePath} (${e instanceof Error ? e.message : String(e)}). ` +
        "Use FIX_LOOP=fake for the offline rehearsal, or run the orchestrator with tsx once P1's PR #22 is merged.",
    );
  }
}

/** P1's real fix loop (coding agent in a tenki sandbox, draft PR, preview
 * polling, PR finalization), imported at call time from FIX_LOOP_MODULE or
 * <repo>/orchestrator/fix-loop.ts. When it is missing the run fails with
 * "P1 fix loop not available". */
export function realFixLoop(modulePath = defaultModule()): FixLoop {
  return async (o) => {
    const mod = await loadP1(modulePath);
    if (typeof mod.runFixLoop !== "function") throw new Error(`P1 fix loop not available: ${modulePath} does not export runFixLoop`);
    return mod.runFixLoop(o);
  };
}

/** P1's real decision (gh pr merge / gh pr close), from the same module as realFixLoop. */
export function realApplyDecision(modulePath = defaultModule()): ApplyDecision {
  return async (o) => {
    const mod = await loadP1(modulePath);
    if (typeof mod.applyDecision !== "function") throw new Error(`P1 fix loop not available: ${modulePath} does not export applyDecision`);
    return mod.applyDecision(o);
  };
}
