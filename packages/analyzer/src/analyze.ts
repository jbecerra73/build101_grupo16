import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPostHogSource, snapshot, snapshotSource, windowBounds, type PostHogSource } from "@frictionswarm/posthog";
import { flowOf, type Finding, type Flow, type Metrics, type PostHogEvent, type RunConfig } from "@frictionswarm/shared";
import { generateFindings, type FindingsOptions, type FindingsPath } from "./findings";
import { historyFromEvents, type History } from "./history";
import { computeMetrics } from "./metrics";
import { readJson } from "./run";
import { summarizeSessions, type SessionSummary } from "./sessions";
import { frictionSignals, type Signal } from "./signals";
import type { Theme } from "./themes";

const DAY = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 28;
export const DEFAULT_HISTORY_DAYS = 183;

export type AnalyzeOptions = FindingsOptions & {
  /** Where events come from. Default: replay the run's posthog.jsonl if it exists (with its
   * history.json), else a live source of config.posthog.source. */
  source?: PostHogSource;
  flow?: Flow;
  /** Write posthog.jsonl, history.json (analysis), metrics.json, findings.json, themes.json. Default true. */
  write?: boolean;
  /** Analysis runs: how far back the trend and release attribution look, ending at window.to. Default 183 days. */
  historyDays?: number;
  /** Analysis runs: reuse runs/<id>/history.json instead of streaming the history again.
   * Default: only when replaying a snapshot. */
  cachedHistory?: boolean;
  /** "now" for the default window (tests). */
  now?: number;
};

export type AnalyzeResult = {
  metrics: Metrics;
  findings: Finding[];
  themes: Theme[];
  signals: Signal[];
  history?: History;
  path: FindingsPath;
  themesPath: FindingsPath;
  /** Events analyzed (= written to posthog.jsonl). */
  events: number;
  sessions: number;
  timings: { readMs: number; findingsMs: number; totalMs: number };
  error?: string;
};

const writeJson = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The source analyzeRun uses when none is given. */
export function defaultSource(runDir: string, config: RunConfig): PostHogSource {
  return existsSync(join(runDir, "posthog.jsonl")) ? snapshotSource(runDir) : createPostHogSource(config.posthog.source);
}

const isSnapshot = (s: PostHogSource) => (s as { kind?: string }).kind === "snapshot";

/** Analyze a run folder: reads config.json, pulls its events (real users per segment for an
 * analysis, the swarm's tracks per persona for a retest), snapshots them and writes metrics,
 * findings and themes. */
export async function analyzeRun(runDir: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const t0 = Date.now();
  const config = readJson<RunConfig>(join(runDir, "config.json"));
  if (!config) throw new Error(`No readable config.json in ${runDir}`);
  const flow = opts.flow ?? flowOf(config);
  if (!flow) throw new Error(`Unknown flow ${config.flowId}`);
  const source = opts.source ?? defaultSource(runDir, config);
  const write = opts.write ?? true;
  const kind = config.kind;

  let events: PostHogEvent[] = [];
  let sessions: SessionSummary[] = [];
  let history: History | undefined;
  if (kind === "analysis") {
    const now = opts.now ?? Date.now();
    const window = config.window ?? { from: day(now - DEFAULT_WINDOW_DAYS * DAY), to: day(now - DAY) };
    const wb = windowBounds(window);
    const buildSha = config.posthog.buildSha || undefined;
    const keepSession = (s: SessionSummary) => s.start >= wb.from && s.start < wb.to && (!buildSha || s.buildSha === buildSha);
    const cached = (opts.cachedHistory ?? isSnapshot(source)) ? readJson<History>(join(runDir, "history.json")) : undefined;
    const range = cached
      ? window
      : { from: new Date(wb.to - (opts.historyDays ?? DEFAULT_HISTORY_DAYS) * DAY).toISOString(), to: new Date(wb.to).toISOString() };
    const computed = await historyFromEvents(flow, source.realUserEvents(range), range, {
      onSession: (s, evs) => {
        if (!keepSession(s)) return;
        sessions.push(s);
        events.push(...evs);
      },
    });
    history = cached ?? computed;
    sessions.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.uuid.localeCompare(b.uuid));
  } else {
    for await (const e of source.swarmEvents({ runId: config.runId, buildSha: config.posthog.buildSha })) events.push(e);
    sessions = summarizeSessions(flow, events);
  }
  const readMs = Date.now() - t0;

  const metrics = computeMetrics(config, flow, sessions, { history });
  const signals = frictionSignals(flow, sessions, { kind, history });
  const t1 = Date.now();
  const res = await generateFindings({ runId: config.runId, kind, flow, metrics, sessions, signals, history }, opts);
  const findingsMs = Date.now() - t1;

  if (write) {
    await snapshot(events, runDir);
    if (history) await writeJson(join(runDir, "history.json"), history);
    await writeJson(join(runDir, "metrics.json"), metrics);
    await writeJson(join(runDir, "findings.json"), res.findings);
    await writeJson(join(runDir, "themes.json"), res.themes);
  }
  return {
    metrics,
    signals,
    ...(history && { history }),
    ...res,
    events: events.length,
    sessions: sessions.length,
    timings: { readMs, findingsMs, totalMs: Date.now() - t0 },
  };
}

/** The orchestrator's `Analyzer` port: (runId) => { metrics, findings }. */
export function createAnalyzer({ runsDir, ...opts }: AnalyzeOptions & { runsDir: string }) {
  return async (runId: string): Promise<{ metrics: Metrics; findings: Finding[] }> => {
    const r = await analyzeRun(join(runsDir, runId), opts);
    opts.log?.(
      `analyzed ${runId}: ${r.sessions} sessions, ${r.findings.length} findings via ${r.path}, ${r.themes.length} themes via ${r.themesPath} (${r.timings.totalMs}ms)${r.error ? ` (${r.error})` : ""}`,
    );
    return { metrics: r.metrics, findings: r.findings };
  };
}
