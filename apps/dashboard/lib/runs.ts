// Server-only reader for the run folders on disk (see shared/contracts.ts for
// the layout). Runs are written live by the orchestrator, so every optional file
// may be missing or half-written, and the last JSONL line may be partial.
import "server-only";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FLOWS,
  type Event,
  type Finding,
  type Metrics,
  type RunConfig,
  type RunPhase,
} from "@frictionswarm/shared";
import { deriveAgents, deriveMetrics, giveUpGroups, groupByAgent } from "./derive";
import type { FixResultView, RunDetail, RunStatusView, RunSummary, Theme } from "./types";

/** `RUNS_DIR` env, else `<repo-root>/runs` (repo root = nearest ancestor with shared/contracts.ts). */
export function runsDir(): string {
  if (process.env.RUNS_DIR) return resolve(process.env.RUNS_DIR);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(/*turbopackIgnore: true*/ join(dir, "shared", "contracts.ts"))) return join(dir, "runs");
    const up = dirname(dir);
    if (up === dir) return resolve(process.cwd(), "..", "..", "runs");
    dir = up;
  }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isValidRunId = (id: string) => RUN_ID.test(id) && !id.includes("..");

function runPath(runId: string): string | undefined {
  if (!isValidRunId(runId)) return undefined;
  return join(/*turbopackIgnore: true*/ runsDir(), runId);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ path, "utf8")) as T;
  } catch {
    // Missing, or being written right now: treat as not there yet.
    return undefined;
  }
}

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
  const dir = runPath(runId);
  if (!dir) return [];
  let files: string[];
  try {
    files = (await readdir(/*turbopackIgnore: true*/ join(dir, "events"))).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const chunks = await Promise.all(
    files.map(async (f) => {
      try {
        return parseJsonl<Event>(await readFile(/*turbopackIgnore: true*/ join(dir, "events", f), "utf8"));
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

async function loadCore(runId: string) {
  const dir = runPath(runId);
  if (!dir) return undefined;
  const config = await readJson<RunConfig>(join(dir, "config.json"));
  if (!config) return undefined;
  const [statusFile, metrics, findings, themes, fix, events] = await Promise.all([
    readJson<RunStatusView>(join(dir, "status.json")),
    readJson<Metrics>(join(dir, "metrics.json")),
    readJson<Finding[]>(join(dir, "findings.json")),
    readJson<Theme[]>(join(dir, "themes.json")),
    readJson<FixResultView>(join(dir, "fix.json")),
    readEvents(runId),
  ]);
  let status: RunStatusView = statusFile ?? {
    runId,
    phase: inferPhase(events, metrics, findings),
    updatedAt: new Date(events.at(-1)?.ts ?? Date.parse(config.createdAt)).toISOString(),
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

export async function getRun(runId: string, opts: { events?: boolean } = {}): Promise<RunDetail | undefined> {
  const core = await loadCore(runId);
  if (!core) return undefined;
  const { config, status, metrics, findings, themes, fix, events } = core;
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

export async function listRuns(): Promise<RunSummary[]> {
  let ids: string[];
  try {
    ids = (await readdir(/*turbopackIgnore: true*/ runsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const runs = await Promise.all(
    ids.filter(isValidRunId).map(async (runId): Promise<RunSummary | undefined> => {
      const core = await loadCore(runId);
      if (!core) return undefined;
      const { config, status, metrics, fix, events } = core;
      const provisional = !metrics;
      const m = metrics ?? deriveMetrics(config, events, FLOWS[config.flowId]);
      const last = fix?.attempts.at(-1);
      return {
        runId,
        config,
        status,
        agents: groupByAgent(events).size || Object.values(config.seeds).flat().length,
        personas: m.personas.map((p) => ({ personaId: p.personaId, n: p.n, completed: p.completed, provisional })),
        fixStatus: last?.status,
        prUrl: last?.prUrl,
      };
    }),
  );
  return runs
    .filter((r): r is RunSummary => !!r)
    .sort((a, b) => Date.parse(b.config.createdAt) - Date.parse(a.config.createdAt));
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Resolves a file inside a run folder, refusing anything that escapes it
 * (`..`, absolute paths, symlinks pointing outside) or is not an image. */
export async function resolveRunFile(
  runId: string,
  parts: string[],
): Promise<{ path: string; contentType: string } | undefined> {
  const dir = runPath(runId);
  if (!dir || !parts.length) return undefined;
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\0") || p.includes("/") || p.includes("\\"))) return undefined;
  const rel = join(...parts);
  if (isAbsolute(rel)) return undefined;
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) return undefined;
  const full = resolve(dir, rel);
  const inside = (root: string, p: string) => {
    const r = relative(root, p);
    return !!r && !r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes("..");
  };
  if (!inside(dir, full)) return undefined;
  try {
    const realDir = realpathSync(/*turbopackIgnore: true*/ dir);
    const realFull = realpathSync(/*turbopackIgnore: true*/ full);
    if (!inside(realDir, realFull)) return undefined;
    if (!(await stat(/*turbopackIgnore: true*/ realFull)).isFile()) return undefined;
    return { path: realFull, contentType };
  } catch {
    return undefined;
  }
}
