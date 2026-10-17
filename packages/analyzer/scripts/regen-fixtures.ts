// Regenerates runs/fixture-analysis/{history,metrics,findings,themes}.json and
// runs/fixture-retest/{metrics,findings,themes}.json with the analyzer (heuristic path, so
// it's deterministic). The fixtures' posthog.jsonl snapshots are kept as they are.
//
// The analysis fixture's history is the fake six-month history stamped with the fixture's
// production sha, up to the fixture window, followed by the fixture's own snapshot:
//   npx tsx tools/posthog-sim/generate.ts --out /tmp/fx/events.jsonl --current-sha f00dfeedfixture
//   npx tsx packages/analyzer/scripts/regen-fixtures.ts /tmp/fx
import { join } from "node:path";
import { fileSource, snapshotSource, windowBounds, type DescribedSource } from "@frictionswarm/posthog";
import type { RunConfig } from "@frictionswarm/shared";
import { analyzeRun, readJson } from "../src";

const RUNS = join(import.meta.dirname, "..", "..", "..", "runs");
const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: regen-fixtures.ts <data dir with events.jsonl stamped --current-sha f00dfeedfixture>");

const analysisDir = join(RUNS, "fixture-analysis");
const config = readJson<RunConfig>(join(analysisDir, "config.json"))!;
const cut = new Date(windowBounds(config.window!).from).toISOString();
const history = fileSource({ dataDir });
const snap = snapshotSource(analysisDir);
const source: DescribedSource = {
  kind: "file",
  description: `history before ${cut} + fixture snapshot`,
  async *realUserEvents(q) {
    yield* history.realUserEvents({ ...q, to: cut });
    yield* snap.realUserEvents({ ...q, from: cut });
  },
  swarmEvents: (q) => snap.swarmEvents(q),
  waitForSwarm: (q) => snap.waitForSwarm(q),
};

for (const [dir, opts] of [
  [analysisDir, { source }],
  [join(RUNS, "fixture-retest"), {}],
] as const) {
  const r = await analyzeRun(dir, { ...opts, env: {} });
  console.log(`${dir}: ${r.sessions} sessions, ${r.findings.length} findings (${r.path}), ${r.themes.length} themes`);
  for (const f of r.findings) console.log(`  ${f.id} [${f.severity}] ${f.step} ${f.segments.join(",")}: ${f.title}${f.evidence.sinceRelease ? ` (since ${f.evidence.sinceRelease.name})` : ""}`);
}
