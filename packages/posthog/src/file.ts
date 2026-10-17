import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isSwarm, PRODUCTION_URL, type PostHogEvent } from "@frictionswarm/shared";
import {
  sleep,
  SWARM_FINAL_EVENTS,
  SwarmTimeoutError,
  windowBounds,
  type DescribedSource,
  type RealUserQuery,
  type SwarmQuery,
  type WaitForSwarmQuery,
} from "./source";

export const PRODUCTION_HOST = new URL(PRODUCTION_URL).host;

export type FileSourceOptions = {
  /** Folder with events.jsonl and swarm-<runId>.jsonl. Default: POSTHOG_DATA_DIR or <repo>/data/posthog. */
  dataDir?: string;
  /** History file name inside dataDir (default events.jsonl), or an absolute path. */
  historyFile?: string;
  /** Production host for real-user queries; null keeps every host. Default: the production storefront. */
  host?: string | null;
  /** waitForSwarm polling interval. Default 1000 ms. */
  pollMs?: number;
};

export const defaultDataDir = (env: Record<string, string | undefined> = process.env) =>
  env.POSTHOG_DATA_DIR || join(import.meta.dirname, "..", "..", "..", "data", "posthog");

/** Stream a JSONL file line by line (never loads it whole). Blank and unparseable lines are
 * skipped (a file being appended may end with a half-written line). `keep` sees the raw line
 * first, so callers can skip lines without paying for JSON.parse. */
export async function* readJsonl(path: string, keep?: (line: string) => boolean): AsyncGenerator<PostHogEvent> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || (keep && !keep(line))) continue;
    try {
      yield JSON.parse(line) as PostHogEvent;
    } catch {}
  }
}

/** Top-level "timestamp" of a raw export line, without parsing it (undefined when unsure). */
export function lineTimestamp(line: string): number | undefined {
  const i = line.indexOf('"timestamp":"');
  if (i < 0) return undefined;
  const p = line.indexOf('"properties":');
  if (p >= 0 && p < i) return undefined; // could be a property called "timestamp"
  const start = i + 13;
  const ts = Date.parse(line.slice(start, line.indexOf('"', start)));
  return Number.isNaN(ts) ? undefined : ts;
}

/** Real-user filter shared by the file and snapshot sources. */
export function realUserFilter(q: RealUserQuery, host: string | null) {
  const { from, to } = windowBounds(q);
  return {
    line: (line: string) => {
      const ts = lineTimestamp(line);
      return ts === undefined || (ts >= from && ts < to);
    },
    event: (e: PostHogEvent) => {
      if (isSwarm(e)) return false;
      const ts = Date.parse(e.timestamp);
      if (!(ts >= from && ts < to)) return false;
      if (q.buildSha && e.properties.build_sha !== q.buildSha) return false;
      const h = e.properties.$host as string | undefined;
      return !host || !h || h === host;
    },
  };
}

export const swarmFilter = (q: SwarmQuery) => (e: PostHogEvent) =>
  e.properties.swarm_run === q.runId && e.properties.build_sha === q.buildSha;

/** Agents (swarm_agent) whose final swarm_done / swarm_give_up is in `events`. */
export async function finishedAgents(events: AsyncIterable<PostHogEvent>, runId: string): Promise<Set<string>> {
  const done = new Set<string>();
  for await (const e of events)
    if (SWARM_FINAL_EVENTS.has(e.event) && e.properties.swarm_run === runId && typeof e.properties.swarm_agent === "string")
      done.add(e.properties.swarm_agent);
  return done;
}

/** Poll `check` until no agent is missing, or throw SwarmTimeoutError listing them. */
export async function pollSwarm(q: WaitForSwarmQuery, pollMs: number, check: () => Promise<Set<string>>): Promise<void> {
  const deadline = Date.now() + q.timeoutMs;
  for (;;) {
    const done = await check();
    const missing = q.agentIds.filter((a) => !done.has(a));
    if (!missing.length) return;
    if (Date.now() >= deadline) throw new SwarmTimeoutError(q.runId, missing, q.timeoutMs);
    await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
  }
}

/** Offline backend: data/posthog/events.jsonl (history) and swarm-<runId>.jsonl (swarm tracks). */
export function fileSource(opts: FileSourceOptions = {}): DescribedSource {
  const dir = opts.dataDir ?? defaultDataDir();
  const history = opts.historyFile?.startsWith("/") ? opts.historyFile : join(dir, opts.historyFile ?? "events.jsonl");
  const host = opts.host === undefined ? PRODUCTION_HOST : opts.host;
  const swarmPath = (runId: string) => {
    if (!/^[\w.-]+$/.test(runId)) throw new Error(`invalid run id ${runId}`);
    return join(dir, `swarm-${runId}.jsonl`);
  };
  return {
    kind: "file",
    description: `file ${history}`,
    async *realUserEvents(q) {
      if (!existsSync(history)) throw new Error(`no PostHog history at ${history} (run npm run posthog:generate)`);
      const f = realUserFilter(q, host);
      for await (const e of readJsonl(history, f.line)) if (f.event(e)) yield e;
    },
    async *swarmEvents(q) {
      const keep = swarmFilter(q);
      for await (const e of readJsonl(swarmPath(q.runId))) if (keep(e)) yield e;
    },
    waitForSwarm(q) {
      return pollSwarm(q, opts.pollMs ?? 1000, () => finishedAgents(readJsonl(swarmPath(q.runId)), q.runId));
    },
  };
}
