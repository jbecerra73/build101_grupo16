import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, Finding, FixResult, Metrics, RunConfig, RunStatus } from "@frictionswarm/shared";

export type RunData = {
  dir: string;
  config: RunConfig;
  /** All events, each agent's log sorted by ts. */
  events: Event[];
  byAgent: Map<string, Event[]>;
  metrics?: Metrics;
  findings?: Finding[];
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

const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Group events by agent, sorting each log by ts (stable). */
export function groupByAgent(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) map.set(e.agentId, [...(map.get(e.agentId) ?? []), e]);
  for (const [k, evs] of map) map.set(k, evs.toSorted((a, b) => a.ts - b.ts));
  return map;
}

export function readRun(dir: string): RunData {
  const config = readJson<RunConfig>(join(dir, "config.json"));
  if (!config) throw new Error(`No readable config.json in ${dir}`);
  const evDir = join(dir, "events");
  const files = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  const byAgent = groupByAgent(files.flatMap((f) => parseJsonl<Event>(readFileSync(join(evDir, f), "utf8"))));
  return {
    dir,
    config,
    events: [...byAgent.values()].flat(),
    byAgent,
    metrics: readJson(join(dir, "metrics.json")),
    findings: readJson(join(dir, "findings.json")),
    fix: readJson(join(dir, "fix.json")),
    status: readJson(join(dir, "status.json")),
  };
}
