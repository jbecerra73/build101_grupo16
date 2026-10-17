import type {
  FixAttempt,
  FixResult,
  Finding,
  Flow,
  Metrics,
  PersonaId,
  PostHogEvent,
  Release,
  RunConfig,
  RunStatus,
  SegmentId,
} from "@frictionswarm/shared";
import type { GiveUpGroup } from "./derive";

/** View models shared by the API routes and the client components. */

/** themes.json from the analyzer: reasons people/agents left, grouped, with
 * verbatim quotes. Shape kept loose so analyzer versions can add fields. */
export type Theme = {
  id: string;
  title: string;
  personas?: PersonaId[];
  segments?: SegmentId[];
  /** Sessions (real users) or agents (swarm) in this theme (the analyzer's field). */
  sessions?: number;
  /** Older analyzer field names. */
  agentCount?: number;
  sessionCount?: number;
  quotes: { personaId?: PersonaId; agentId?: string; sessionId?: string; text: string }[];
  findingIds?: string[];
};

export type AgentOutcome = "running" | "success" | "gave-up" | "invalid" | "stopped";

/** One swarm agent on the re-test, from its PostHog session (and its screenshot). */
export type AgentState = {
  agentId: string;
  personaId: PersonaId;
  seed: number;
  state: AgentOutcome;
  /** Funnel step: the screenshot manifest's when fresher, else the last $pageview. */
  step?: string;
  /** Clicks ($autocapture) so far. */
  actions: number;
  /** Struggles: rage clicks and failed form submits. */
  missedActions: number;
  budget: number;
  /** Run-relative path, e.g. screenshots/rosa-3.png. */
  latestScreenshot?: string;
  /** Changes whenever the screenshot does (cache buster). */
  screenshotVersion?: string;
  /** Latest swarm_think_aloud note. */
  lastNote?: string;
  /** swarm_give_up reason, or why a completion was ruled invalid. */
  outcomeNote?: string;
  /** $session_id, for the PostHog replay link. */
  sessionId?: string;
  startedAt?: number;
  lastEventAt?: number;
};

export type FixAttemptView = FixAttempt;
export type FixResultView = FixResult;

export type RunStatusView = RunStatus & {
  /** True when status.json is missing and the phase was inferred from files. */
  inferred?: boolean;
};

/** N and completions of one segment (analysis) or persona (retest). */
export type GroupSummary = {
  kind: "segment" | "persona";
  id: SegmentId | PersonaId;
  /** The persona standing in for the segment, or the persona itself (colors, avatars). */
  personaId: PersonaId;
  n: number;
  completed: number;
  /** Counted from PostHog sessions because metrics.json is not written yet. */
  provisional: boolean;
};

export type RunSummary = {
  runId: string;
  config: RunConfig;
  status: RunStatusView;
  /** Sessions analyzed (analysis) or agents (retest). */
  sessions: number;
  groups: GroupSummary[];
  findings?: number;
  fixStatus?: FixAttempt["status"];
  prUrl?: string;
  prNumber?: number;
  retestRunId?: string;
};

/** "Screenshot manifest" a swarm runner may keep next to the screenshots:
 * runs/<runId>/screenshots/index.json. */
export type ScreenshotIndex = Record<string, { step?: string; at: string; n: number }>;

export type RunDetail = {
  runId: string;
  config: RunConfig;
  status: RunStatusView;
  flow?: Flow;
  /** Retest runs: one per agent. Empty for analysis runs. */
  agents: AgentState[];
  metrics?: Metrics;
  /** Retest runs: persona metrics counted from the PostHog sessions so far. */
  provisionalMetrics?: Metrics;
  findings?: Finding[];
  fix?: FixResultView;
  /** Retest runs: swarm_give_up reasons grouped by step. */
  giveUps: GiveUpGroup[];
  themes?: Theme[];
  /** Releases seen in the data (from the trend), for markers and window presets. */
  releases?: Release[];
  /** `${POSTHOG_APP_HOST || POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/replay/` when set. */
  replayBase?: string;
  /** Where the retest's events came from: the run's snapshot, or the live source. */
  eventsFrom?: "snapshot" | "source" | "none";
  /** Raw PostHog events, only with ?events=1 (Replay of a retest). */
  events?: PostHogEvent[];
};
