import type { PostHogEvent } from "@frictionswarm/shared";

export type RealUserQuery = {
  /** ISO date or timestamp, inclusive. */
  from: string;
  /** ISO timestamp, exclusive. A date-only value (YYYY-MM-DD) covers that whole day. */
  to: string;
  /** Only this production build. */
  buildSha?: string;
};
export type SwarmQuery = { runId: string; buildSha: string };
export type WaitForSwarmQuery = { runId: string; agentIds: string[]; timeoutMs: number };

/** The analyzer's only door to PostHog (SPEC.md, PostHog source). */
export interface PostHogSource {
  /** Real users only (no swarm_run), production host, [from, to). */
  realUserEvents(q: RealUserQuery): AsyncIterable<PostHogEvent>;
  /** One swarm run's tracks on a build. */
  swarmEvents(q: SwarmQuery): AsyncIterable<PostHogEvent>;
  /** Resolves when every agent's swarm_done / swarm_give_up is visible; rejects
   * with SwarmTimeoutError (listing the missing agents) after timeoutMs. */
  waitForSwarm(q: WaitForSwarmQuery): Promise<void>;
}

/** Which backend a source reads; "snapshot" replays a run's posthog.jsonl. */
export type SourceKind = "file" | "api" | "snapshot";
export type DescribedSource = PostHogSource & { readonly kind: SourceKind; readonly description: string };

export class SwarmTimeoutError extends Error {
  constructor(
    readonly runId: string,
    readonly missing: string[],
    timeoutMs: number,
  ) {
    super(`waitForSwarm(${runId}): timed out after ${timeoutMs}ms; still missing ${missing.length} agent(s): ${missing.join(", ")}`);
    this.name = "SwarmTimeoutError";
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

/** [from, to) in epoch ms. A date-only `to` means the end of that day (matches the
 * generator's inclusive --to and the dashboard's date pickers). */
export function windowBounds(q: { from: string; to: string }): { from: number; to: number } {
  const from = Date.parse(DATE_ONLY.test(q.from) ? `${q.from}T00:00:00Z` : q.from);
  const to = DATE_ONLY.test(q.to) ? Date.parse(`${q.to}T00:00:00Z`) + DAY : Date.parse(q.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error(`invalid window ${q.from} → ${q.to}`);
  return { from, to };
}

export const SWARM_FINAL_EVENTS = new Set(["swarm_done", "swarm_give_up"]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
