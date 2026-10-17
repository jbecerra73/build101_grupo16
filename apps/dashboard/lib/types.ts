import type {
  Event,
  FixAttempt,
  FixResult,
  Finding,
  Flow,
  Metrics,
  PersonaId,
  RunConfig,
  RunStatus,
} from "@frictionswarm/shared";

import type { GiveUpGroup } from "./derive";

/** View models shared by the API routes and the client components. */

export type AgentOutcome = "running" | "success" | "gave-up" | "invalid" | "stopped";

export type AgentState = {
  agentId: string;
  personaId: PersonaId;
  seed: number;
  state: AgentOutcome;
  /** Last funnel step seen in the log. */
  step?: string;
  actions: number;
  missedActions: number;
  budget: number;
  latestScreenshot?: string;
  lastNote?: string;
  /** give_up reason, or why a completion was ruled invalid. */
  outcomeNote?: string;
  startedAt?: number;
  lastEventAt?: number;
};

/** FixAttempt plus fields from contracts that landed after this branch was cut. */
export type FixAttemptView = FixAttempt & {
  /** The coding agent's own description of its change (P1, PR #22). */
  summary?: string;
};

export type FixResultView = Omit<FixResult, "attempts"> & { attempts: FixAttemptView[] };

export type RunStatusView = RunStatus & {
  /** True when status.json is missing and the phase was inferred from files. */
  inferred?: boolean;
};

export type PersonaSummary = {
  personaId: PersonaId;
  n: number;
  completed: number;
  /** True when counted from events because metrics.json is not written yet. */
  provisional: boolean;
};

export type RunSummary = {
  runId: string;
  config: RunConfig;
  status: RunStatusView;
  agents: number;
  personas: PersonaSummary[];
  fixStatus?: FixAttempt["status"];
  prUrl?: string;
};

export type RunDetail = {
  runId: string;
  config: RunConfig;
  status: RunStatusView;
  flow?: Flow;
  agents: AgentState[];
  metrics?: Metrics;
  /** Computed from events while metrics.json does not exist yet. */
  provisionalMetrics?: Metrics;
  findings?: Finding[];
  fix?: FixResultView;
  /** Give-up reasons grouped by step, with persona quotes. */
  giveUps: GiveUpGroup[];
  /** Raw events, only when requested with ?events=1 (used by Replay). */
  events?: Event[];
};
