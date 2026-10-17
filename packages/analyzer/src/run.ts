import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, FixResult, Metrics, PostHogEvent, RunConfig, RunStatus } from "@frictionswarm/shared";
import type { History } from "./history";
import type { Theme } from "./themes";

export type RunData = {
  dir: string;
  config: RunConfig;
  metrics?: Metrics;
  findings?: Finding[];
  themes?: Theme[];
  /** Analysis runs: release/trend aggregates over the history (history.json). */
  history?: History;
  fix?: FixResult;
  status?: RunStatus;
};

/** Parse JSONL, skipping blank and unparseable lines (the last one may be half-written). */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** A run folder's JSON files (not its events; see readRunEvents). */
export function readRun(dir: string): RunData {
  const config = readJson<RunConfig>(join(dir, "config.json"));
  if (!config) throw new Error(`No readable config.json in ${dir}`);
  return {
    dir,
    config,
    metrics: readJson(join(dir, "metrics.json")),
    findings: readJson(join(dir, "findings.json")),
    themes: readJson(join(dir, "themes.json")),
    history: readJson(join(dir, "history.json")),
    fix: readJson(join(dir, "fix.json")),
    status: readJson(join(dir, "status.json")),
  };
}

/** The run's posthog.jsonl snapshot, in memory (fine for one run's window; never for the full history). */
export function readRunEvents(dir: string): PostHogEvent[] {
  const path = join(dir, "posthog.jsonl");
  return existsSync(path) ? parseJsonl<PostHogEvent>(readFileSync(path, "utf8")) : [];
}
