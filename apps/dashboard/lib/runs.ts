// Server-only reader for the run folders in the run store (see shared/contracts.ts
// and lib/control-types.ts for the layout). Runs are written live by the
// orchestrator, so every optional file may be missing or half-written, and the
// last JSONL line may be partial.
import "server-only";
import {
  FLOWS,
  type Event,
  type Finding,
  type Metrics,
  type RunConfig,
  type RunPhase,
} from "@frictionswarm/shared";
import { isValidRunId as validRunId, KEYS, type QueuedRun } from "@frictionswarm/store";
import { deriveAgents, deriveMetrics, giveUpGroups, groupByAgent } from "./derive";
import { runStore } from "./store";
import type { FixResultView, RunDetail, RunStatusView, RunSummary, Theme } from "./types";

export { runsDir } from "./runs-dir";

export const isValidRunId = validRunId;

const runKey = (runId: string, rel: string) => KEYS.runFile(runId, rel);

/** Parses JSONL, skipping blank lines and any line that does not parse
 * (typically the last line while the worker is still writing it). */
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

export async function readEvents(runId: string): Promise<Event[]> {
  if (!isValidRunId(runId)) return [];
  const store = runStore();
  const keys = (await store.list(runKey(runId, "events/")).catch(() => [])).filter((k) => k.endsWith(".jsonl"));
  const chunks = await Promise.all(
    keys.map(async (k) => {
      try {
        return parseJsonl<Event>((await store.getText(k)) ?? "");
      } catch {
        return [];
      }
    }),
  );
  return chunks.flat().sort((a, b) => a.ts - b.ts);
}

function inferPhase(events: Event[], metrics?: Metrics, findings?: Finding[]): RunPhase {
  if (metrics && findings) return "done";
  if (metrics) return "analyzing";
  if (events.length) return "swarming";
  return "verifying";
}

const getJson = <T>(runId: string, rel: string) => runStore().getJson<T>(runKey(runId, rel)).catch(() => undefined);

async function loadCore(runId: string, opts: { events?: boolean } = { events: true }) {
  if (!isValidRunId(runId)) return undefined;
  const config = await getJson<RunConfig>(runId, "config.json");
  if (!config) return undefined;
  const [statusFile, metrics, findings, themes, fix] = await Promise.all([
    getJson<RunStatusView>(runId, "status.json"),
    getJson<Metrics>(runId, "metrics.json"),
    getJson<Finding[]>(runId, "findings.json"),
    getJson<Theme[]>(runId, "themes.json"),
    getJson<FixResultView>(runId, "fix.json"),
  ]);
  // Summaries of finished runs do not need the event log (one read per agent).
  const events = opts.events || !metrics ? await readEvents(runId) : undefined;
  let status: RunStatusView = statusFile ?? {
    runId,
    phase: inferPhase(events ?? [], metrics, findings),
    updatedAt: new Date(events?.at(-1)?.ts ?? Date.parse(config.createdAt)).toISOString(),
    inferred: true,
  };
  // A retest's pipeline status lives on its baseline; once its own metrics exist it is done.
  if (statusFile && config.kind === "retest" && metrics && findings) status = { ...statusFile, phase: "done" };
  return {
    config,
    status,
    metrics,
    findings: Array.isArray(findings) ? findings : undefined,
    themes: Array.isArray(themes) ? themes : undefined,
    fix,
    events,
  };
}

const isLive = (phase: RunPhase) => phase === "verifying" || phase === "swarming";

/** A run that is still in the queue: a placeholder so the run page can show it right away. */
async function queuedRun(runId: string): Promise<RunDetail | undefined> {
  const q = (await listQueue()).find((x) => x.runId === runId);
  if (!q) return undefined;
  const flow = FLOWS[q.req.flowId];
  const config: RunConfig = {
    runId,
    kind: "baseline",
    flowId: q.req.flowId,
    personaIds: q.req.personaIds,
    seeds: {},
    targetUrl: q.req.targetUrl ?? flow?.startUrl ?? "",
    buildSha: "queued",
    createdAt: q.requestedAt,
  };
  return {
    runId,
    config,
    status: { runId, phase: "verifying", message: "Queued: waiting for the orchestrator", updatedAt: q.requestedAt, inferred: true },
    flow,
    agents: [],
    giveUps: [],
  };
}

export async function getRun(runId: string, opts: { events?: boolean } = {}): Promise<RunDetail | undefined> {
  const core = await loadCore(runId);
  if (!core) return isValidRunId(runId) ? queuedRun(runId) : undefined;
  const { config, status, metrics, findings, themes, fix } = core;
  const events = core.events ?? [];
  const flow = FLOWS[config.flowId];
  return {
    runId,
    config,
    status,
    flow,
    agents: deriveAgents(config, events, flow, isLive(status.phase)),
    metrics,
    provisionalMetrics: !metrics && events.length ? deriveMetrics(config, events, flow) : undefined,
    findings,
    fix,
    giveUps: giveUpGroups(events),
    themes,
    events: opts.events ? events : undefined,
  };
}

export async function getRunSummary(runId: string): Promise<RunSummary | undefined> {
  const core = await loadCore(runId, { events: false });
  if (!core) return undefined;
  const { config, status, metrics, fix } = core;
  const events = core.events ?? [];
  const provisional = !metrics;
  const m = metrics ?? deriveMetrics(config, events, FLOWS[config.flowId]);
  const last = fix?.attempts.at(-1);
  const seeded = Object.values(config.seeds).flat().length;
  return {
    runId,
    config,
    status,
    agents: metrics ? metrics.personas.reduce((n, p) => n + p.n, 0) || seeded : groupByAgent(events).size || seeded,
    personas: m.personas.map((p) => ({ personaId: p.personaId, n: p.n, completed: p.completed, provisional })),
    fixStatus: last?.status,
    prUrl: last?.prUrl,
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
