// Shared contracts for FrictionSwarm. Every part (worker, analyzer, dashboard,
// orchestrator, coding agent) builds against these shapes. See SPEC.md.
//
// Run folder layout (no DB):
//   runs/<runId>/config.json        RunConfig
//   runs/<runId>/events/<agentId>.jsonl   one Event per line
//   runs/<runId>/screenshots/<file>.png   referenced by Event.screenshot
//   runs/<runId>/metrics.json       Metrics
//   runs/<runId>/findings.json      Finding[]
//   runs/<runId>/fix.json           FixResult (only on runs that triggered a fix)

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

export type Flow = {
  id: string;
  goal: string;
  startUrl: string;
  success: { urlPattern?: string; visibleText?: string };
  steps: FlowStep[];
  /** Locked: the coding agent may not remove these. */
  required: { steps: string[]; fields: RequiredField[] };
};

export type RequiredField =
  | "email"
  | "fullName"
  | "address"
  | "city"
  | "postalCode"
  | "country"
  | "cardNumber";

export type EventType =
  | "page_view"
  | "action"
  | "think_aloud"
  | "error"
  | "give_up"
  | "success";

export type ActionKind = "click" | "type" | "scroll" | "back";

export type Event = {
  runId: string;
  agentId: string;
  personaId: PersonaId;
  seed: number;
  ts: number;
  type: EventType;
  url?: string;
  /** Resolved via the flow's route→step map (see resolveStep). */
  step?: string;
  action?: {
    kind: ActionKind | string;
    selector?: string;
    text?: string;
    /** True when the action did not land (e.g. tap target too small). */
    missed?: boolean;
    /** Set on `type` actions that filled a known form field. */
    field?: RequiredField | string;
  };
  note?: string;
  /** Path relative to the run folder, e.g. "screenshots/rosa-3-007.png". */
  screenshot?: string;
  /** On `success` events: what the confirmation page echoed back. */
  confirmation?: { email?: string; address?: string; cardLast4?: string };
};

export type Severity = "high" | "medium" | "low";

export type Finding = {
  id: string;
  severity: Severity;
  personas: PersonaId[];
  step: string;
  page: string;
  selector?: string;
  title: string;
  evidence: { screenshots: string[]; quotes: string[]; agentCount: number };
  suggestedFix: string;
};

export type FunnelStep = {
  step: string;
  /** Agents whose log contains this step. */
  reached: number;
  /** Agents whose last step was this one and who did not complete. */
  droppedHere: number;
};

export type PersonaMetrics = {
  personaId: PersonaId;
  /** Number of agents (show N next to every number). */
  n: number;
  /** Valid completions only (see completion validity in SPEC.md). */
  completed: number;
  completionRate: number;
  gaveUp: number;
  /** Agents that hit the success condition but failed validity checks. */
  invalidCompletions: number;
  medianSteps: number;
  medianTimeMs: number;
  funnel: FunnelStep[];
};

export type Metrics = {
  runId: string;
  flowId: string;
  buildSha: string;
  personas: PersonaMetrics[];
};

export type RunKind = "baseline" | "retest";

export type RunConfig = {
  runId: string;
  kind: RunKind;
  flowId: string;
  personaIds: PersonaId[];
  /** Seeds per persona; agentId = `${personaId}-${seed}`. */
  seeds: Record<PersonaId, number[]>;
  targetUrl: string;
  /** build-sha meta read from targetUrl before the swarm started. */
  buildSha: string;
  /** For a retest, the baseline it is compared against. */
  baselineRunId?: string;
  createdAt: string;
};

export type PersonaComparison = {
  personaId: PersonaId;
  before: PersonaMetrics;
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
  retestRunId?: string;
  verdict?: Verdict;
  status: FixStatus;
  error?: string;
};

export type FixResult = {
  baselineRunId: string;
  repo: string;
  attempts: FixAttempt[];
};
