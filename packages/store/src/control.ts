// Store keys and helpers for the control-center contract. The types themselves
// live in apps/dashboard/lib/control-types.ts (the contract with the UI); they
// are re-exported here so the orchestrator and the dashboard share one source.
import type {
  CancelRequest,
  OrchestratorHeartbeat,
  QueuedRun,
  SandboxInfo,
  SandboxStatus,
  Settings,
  SwarmBackendKind,
  SwarmTopology,
} from "../../../apps/dashboard/lib/control-types";
import type { RunStore } from "./types";

export type {
  CancelRequest,
  OrchestratorHeartbeat,
  QueuedRun,
  SandboxInfo,
  SandboxStatus,
  Settings,
  SwarmBackendKind,
  SwarmTopology,
};

export const KEYS = {
  settings: "settings.json",
  heartbeat: "orchestrator.json",
  /** The autostart's launch record (launch.ts). */
  launch: "orchestrator-launch.json",
  usage: "usage.json",
  queue: "queue/",
  queued: (requestId: string) => `queue/${requestId}.json`,
  run: (runId: string) => `runs/${runId}/`,
  runFile: (runId: string, rel: string) => `runs/${runId}/${rel}`,
  cancel: (runId: string) => `runs/${runId}/cancel.json`,
  swarm: (runId: string) => `runs/${runId}/swarm.json`,
} as const;

/** A heartbeat older than this means the orchestrator is offline. */
export const HEARTBEAT_STALE_MS = 20_000;
export const HEARTBEAT_EVERY_MS = 5_000;

export const isOnline = (hb: OrchestratorHeartbeat | undefined, now = Date.now()) =>
  !!hb && now - Date.parse(hb.lastSeenAt) <= HEARTBEAT_STALE_MS;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isValidRunId = (id: string) => RUN_ID.test(id) && !id.includes("..") && id.length <= 128;

// ---------------------------------------------------------------- settings

type Env = Record<string, string | undefined>;

/** Defaults for settings.json when it does not exist, from env (SWARM_RUNNER,
 * FIX_LOOP, SWARM_SPEED, MAX_RUNS_PER_DAY, DEFAULT_SEEDS_PER_PERSONA). */
export function defaultSettings(env: Env = process.env): Settings {
  const swarmRunner: SwarmBackendKind = env.SWARM_RUNNER === "tenki" || env.SWARM_RUNNER === "p2" ? "tenki" : "offline";
  const speed = Number(env.SWARM_SPEED ?? 1);
  const max = Number(env.MAX_RUNS_PER_DAY ?? 10);
  const seeds = Number(env.DEFAULT_SEEDS_PER_PERSONA ?? 10);
  return {
    swarmRunner,
    fixLoop: env.FIX_LOOP === "real" || env.FIX_LOOP === "fake" ? env.FIX_LOOP : swarmRunner === "offline" ? "fake" : "real",
    swarmSpeed: Number.isFinite(speed) && speed > 0 ? speed : 1,
    maxRunsPerDay: Number.isInteger(max) && max >= 0 ? max : 10,
    defaultSeedsPerPersona: Number.isInteger(seeds) && seeds >= 1 && seeds <= 10 ? seeds : 10,
  };
}

export const SETTINGS_LIMITS = {
  swarmSpeed: [0.1, 20],
  maxRunsPerDay: [0, 200],
  defaultSeedsPerPersona: [1, 10],
} as const;

/** Validates a (partial) settings update on top of `base`. Unknown keys are errors. */
export function parseSettings(
  body: unknown,
  base: Settings,
): { ok: true; value: Settings } | { ok: false; errors: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be a JSON object"] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const out: Settings = { ...base };
  for (const [k, v] of Object.entries(b)) {
    switch (k) {
      case "swarmRunner":
        if (v === "offline" || v === "tenki") out.swarmRunner = v;
        else if (v === "replay") out.swarmRunner = "offline"; // pre-PostHog name
        else errors.push("swarmRunner must be offline or tenki");
        break;
      case "fixLoop":
        if (v === "fake" || v === "real") out.fixLoop = v;
        else errors.push("fixLoop must be fake or real");
        break;
      case "verifyBuild":
      case "replaySpeed":
        break; // retired settings an old settings.json may still carry
      case "swarmSpeed": {
        const [lo, hi] = SETTINGS_LIMITS.swarmSpeed;
        if (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi) out.swarmSpeed = v;
        else errors.push(`swarmSpeed must be a number from ${lo} to ${hi}`);
        break;
      }
      case "maxRunsPerDay":
      case "defaultSeedsPerPersona": {
        const [lo, hi] = SETTINGS_LIMITS[k];
        if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
        else errors.push(`${k} must be an integer from ${lo} to ${hi}`);
        break;
      }
      default:
        errors.push(`Unknown setting "${k}"`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/** settings.json merged over the env defaults (a stored file may predate a new field). */
export async function readSettings(store: RunStore, env: Env = process.env): Promise<Settings> {
  const base = defaultSettings(env);
  const stored = await store.getJson<Partial<Settings>>(KEYS.settings);
  if (!stored) return base;
  const parsed = parseSettings(stored, base);
  return parsed.ok ? parsed.value : base;
}

// ---------------------------------------------------------------- usage

/** usage.json: the runs-per-day cap ({ date, runs }) plus the global seed counter. */
export type Usage = { date: string; runs: number; nextSeed?: number };
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export async function readUsage(store: RunStore, now = new Date()): Promise<Usage> {
  const u = await store.getJson<Usage>(KEYS.usage);
  const date = today(now);
  if (!u || typeof u.runs !== "number") return { date, runs: 0, nextSeed: u?.nextSeed };
  return u.date === date ? u : { date, runs: 0, nextSeed: u.nextSeed };
}
