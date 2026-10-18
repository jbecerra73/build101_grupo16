// The offline re-test swarm: a stand-in for P2's tenki swarm that needs no
// browser, no model and no network. It simulates each agent with the
// posthog-sim generator (the same code as `npm run posthog:generate -- --swarm`),
// on the store as it would be after the fix (the traps the fix targeted are
// removed), and plays the result out in real time:
//   - runs/<runId>/screenshots/<agentId>.png  follows each agent from page to
//     page, using the real storefront captures in apps/dashboard/scripts/shots
//     (screenshots/index.json says which step each one shows)
//   - data/posthog/swarm-<runId>.jsonl        receives the agents' PostHog
//     events, `ingestLagMs` after the agent "did" them, like PostHog ingestion,
//     so the pipeline's collecting phase (source.waitForSwarm) has something to wait for
//   - runs/<runId>/swarm.json                 simulated sandboxes for the monitor
// The runner resolves once every agent has finished on screen; the events keep
// landing for another `ingestLagMs` (see `ingested`).
import { appendFile, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FLOWS, PERSONAS, type Finding, type FixResult, type PostHogEvent, type RunConfig } from "@frictionswarm/shared";
import {
  mulberry32,
  PERSONA_PROFILES,
  RELEASES,
  simulateSession,
  SWARM_INTENTS,
  type TrapId,
  type Visitor,
} from "../../../tools/posthog-sim/sim";
import { resolveStep } from "@frictionswarm/shared";
import { readJson, REPO_ROOT, runsDir as defaultRunsDir, writeJson } from "./runs";
import { sandboxCount, type SandboxInfo, type SwarmRunner, type SwarmTopology } from "./swarm";
import { trapsOf } from "./traps";

export type OfflineSwarmOptions = {
  runsDir?: string;
  /** Where the file PostHog source reads swarm-<runId>.jsonl. Default POSTHOG_DATA_DIR or <repo>/data/posthog. */
  dataDir?: string;
  /** Real storefront captures: <shotsDir>/<personaId>/<page>.png. */
  shotsDir?: string;
  /** Wall time from the first agent's first page to the last agent's end. Default 30 s. */
  durationMs?: number;
  /** Delay between an agent's action and its event landing in the file. Default 4 s. */
  ingestLagMs?: number;
  /** Simulated sandbox boot time (staggered per sandbox). Default 1.2 s. */
  bootMs?: number;
  tickMs?: number;
  signal?: AbortSignal;
  /** Traps removed on the preview. Default: from the baseline run's fix.json (the
   * findings of the attempt that launched this retest, mapped by traps.ts). */
  fixedTraps?: (config: RunConfig) => Promise<TrapId[]>;
};

/** Fake cost model for the swarm monitor: sandbox time + one Haiku call per action. */
export const OFFLINE_COST = { sandboxUsdPerSecond: 0.00012, usdPerAction: 0.0025 };

export const defaultDataDir = () => process.env.POSTHOG_DATA_DIR || join(REPO_ROOT, "data", "posthog");
export const swarmFile = (dataDir: string, runId: string) => join(dataDir, `swarm-${runId}.jsonl`);

/** Funnel step → storefront capture name in apps/dashboard/scripts/shots/<persona>/. */
const SHOT: Record<string, string> = {
  Home: "home",
  Browse: "shop",
  Product: "product",
  Cart: "cart",
  Account: "account",
  Shipping: "checkout",
  Payment: "payment",
  "Payment failed": "payment",
  Confirmation: "success",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = new Map<string, Promise<void>>();

/** Resolves when every event of an offline swarm run has landed in its file. */
export const ingested = (runId: string) => pending.get(runId) ?? Promise.resolve();

/** The traps fixed on this retest's preview, read from the baseline's fix.json. */
export async function fixedTrapsFromFix(runsDir: string, config: RunConfig): Promise<TrapId[]> {
  if (!config.baselineRunId) return [];
  const base = join(runsDir, config.baselineRunId);
  const fix = await readJson<FixResult>(join(base, "fix.json"));
  const attempt = fix?.attempts.find((a) => a.retestRunId === config.runId) ?? fix?.attempts.at(-1);
  const findings = (await readJson<Finding[]>(join(base, "findings.json"))) ?? [];
  return trapsOf(findings.filter((f) => attempt?.findingIds.includes(f.id)));
}

/** One agent's simulated session on the preview (deterministic per persona + seed). */
export function simulateAgent(o: { runId: string; personaId: string; seed: number; host: string; buildSha: string; traps: TrapId[]; start: number; flowId?: string }) {
  const persona = PERSONAS[o.personaId];
  if (!persona) throw new Error(`Unknown persona "${o.personaId}"`);
  const agent = `${o.personaId}-${o.seed}`;
  const rng = mulberry32(o.seed * 7919 + o.personaId.charCodeAt(0));
  const visitor: Visitor = {
    distinctId: `swarm:${agent}`,
    device: persona.viewport.mobile ? "Mobile" : "Desktop",
    os: persona.viewport.mobile ? "iOS" : "Linux",
    browser: persona.viewport.mobile ? "Mobile Safari" : "Chrome",
    viewport: [persona.viewport.width, persona.viewport.height],
    fontScale: 1,
    prefersContrast: false,
  };
  return simulateSession({
    rng,
    start: o.start + Math.floor(rng() * 20_000),
    visitor,
    host: o.host,
    buildSha: o.buildSha,
    traps: o.traps,
    profile: PERSONA_PROFILES[o.personaId],
    swarm: { run: o.runId, agent, persona: o.personaId },
    intent: SWARM_INTENTS[o.flowId ?? "buy-tshirt"],
    promoCodes: true,
  });
}

type Agent = { agentId: string; personaId: string; events: PostHogEvent[]; shown: number; ingested: number; done: boolean };

export function offlineSwarmRunner(opts: OfflineSwarmOptions = {}): SwarmRunner {
  return async (config) => {
    const runsDir = opts.runsDir ?? defaultRunsDir();
    const dataDir = opts.dataDir ?? defaultDataDir();
    const shotsDir = opts.shotsDir ?? (process.env.SWARM_SHOTS_DIR || join(REPO_ROOT, "apps", "dashboard", "scripts", "shots"));
    const duration = opts.durationMs ?? 30_000;
    const lag = opts.ingestLagMs ?? 4_000;
    const tickMs = opts.tickMs ?? 250;
    const flow = FLOWS[config.flowId];
    const out = join(/*turbopackIgnore: true*/ runsDir, config.runId);
    const file = swarmFile(dataDir, config.runId);

    const fixed = await (opts.fixedTraps ?? ((c) => fixedTrapsFromFix(runsDir, c)))(config);
    const traps = RELEASES.at(-1)!.traps.filter((t) => !fixed.includes(t));
    const host = new URL(config.targetUrl).host;
    const simStart = Date.now();

    const agents: Agent[] = config.personaIds.flatMap((personaId) =>
      (config.seeds[personaId] ?? []).map((seed) => ({
        agentId: `${personaId}-${seed}`,
        personaId,
        events: simulateAgent({ runId: config.runId, personaId, seed, host, buildSha: config.posthog.buildSha, traps, start: simStart, flowId: config.flowId }).events,
        shown: 0,
        ingested: 0,
        done: false,
      })),
    );
    if (!agents.length) throw new Error("Retest has no agents (personaIds × seeds is empty)");

    // Simulated time → wall time: the whole swarm fits in `duration`.
    const ts = (e: PostHogEvent) => Date.parse(e.timestamp);
    const t0 = Math.min(...agents.map((a) => ts(a.events[0])));
    const span = Math.max(1, Math.max(...agents.map((a) => ts(a.events.at(-1)!))) - t0);
    const scale = duration / span;

    await rm(file, { force: true });
    await mkdir(dirname(file), { recursive: true });
    await rm(join(out, "screenshots"), { recursive: true, force: true });
    await mkdir(join(out, "screenshots"), { recursive: true });

    // swarm.json: agents spread over simulated sandboxes (≤ 6 each), each booting for a moment.
    const started = Date.now();
    const nSbx = sandboxCount(agents.length);
    const bootMs = opts.bootMs ?? 1200;
    const sbx = Array.from({ length: nSbx }, (_, i) => ({
      info: {
        id: `offline-${config.runId}-${i + 1}`,
        label: `sbx-${i + 1}`,
        region: "offline",
        status: "booting",
        agentIds: [],
        startedAt: new Date(started).toISOString(),
        costUsd: 0,
      } as SandboxInfo,
      boot: bootMs * (1 + 0.35 * i),
      agents: [] as Agent[],
      actions: 0,
    }));
    agents.forEach((a, i) => {
      sbx[i % nSbx].agents.push(a);
      sbx[i % nSbx].info.agentIds.push(a.agentId);
    });
    let lastTopo = "";
    const writeTopology = async () => {
      const now = Date.now();
      for (const s of sbx) {
        const end = s.info.endedAt ? Date.parse(s.info.endedAt) : now;
        s.info.costUsd = +(((end - started) / 1000) * OFFLINE_COST.sandboxUsdPerSecond + s.actions * OFFLINE_COST.usdPerAction).toFixed(4);
      }
      const topo: SwarmTopology = { runId: config.runId, backend: "offline", sandboxes: sbx.map((s) => s.info), updatedAt: new Date(now).toISOString() };
      const key = JSON.stringify(topo.sandboxes);
      if (key === lastTopo) return;
      lastTopo = key;
      await writeJson(join(out, "swarm.json"), topo);
    };
    await writeTopology();

    const wallOf = (s: (typeof sbx)[number], e: PostHogEvent) => started + s.boot + (ts(e) - t0) * scale;
    // screenshots/index.json: which step each screenshot shows, so the live grid
    // is current before PostHog has the events (see ScreenshotIndex in the dashboard).
    const index: Record<string, { step?: string; at: string; n: number }> = {};
    let indexDirty = false;
    const shoot = async (a: Agent, e: PostHogEvent) => {
      const step = resolveStep(flow, String(e.properties.$current_url ?? "/"));
      const name = step && SHOT[step];
      if (!name) return;
      await copyFile(join(shotsDir, a.personaId, `${name}.png`), join(out, "screenshots", `${a.agentId}.png`)).catch(() => {});
      index[a.agentId] = { step, at: new Date().toISOString(), n: (index[a.agentId]?.n ?? 0) + 1 };
      indexDirty = true;
    };

    // Agents on screen (screenshots), then events into the file `lag` later.
    let flushing: Promise<void> | undefined;
    const flush = async (final: boolean) => {
      const now = Date.now();
      const due: PostHogEvent[] = [];
      for (const s of sbx)
        for (const a of s.agents)
          while (a.ingested < a.events.length && (final || wallOf(s, a.events[a.ingested]) + lag <= now)) due.push(a.events[a.ingested++]);
      if (due.length) await appendFile(file, due.sort((x, y) => x.timestamp.localeCompare(y.timestamp)).map((e) => JSON.stringify(e) + "\n").join(""));
    };

    while (agents.some((a) => !a.done)) {
      if (opts.signal?.aborted) {
        for (const s of sbx) if (s.info.status !== "done") Object.assign(s.info, { status: "closed", endedAt: new Date().toISOString() });
        await writeTopology();
        throw new Error("cancelled");
      }
      const now = Date.now();
      for (const s of sbx) {
        if (now < started + s.boot) continue;
        if (s.info.status === "booting") s.info.status = "running";
        for (const a of s.agents) {
          let page: PostHogEvent | undefined;
          while (a.shown < a.events.length && wallOf(s, a.events[a.shown]) <= now) {
            const e = a.events[a.shown++];
            if (e.event === "$pageview") page = e;
            if (e.event === "$autocapture") s.actions++;
          }
          if (page) await shoot(a, page);
          if (a.shown >= a.events.length) a.done = true;
        }
        if (s.info.status === "running" && s.agents.every((a) => a.done)) Object.assign(s.info, { status: "done", endedAt: new Date().toISOString() });
      }
      if (indexDirty) {
        indexDirty = false;
        await writeJson(join(out, "screenshots", "index.json"), index);
      }
      await flush(false);
      await writeTopology();
      if (agents.some((a) => !a.done)) await sleep(tickMs);
    }

    // PostHog "ingestion" catches up after the agents are done.
    flushing = (async () => {
      const end = Date.now() + lag;
      while (Date.now() < end && !opts.signal?.aborted) {
        await sleep(Math.min(tickMs, Math.max(1, end - Date.now())));
        await flush(false);
      }
      await flush(true);
    })();
    pending.set(config.runId, flushing);
    flushing.finally(() => pending.delete(config.runId)).catch(() => {});
  };
}
