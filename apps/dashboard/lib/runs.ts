// Server-only reader for the run folders in the run store (see shared/contracts.ts
// and lib/control-types.ts for the layout). Runs are written live by the
// orchestrator, so every optional file may be missing or half-written, and the
// last JSONL line may be partial.
//
// An analysis run is read from its files (metrics, findings, themes, fix,
// status). A retest run's agents come from the swarm's PostHog sessions: the
// run's posthog.jsonl snapshot once the analyzer wrote it, else (while the swarm
// runs and PostHog ingests) straight from the PostHog source, plus the
// screenshots and their index.
import "server-only";
import {
  FLOWS,
  PRODUCTION_URL,
  type Finding,
  type Metrics,
  type PostHogEvent,
  type PostHogSourceKind,
  type Release,
  type RunConfig,
  type TrendPoint,
  type RunPhase,
  type StartRunRequest,
} from "@frictionswarm/shared";
import { isValidRunId as validRunId, KEYS, type QueuedRun } from "@frictionswarm/store";
import { deriveAgents, deriveMetrics, giveUpGroups, groupByAgent } from "./derive";
import { runStore } from "./store";
import type { FixResultView, GroupSummary, RunDetail, RunStatusView, RunSummary, ScreenshotIndex, Theme } from "./types";
import { SEGMENTS } from "@frictionswarm/shared";

import { runsDir as runsDirPath } from "./runs-dir";

export { runsDir } from "./runs-dir";

export const isValidRunId = validRunId;

const runKey = (runId: string, rel: string) => KEYS.runFile(runId, rel);

/** Parses JSONL, skipping blank lines and any line that does not parse
 * (typically the last line while it is still being written). */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* partial line */
    }
  }
  return out;
}

const getJson = <T>(runId: string, rel: string) => runStore().getJson<T>(runKey(runId, rel)).catch(() => undefined);

/** PostHog replay links: `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/replay/<session>`. */
export function replayBase(env = process.env): string | undefined {
  const host = env.POSTHOG_HOST?.replace(/\/+$/, "");
  const project = env.POSTHOG_PROJECT_ID;
  return host && project ? `${host}/project/${encodeURIComponent(project)}/replay/` : undefined;
}

// ------------------------------------------------------------ swarm events

type CacheEntry = { at: number; events: PostHogEvent[] };
const g = globalThis as { __frictionswarmSwarmCache?: Map<string, CacheEntry> };
const swarmCache = (g.__frictionswarmSwarmCache ??= new Map());

/** Live swarm events from the PostHog source (file: data/posthog/swarm-<runId>.jsonl,
 * api: HogQL). Cached briefly so a polling dashboard does not hammer PostHog. */
async function liveSwarmEvents(config: RunConfig): Promise<PostHogEvent[] | undefined> {
  const kind: PostHogSourceKind = config.posthog.source;
  const ttl = kind === "api" ? 5_000 : 750;
  const hit = swarmCache.get(config.runId);
  if (hit && Date.now() - hit.at < ttl) return hit.events;
  try {
    const { createPostHogSource } = await import("@frictionswarm/posthog");
    const events: PostHogEvent[] = [];
    for await (const e of createPostHogSource(kind).swarmEvents({ runId: config.runId, buildSha: config.posthog.buildSha })) events.push(e);
    swarmCache.set(config.runId, { at: Date.now(), events });
    if (swarmCache.size > 50) swarmCache.delete(swarmCache.keys().next().value!);
    return events;
  } catch {
    return hit?.events;
  }
}

/** A retest's swarm events: the snapshot when it exists, else the live source. */
export async function readSwarmEvents(config: RunConfig, opts: { live: boolean }): Promise<{ events: PostHogEvent[]; from: RunDetail["eventsFrom"] }> {
  const snap = await runStore().getText(runKey(config.runId, "posthog.jsonl")).catch(() => undefined);
  if (snap !== undefined) return { events: parseJsonl<PostHogEvent>(snap), from: "snapshot" };
  if (!opts.live) return { events: [], from: "none" };
  const live = await liveSwarmEvents(config);
  return live ? { events: live, from: "source" } : { events: [], from: "none" };
}

async function readScreenshots(runId: string) {
  const store = runStore();
  const [keys, index] = await Promise.all([
    store.list(runKey(runId, "screenshots/")).catch(() => [] as string[]),
    store.getJson<ScreenshotIndex>(runKey(runId, "screenshots/index.json")).catch(() => undefined),
  ]);
  return { index, files: new Set(keys.map((k) => k.slice(k.lastIndexOf("/") + 1))) };
}

// ------------------------------------------------------------ run folders

function inferPhase(config: RunConfig, metrics?: Metrics, findings?: Finding[]): RunPhase {
  if (metrics && findings) return "done";
  return config.kind === "retest" ? "retesting" : "analyzing";
}

async function loadCore(runId: string) {
  if (!isValidRunId(runId)) return undefined;
  const config = await getJson<RunConfig>(runId, "config.json");
  if (!config?.kind) return undefined;
  const [statusFile, metricsFile, findings, themes, fix] = await Promise.all([
    getJson<RunStatusView>(runId, "status.json"),
    getJson<Metrics>(runId, "metrics.json"),
    getJson<Finding[]>(runId, "findings.json"),
    getJson<Theme[]>(runId, "themes.json"),
    getJson<FixResultView>(runId, "fix.json"),
  ]);
  // The trend lives in metrics.json; history.json (the analyzer's six-month
  // summary) backs it up for runs whose metrics were written without one.
  let metrics = metricsFile;
  if (metrics && config.kind === "analysis" && !metrics.trend) {
    const history = await getJson<{ releases: Release[]; trend: TrendPoint[] }>(runId, "history.json");
    if (history?.trend?.length) metrics = { ...metrics, trend: { points: history.trend, releases: history.releases } };
  }
  let status: RunStatusView = statusFile ?? {
    runId,
    phase: inferPhase(config, metrics, findings),
    updatedAt: config.createdAt,
    inferred: true,
  };
  // A retest's pipeline status lives on its analysis run; once its own metrics exist it is done.
  if (config.kind === "retest" && metrics) status = { ...status, phase: "done" };
  return {
    config,
    status,
    hasStatusFile: !!statusFile,
    metrics,
    findings: Array.isArray(findings) ? findings : undefined,
    themes: Array.isArray(themes) ? themes : undefined,
    fix,
  };
}

/** A run still in the queue: a placeholder so the run page can show it right away. */
async function queuedRun(runId: string): Promise<RunDetail | undefined> {
  const q = (await listQueue()).find((x) => x.runId === runId);
  if (!q) return undefined;
  return {
    runId,
    config: placeholderConfig(runId, q.req, q.requestedAt),
    status: { runId, phase: "analyzing", message: "Queued: waiting for the orchestrator", updatedAt: q.requestedAt, inferred: true },
    flow: FLOWS[q.req.flowId],
    agents: [],
    giveUps: [],
    replayBase: replayBase(),
  };
}

/** Last 28 days up to and including the day of `iso`, as the pipeline's default. */
const defaultWindowFor = (iso: string) => {
  const to = Date.parse(iso.slice(0, 10)) + 86_400_000;
  const d = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: d(to - 28 * 86_400_000), to: d(to) };
};

/** config.json for a run that has none yet (queued, or cancelled before it started). */
export function placeholderConfig(runId: string, req: StartRunRequest, createdAt: string): RunConfig {
  return {
    runId,
    kind: "analysis",
    flowId: req.flowId,
    // The orchestrator fills in the default window (last 28 days) and the current release.
    window: req.window ?? defaultWindowFor(createdAt),
    posthog: { source: req.source ?? "file", buildSha: req.window ? "" : "current" },
    personaIds: [],
    seeds: {},
    targetUrl: PRODUCTION_URL,
    createdAt,
  };
}

export async function getRun(runId: string, opts: { events?: boolean } = {}): Promise<RunDetail | undefined> {
  const core = await loadCore(runId);
  if (!core) return isValidRunId(runId) ? queuedRun(runId) : undefined;
  const { config, status, metrics, findings, themes, fix } = core;
  const flow = FLOWS[config.flowId];
  const base = {
    runId,
    config,
    status,
    flow,
    metrics,
    findings,
    fix,
    themes,
    releases: metrics?.trend?.releases,
    replayBase: replayBase(),
  };
  if (config.kind !== "retest") return { ...base, agents: [], giveUps: [] };

  const live = !metrics;
  const [{ events, from }, shots] = await Promise.all([readSwarmEvents(config, { live }), readScreenshots(runId)]);
  return {
    ...base,
    agents: deriveAgents(config, events, flow, live, shots),
    provisionalMetrics: !metrics && events.length ? deriveMetrics(config, events, flow) : undefined,
    giveUps: giveUpGroups(events, flow),
    eventsFrom: from,
    events: opts.events ? events.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp)) : undefined,
  };
}

function groupsOf(config: RunConfig, metrics: Metrics | undefined, provisional?: Metrics): GroupSummary[] {
  if (config.kind === "analysis")
    return (metrics?.segments ?? []).map((s) => ({
      kind: "segment",
      id: s.segmentId,
      personaId: SEGMENTS.find((x) => x.id === s.segmentId)?.personaId ?? "other",
      n: s.n,
      completed: s.completed,
      provisional: false,
    }));
  const m = metrics ?? provisional;
  return (m?.personas ?? []).map((p) => ({ kind: "persona", id: p.personaId, personaId: p.personaId, n: p.n, completed: p.completed, provisional: !metrics }));
}

export async function getRunSummary(runId: string): Promise<RunSummary | undefined> {
  const core = await loadCore(runId);
  if (!core) return undefined;
  const { config, status, metrics, findings, fix } = core;
  // Folders with neither status.json nor metrics.json are not pipeline runs
  // (e.g. the analyzer's own test fixtures).
  if (!core.hasStatusFile && !metrics) return undefined;
  let provisional: Metrics | undefined;
  let agents = 0;
  if (config.kind === "retest" && !metrics) {
    const { events } = await readSwarmEvents(config, { live: true });
    provisional = deriveMetrics(config, events, FLOWS[config.flowId]);
    agents = groupByAgent(events).size;
  }
  const groups = groupsOf(config, metrics, provisional);
  const seeded = Object.values(config.seeds).flat().length;
  const last = fix?.attempts.at(-1);
  return {
    runId,
    config,
    status,
    sessions: groups.reduce((n, gr) => n + gr.n, 0) || agents || seeded,
    groups,
    findings: findings?.length,
    fixStatus: last?.status,
    prUrl: last?.prUrl,
    prNumber: last?.prNumber,
    retestRunId: status.retestRunId ?? last?.retestRunId,
  };
}

export async function listRuns(): Promise<RunSummary[]> {
  let ids: string[];
  try {
    ids = await runStore().listDirs("runs/");
  } catch {
    return [];
  }
  const runs = await Promise.all(ids.filter(isValidRunId).map((id) => getRunSummary(id).catch(() => undefined)));
  return runs
    .filter((r): r is RunSummary => !!r)
    .sort((a, b) => Date.parse(b.config.createdAt) - Date.parse(a.config.createdAt));
}

/** Queued runs, oldest first. */
export async function listQueue(): Promise<QueuedRun[]> {
  const store = runStore();
  const keys = await store.list(KEYS.queue).catch(() => []);
  const items = await Promise.all(keys.map((k) => store.getJson<QueuedRun>(k).catch(() => undefined)));
  return items.filter((q): q is QueuedRun => !!q?.runId && !!q.req).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Store key and content type of an image inside a run folder, refusing
 * anything that could escape it (`..`, empty or nested segments, separators)
 * or is not an image. */
export function runFileKey(runId: string, parts: string[]): { key: string; contentType: string } | undefined {
  if (!isValidRunId(runId) || !parts.length) return undefined;
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\0") || p.includes("/") || p.includes("\\"))) return undefined;
  const rel = parts.join("/");
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) return undefined;
  return { key: runKey(runId, rel), contentType };
}

/** Reads an image (screenshot) from a run folder in the store. */
export async function readRunFile(runId: string, parts: string[]): Promise<{ body: Uint8Array; contentType: string } | undefined> {
  const file = runFileKey(runId, parts);
  if (!file) return undefined;
  const body = await runStore().getBytes(file.key).catch(() => undefined);
  return body && { body, contentType: file.contentType };
}

/** Releases known to the dashboard, newest last: from the latest analysis
 * run's trend. Used for the Analyze form's window presets. */
export async function knownReleases(): Promise<{ sha: string; date: string; name: string }[]> {
  const runs = (await listRuns()).filter((r) => r.config.kind === "analysis" && r.status.phase !== "failed");
  for (const r of runs) {
    const m = await getJson<Metrics>(r.runId, "metrics.json");
    if (m?.trend?.releases?.length) return m.trend.releases;
  }
  return [];
}

/** Releases in the PostHog dataset's manifest (file source), oldest first:
 * the fallback for the Analyze form before any analysis exists. */
export async function datasetReleases(): Promise<{ sha: string; date: string; name: string }[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const dir = process.env.POSTHOG_DATA_DIR || join(dirname(runsDirPath()), "data", "posthog");
    const m = JSON.parse(await readFile(/*turbopackIgnore: true*/ join(dir, "events.manifest.json"), "utf8"));
    return Array.isArray(m.releases) ? m.releases.map(({ sha, date, name }: { sha: string; date: string; name: string }) => ({ sha, date, name })) : [];
  } catch {
    return [];
  }
}
