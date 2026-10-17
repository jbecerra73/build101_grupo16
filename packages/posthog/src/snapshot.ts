import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { PostHogEvent } from "@frictionswarm/shared";
import { finishedAgents, pollSwarm, readJsonl, realUserFilter, swarmFilter } from "./file";
import type { DescribedSource } from "./source";

export const SNAPSHOT_FILE = "posthog.jsonl";

/** Write the events a run analyzed to runs/<id>/posthog.jsonl (one event per line), so the
 * run replays offline. Writes a temp file and renames it, so a source that is reading the same
 * snapshot is never cut short. Returns the number of events written. */
export async function snapshot(events: Iterable<PostHogEvent> | AsyncIterable<PostHogEvent>, runDir: string): Promise<number> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, SNAPSHOT_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  const out = createWriteStream(tmp, { encoding: "utf8" });
  let n = 0;
  try {
    for await (const e of events as AsyncIterable<PostHogEvent>) {
      if (!out.write(JSON.stringify(e) + "\n")) await new Promise((r) => out.once("drain", r));
      n++;
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  await rename(tmp, path);
  return n;
}

/** Replays a past run's posthog.jsonl as a source: same filters as the file source,
 * over just the events that run analyzed. Every host is kept (the snapshot was already filtered). */
export function snapshotSource(runDir: string, opts: { pollMs?: number } = {}): DescribedSource {
  const path = join(runDir, SNAPSHOT_FILE);
  return {
    kind: "snapshot",
    description: `snapshot ${path}`,
    async *realUserEvents(q) {
      const f = realUserFilter(q, null);
      for await (const e of readJsonl(path, f.line)) if (f.event(e)) yield e;
    },
    async *swarmEvents(q) {
      const keep = swarmFilter(q);
      for await (const e of readJsonl(path)) if (keep(e)) yield e;
    },
    waitForSwarm(q) {
      return pollSwarm(q, opts.pollMs ?? 1000, () => finishedAgents(readJsonl(path), q.runId));
    },
  };
}
