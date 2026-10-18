// The swarm's tracks as the agents' browsers recorded them (worker/posthog-recorder.ts), instead
// of waiting for PostHog to ingest them. Each agent leaves runs/<runId>/events/<agentId>.jsonl;
// mergeRecorded turns them into runs/<runId>/posthog.jsonl, the snapshot the analyzer and the
// dashboard already prefer over a live source.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PostHogEvent } from "../../shared";

export const RECORDED_SNAPSHOT = "posthog.jsonl";

const FINAL = new Set(["swarm_done", "swarm_give_up"]);

/** Merges every agent's recorded events (this run's only, deduplicated, in time order) into
 * runs/<runId>/posthog.jsonl. Writes nothing when no agent recorded anything, so a store without
 * posthog-js still falls back to PostHog. */
export function mergeRecorded(runDir: string, runId: string, agentIds: string[]): { events: number; finished: Set<string> } {
  const seen = new Set<string>();
  const events: PostHogEvent[] = [];
  for (const agentId of agentIds) {
    const file = join(runDir, "events", `${agentId}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let e: PostHogEvent;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a line still being written
      }
      if (e.properties?.swarm_run !== runId || seen.has(e.uuid)) continue;
      seen.add(e.uuid);
      events.push(e);
    }
  }
  const finished = new Set(events.filter((e) => FINAL.has(e.event)).map((e) => String(e.properties.swarm_agent)));
  if (!events.length) return { events: 0, finished };
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const path = join(runDir, RECORDED_SNAPSHOT);
  writeFileSync(`${path}.tmp`, events.map((e) => JSON.stringify(e) + "\n").join(""));
  renameSync(`${path}.tmp`, path);
  return { events: events.length, finished };
}
