// Regenerates the dashboard's demo fixtures from the fake PostHog history,
// through the real pipeline, analyzer and offline swarm (no hand-written metrics):
//
//   npm run posthog:generate                     # data/posthog/events.jsonl
//   npx tsx apps/dashboard/scripts/gen-fixtures.mts
//
//   runs/fixture-proven         analysis done, rehearsal fix of T1 + T2, verdict ready
//   runs/fixture-not-proven     analysis done, rehearsal fix of T3 only, verdict not proven
//   runs/fixture-live           analysis done, the re-test swarm caught mid-run
//   (each with its <id>-retest1 folder)
//
// The analyzer runs on its deterministic heuristic path (no model keys), so the
// fixtures are stable. The analysis runs' posthog.jsonl snapshots (~40 MB each)
// are dropped; history.json and metrics.json carry the trend and the report.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSegmentsToPersonas, createAnalyzer } from "@frictionswarm/analyzer";
import { createPostHogSource } from "@frictionswarm/posthog";
import {
  analysisConfig,
  fakeFixLoop,
  offlineSwarmRunner,
  ingested,
  runPipeline,
  seedsFor,
  simulateAgent,
  swarmFile,
  type PipelineDeps,
  type TrapId,
} from "@frictionswarm/pipeline";
import { FLOWS, resolveStep, type FixResult, type PostHogEvent, type RunConfig, type RunStatus } from "@frictionswarm/shared";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNS = join(ROOT, "runs");
const DATA = process.env.POSTHOG_DATA_DIR || join(ROOT, "data", "posthog");
const SHOTS = join(ROOT, "apps", "dashboard", "scripts", "shots");
const NOW = new Date("2026-10-17T21:00:00.000Z");
const SEEDS = Array.from({ length: 10 }, (_, i) => 1 + i);
const json = (f: string, d: unknown) => writeFile(f, JSON.stringify(d, null, 2) + "\n");
const read = async <T,>(f: string) => JSON.parse(await readFile(f, "utf8")) as T;

const source = createPostHogSource("file", { dataDir: DATA });
const analyze = createAnalyzer({ runsDir: RUNS, source, env: {}, log: (l) => console.log("  ", l) });

async function pipelineFixture(runId: string, traps: TrapId[], createdAt: Date) {
  console.log(`${runId}: fixing ${traps.join("+")}`);
  await rm(join(RUNS, runId), { recursive: true, force: true });
  await rm(join(RUNS, `${runId}-retest1`), { recursive: true, force: true });
  await mkdir(join(RUNS, runId), { recursive: true });
  const config = await analysisConfig(runId, { flowId: "buy-tshirt", source: "file", autoFix: true }, createdAt);
  await json(join(RUNS, runId, "config.json"), config);
  await json(join(RUNS, runId, "request.json"), { flowId: "buy-tshirt", source: "file", autoFix: true, seedsPerPersona: SEEDS.length });
  const deps: PipelineDeps = {
    runsDir: RUNS,
    source: () => source,
    analyze,
    compare: (a, r, t, flow) => compareSegmentsToPersonas(a, r, t, { flow }),
    runSwarm: offlineSwarmRunner({ runsDir: RUNS, dataDir: DATA, shotsDir: SHOTS, durationMs: 400, ingestLagMs: 50, bootMs: 0, tickMs: 10 }),
    fixLoop: fakeFixLoop({ stageDelayMs: 0, traps }),
    fixWatchMs: 5,
    onStatus: (s) => console.log(`  ${s.phase}: ${s.message ?? ""}`),
  };
  const final = await runPipeline(runId, { autoFix: true, retestSeeds: seedsFor(SEEDS) }, deps);
  if (final.phase !== "done") throw new Error(`${runId} ended ${final.phase}: ${final.error}`);
  await finish(runId, createdAt);
  const fix = await read<FixResult>(join(RUNS, runId, "fix.json"));
  console.log(`  verdict: ${fix.attempts[0].status}\n    ${fix.attempts[0].verdict?.reasons.join("\n    ")}`);
}

/** Stable timestamps, no 40 MB snapshot, no swarm file left behind. */
async function finish(runId: string, createdAt: Date) {
  await rm(join(RUNS, runId, "posthog.jsonl"), { force: true });
  const status = await read<RunStatus>(join(RUNS, runId, "status.json"));
  await json(join(RUNS, runId, "status.json"), { ...status, updatedAt: new Date(createdAt.getTime() + 95_000).toISOString() });
  const retestId = `${runId}-retest1`;
  const rc = await read<RunConfig>(join(RUNS, retestId, "config.json")).catch(() => undefined);
  if (rc) await json(join(RUNS, retestId, "config.json"), { ...rc, createdAt: new Date(createdAt.getTime() + 40_000).toISOString() });
  await ingested(retestId);
  await rm(swarmFile(DATA, retestId), { force: true });
  await rm(swarmFile(DATA, retestId).replace(/\.jsonl$/, ".manifest.json"), { force: true });
}

const SHOT: Record<string, string> = { Home: "home", Browse: "shop", Product: "product", Cart: "cart", Account: "account", Shipping: "checkout", Payment: "payment", "Payment failed": "payment", Confirmation: "success" };

/** An analysis whose re-test swarm is caught at `cut` (0–1) of its run: the
 * agents' events and screenshots up to that point, no metrics yet. */
async function liveFixture(runId: string, from: string, cut: number, createdAt: Date) {
  console.log(`${runId}: re-test caught at ${Math.round(cut * 100)}%`);
  const dir = join(RUNS, runId);
  const retestId = `${runId}-retest1`;
  const rdir = join(RUNS, retestId);
  await rm(dir, { recursive: true, force: true });
  await rm(rdir, { recursive: true, force: true });
  await cp(join(RUNS, from), dir, { recursive: true });
  await rm(join(dir, "fix.json"));
  for (const f of ["config.json", "metrics.json", "findings.json", "themes.json", "history.json"]) {
    const p = join(dir, f);
    const text = await readFile(p, "utf8").catch(() => undefined);
    if (text) await writeFile(p, text.replaceAll(from, runId));
  }
  const config = await read<RunConfig>(join(dir, "config.json"));
  await json(join(dir, "config.json"), { ...config, createdAt: createdAt.toISOString() });
  const fromFix = await read<FixResult>(join(RUNS, from, "fix.json"));
  const a = fromFix.attempts[0];
  const fix: FixResult = {
    ...fromFix,
    baselineRunId: runId,
    attempts: [{ ...a, branch: `frictionswarm/rehearsal-${runId}`, retestRunId: retestId, status: "retesting", verdict: undefined }],
  };
  await json(join(dir, "fix.json"), fix);
  const status: RunStatus = {
    runId,
    phase: "retesting",
    message: `Swarm re-testing the preview: ${SEEDS.length * 3} agents (rosa, kai, typical), fresh seeds`,
    retestRunId: retestId,
    updatedAt: new Date(createdAt.getTime() + 52_000).toISOString(),
  };
  await json(join(dir, "status.json"), status);

  const flow = FLOWS["buy-tshirt"];
  const rc: RunConfig = {
    ...(await read<RunConfig>(join(RUNS, `${from}-retest1`, "config.json"))),
    runId: retestId,
    baselineRunId: runId,
    createdAt: new Date(createdAt.getTime() + 40_000).toISOString(),
  };
  await mkdir(join(rdir, "screenshots"), { recursive: true });
  await json(join(rdir, "config.json"), rc);
  const host = new URL(rc.targetUrl).host;
  const start = createdAt.getTime() + 40_000;
  const agents = rc.personaIds.flatMap((p) =>
    rc.seeds[p].map((seed) => ({ id: `${p}-${seed}`, p, events: simulateAgent({ runId: retestId, personaId: p, seed, host, buildSha: rc.posthog.buildSha, traps: ["T3", "T4", "T5"], start }).events })),
  );
  const t = (e: PostHogEvent) => Date.parse(e.timestamp);
  const t0 = Math.min(...agents.map((x) => t(x.events[0])));
  const t1 = Math.max(...agents.map((x) => t(x.events.at(-1)!)));
  const cutAt = t0 + (t1 - t0) * cut;
  const lag = 4_000 * ((t1 - t0) / 30_000); // the offline runner's ingestion lag, in simulated time
  const index: Record<string, { step?: string; at: string; n: number }> = {};
  const seen: PostHogEvent[] = [];
  for (const x of agents) {
    const shown = x.events.filter((e) => t(e) <= cutAt);
    seen.push(...x.events.filter((e) => t(e) <= cutAt - lag));
    const views = shown.filter((e) => e.event === "$pageview");
    const last = views.at(-1);
    if (!last) continue;
    const step = resolveStep(flow, String(last.properties.$current_url));
    await cp(join(SHOTS, x.p, `${SHOT[step ?? "Home"] ?? "home"}.png`), join(rdir, "screenshots", `${x.id}.png`));
    index[x.id] = { step, at: last.timestamp, n: views.length };
  }
  await json(join(rdir, "screenshots", "index.json"), index);
  seen.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await writeFile(join(rdir, "posthog.jsonl"), seen.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const n = agents.length;
  const sandboxes = Array.from({ length: 5 }, (_, i) => {
    const ids = agents.filter((_, k) => k % 5 === i).map((x) => x.id);
    return { id: `offline-${retestId}-${i + 1}`, label: `sbx-${i + 1}`, region: "offline", status: "running", agentIds: ids, startedAt: rc.createdAt, costUsd: +(0.004 + 0.0025 * 3 * ids.length).toFixed(4) };
  });
  await json(join(rdir, "swarm.json"), { runId: retestId, backend: "offline", sandboxes, updatedAt: status.updatedAt });
  console.log(`  ${n} agents, ${seen.length} events ingested, ${Object.keys(index).length} screenshots`);
}

await pipelineFixture("fixture-proven", ["T1", "T2"], NOW);
await pipelineFixture("fixture-not-proven", ["T3"], new Date(NOW.getTime() - 3_600_000));
await liveFixture("fixture-live", "fixture-proven", 0.45, new Date(NOW.getTime() + 600_000));
console.log("done");
