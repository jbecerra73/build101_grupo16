// Shared contracts for FrictionSwarm. Every part (worker, analyzer, dashboard,
// orchestrator, coding agent) builds against these shapes. See SPEC.md.
//
// PostHog pivot: the analyzer reads PostHog events (shared/analytics.ts), not
// an agent event log. An "analysis" run measures real users per segment; a
// "retest" run measures the persona swarm on a deploy preview.
//
// Run folder layout (no DB):
//   runs/<runId>/config.json        RunConfig
//   runs/<runId>/status.json        RunStatus (written by the orchestrator while it works)
//   runs/<runId>/posthog.jsonl      the PostHogEvents this run analyzed (snapshot, so it replays offline)
//   runs/<runId>/metrics.json       Metrics
//   runs/<runId>/findings.json      Finding[]
//   runs/<runId>/fix.json           FixResult (analysis runs that triggered a fix)
//   runs/<runId>/screenshots/<agentId>.png   latest screenshot per agent (retest only, display only)
//   runs/<runId>/agents/<agentId>.json       SwarmAgentResult: how each agent ended (retest only)

import type { SegmentId } from "./analytics";

export type PersonaId = string;

export type Persona = {
  id: PersonaId;
  name: string;
  prompt: string;
  /** Control personas must not regress on any metric. */
  control?: boolean;
  viewport: { width: number; height: number; mobile: boolean };
  perception: {
    mode: "screenshot" | "screenshot+a11y";
    /** Gaussian blur radius in px applied to the screenshot. */
    blur?: number;
    /** Scale factor (0–1] applied to the screenshot before the model sees it. */
    downscale?: number;
    /** Elements with WCAG contrast ratio below this are removed from what the agent sees. */
    minContrast?: number;
    /** Text smaller than this (CSS px) is removed from what the agent sees. */
    minFontPx?: number;
    /** Elements only reachable by hover are hidden. */
    hideHoverOnly?: boolean;
  };
  actions: {
    /** Upper bound on actions; with maxActionsRange, the per-agent budget (see actionBudget). */
    maxActions: number;
    /** Inclusive [min, max]: each agent's budget is drawn from it by seed. */
    maxActionsRange?: [number, number];
    /** Tap targets smaller than this (either dimension) register as misses. */
    minTapTargetPx?: number;
    /** Give up after this many failed attempts at the same target. */
    maxRetriesSameTarget?: number;
  };
  patience: {
    start: number;
    costs: { pageLoad: number; modal: number; error: number };
  };
};

/** A funnel step is matched by `route`: a pathname pattern where `*` matches any
 * characters, optionally followed by `?key=value` that must be present in the
 * query string. When several routes match, one with a query wins. Steps are
 * listed in funnel order. */
export type FlowStep = { route: string; name: string };

/** A PostHog event a session must contain; `where` matches its properties exactly. */
export type EventMatch = { event: string; where?: Record<string, string | number | boolean> };

export type Flow = {
  id: string;
  goal: string;
  startUrl: string;
  success: { urlPattern?: string; visibleText?: string };
  steps: FlowStep[];
  /** Locked: the coding agent may not remove these. */
  required: { steps: string[]; fields: RequiredField[] };
  /** Events a valid completion must contain, besides reaching the success step and every required step. */
  completion: EventMatch[];
  /** Real users only: the sessions that count as attempting this flow (default: every session).
   * Swarm agents are told the goal, so all of theirs count. */
  attempt?: EventMatch;
  /** Tells the swarm agent when to call done. */
  doneWhen: string;
};

export type RequiredField =
  | "email"
  | "fullName"
  | "address"
  | "city"
  | "postalCode"
  | "country"
  | "cardNumber";

/** @deprecated Agent event log, retired by the PostHog pivot: agents leave
 * PostHog tracks instead (see SwarmEvent in analytics.ts). Kept so open PRs
 * still compile while they migrate; don't build new code on it. */
export type EventType = "page_view" | "action" | "think_aloud" | "error" | "give_up" | "success";

/** @deprecated See EventType. */
export type ActionKind = "click" | "type" | "scroll" | "back";

/** @deprecated See EventType. */
export type Event = {
  runId: string;
  agentId: string;
  personaId: PersonaId;
  seed: number;
  ts: number;
  type: EventType;
  url?: string;
  step?: string;
  action?: { kind: ActionKind | string; selector?: string; text?: string; missed?: boolean; field?: RequiredField | string };
  note?: string;
  screenshot?: string;
  confirmation?: { email?: string; address?: string; cardLast4?: string };
};

export type Severity = "high" | "medium" | "low";

/** A release as seen in PostHog: the first time a production build_sha appears. */
export type Release = { sha: string; date: string; name: string };

export type Finding = {
  id: string;
  severity: Severity;
  segments: SegmentId[];
  /** Derived from segments (SEGMENTS[].personaId); the personas a fix targets. */
  personas: PersonaId[];
  step: string;
  page: string;
  selector?: string;
  title: string;
  evidence: {
    /** Affected sessions / users, out of N in the segment(s). */
    sessions: number;
    users: number;
    dropOffRate?: number;
    rageClicks?: number;
    /** First release where this signal's rate jumped against the previous one. */
    sinceRelease?: Release;
    /** $session_id values; the dashboard links them to PostHog replays. */
    exampleSessions: string[];
    /** swarm_give_up / swarm_think_aloud notes; retest runs only. */
    quotes: string[];
    /** Optional retest screenshots, relative to the run folder. */
    screenshots?: string[];
  };
  suggestedFix: string;
};

export type FunnelStep = {
  step: string;
  /** Sessions whose $pageviews include this step. */
  reached: number;
  /** Sessions whose last step was this one and that did not complete. */
  droppedHere: number;
};

/** Metrics for one group of sessions: a segment's real users or a persona's agents. */
type GroupMetrics = {
  /** Sessions (one session = one funnel attempt or one agent). Show N next to every number. */
  n: number;
  /** Distinct users (distinct_id). */
  users: number;
  /** Valid completions only (see completion validity in SPEC.md). */
  completed: number;
  completionRate: number;
  /** Sessions that ended with swarm_give_up (retest) or left before success (analysis). */
  gaveUp: number;
  /** Reached the success step but failed validity checks. */
  invalidCompletions: number;
  /** Over valid completions only (0 when none). Steps = funnel step transitions + actions. */
  medianSteps: number;
  medianTimeMs: number;
  funnel: FunnelStep[];
};

export type SegmentMetrics = GroupMetrics & { segmentId: SegmentId };
export type PersonaMetrics = GroupMetrics & { personaId: PersonaId };

/** One week of one segment's real-user completion, for the trend chart. */
export type TrendPoint = {
  segmentId: SegmentId;
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  n: number;
  completed: number;
  completionRate: number;
};

export type Metrics = {
  runId: string;
  flowId: string;
  /** Production build_sha for an analysis (the current release); preview sha for a retest. */
  buildSha: string;
  /** Analysis runs: real users per segment. Empty on a retest. */
  segments: SegmentMetrics[];
  /** Retest runs: swarm agents per persona. Empty on an analysis. */
  personas: PersonaMetrics[];
  /** Analysis runs: weekly series per segment, with release markers. */
  trend?: { points: TrendPoint[]; releases: Release[] };
};

export type RunKind = "analysis" | "retest";

export type PostHogSourceKind = "file" | "api";

export type RunConfig = {
  runId: string;
  kind: RunKind;
  flowId: string;
  /** What the swarm agents are told to do, in place of the flow's preset goal. */
  goal?: string;
  /** Analysis window over real users, [from, to), ISO dates. */
  window?: { from: string; to: string };
  posthog: {
    source: PostHogSourceKind;
    /** Analysis: production release analyzed (optional filter). Retest: the preview's build_sha. */
    buildSha: string;
  };
  /** Retest only: personas and seeds; agentId = `${personaId}-${seed}`. */
  personaIds: PersonaId[];
  seeds: Record<PersonaId, number[]>;
  /** Analysis: production URL. Retest: the deploy preview URL. */
  targetUrl: string;
  /** For a retest, the analysis run it is compared against. */
  baselineRunId?: string;
  createdAt: string;
};

/** A segment's real users (before) against the persona swarm standing in for it (after). */
export type PersonaComparison = {
  personaId: PersonaId;
  segmentId: SegmentId;
  before: SegmentMetrics;
  after: PersonaMetrics;
  completionDeltaPts: number;
  regressions: string[];
};

export type Verdict = {
  improved: boolean;
  /** Personas the fix targeted (from the fixed findings). */
  targetedPersonas: PersonaId[];
  comparisons: PersonaComparison[];
  reasons: string[];
};

export type FixStatus =
  | "running"
  | "draft"
  | "retesting"
  | "ready"
  | "not-proven"
  | "failed";

export type FixAttempt = {
  attempt: number;
  findingIds: string[];
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  previewUrl?: string;
  /** The coding agent's own summary of its change. */
  summary?: string;
  retestRunId?: string;
  verdict?: Verdict;
  status: FixStatus;
  error?: string;
};

export type FixResult = {
  /** The analysis run whose findings were fixed. */
  baselineRunId: string;
  repo: string;
  attempts: FixAttempt[];
};

/** Pipeline phase of an analysis run, including its fix and retest. */
export type RunPhase =
  | "analyzing"
  | "fixing"
  | "waiting-preview"
  | "retesting"
  /** Waiting for the swarm's events to be ingested by PostHog (waitForSwarm). */
  | "collecting"
  | "comparing"
  | "done"
  | "failed";

export type RunStatus = {
  runId: string;
  phase: RunPhase;
  updatedAt: string;
  /** Human-readable progress line for the dashboard. */
  message?: string;
  /** Set once the retest swarm has started. */
  retestRunId?: string;
  error?: string;
};

/** What the dashboard sends to start a pipeline ("Analyze"). */
export type StartRunRequest = {
  flowId: string;
  /** Overrides the flow's goal for the swarm (e.g. a different item); still measured on its checkout funnel. */
  goal?: string;
  /** Defaults to the current production release, last 28 days. */
  window?: { from: string; to: string };
  /** Defaults to POSTHOG_SOURCE (file). */
  source?: PostHogSourceKind;
  /** Run the coding agent + swarm retest after the analysis. */
  autoFix: boolean;
  /** Retest swarm size; defaults to 10. */
  seedsPerPersona?: number;
};

/** How one swarm agent ended, written by the worker when the agent stops. Its clicks and page
 * views are in PostHog; this is the local record the orchestrator can read without waiting for
 * ingestion. */
export type SwarmAgentResult = {
  runId: string;
  agentId: string;
  personaId: PersonaId;
  seed: number;
  outcome: "success" | "give_up" | "error";
  /** Browser actions used (click/type/scroll/back). */
  actions: number;
  /** give_up reason or error message. */
  reason?: string;
  /** Funnel step and URL where the agent ended. */
  step?: string;
  url?: string;
  /** What the confirmation page echoed back (success only). */
  confirmation?: { email?: string; address?: string; cardLast4?: string };
  startedAt: string;
  endedAt: string;
};
