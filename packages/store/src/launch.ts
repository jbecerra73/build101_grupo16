// Boots the orchestrator daemon in a tenki sandbox on demand, so the deployed
// dashboard needs nobody to run `npm run orchestrator:tenki -- up`. Netlify
// calls this from a background function (netlify/functions/) when a run is
// queued and no heartbeat is fresh. The function only creates the sandbox and
// starts a detached bootstrap script (clone, npm ci, posthog:generate, then
// the daemon), so it returns in seconds; the daemon's first heartbeat flips the
// dashboard to online a few minutes later. With ORCHESTRATOR_IDLE_EXIT_MS the
// daemon closes its own sandbox once the queue has been empty that long.
import { isOnline, KEYS, type OrchestratorHeartbeat } from "./control";
import type { RunStore } from "./types";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

// ------------------------------------------------------------ SDK surface

/** What we use of a tenki Session (@tenkicloud/sandbox), so tests can fake it. */
export interface SandboxSession {
  readonly id: string;
  state: string;
  exec(
    command: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; status: string; stdout: Uint8Array; stderr: Uint8Array }>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  refresh(): Promise<void>;
  /** Terminates the sandbox (tenki bills failed sessions too). */
  closeIfOpen(): Promise<void>;
  timeoutAt?: Date;
}

/** What we use of TenkiSandbox. */
export interface SandboxClient {
  create(options: {
    name: string;
    cpuCores: number;
    memoryMb: number;
    diskSizeGb: number;
    maxDurationMs: number;
    snapshotId?: string;
    tags?: string[];
    metadata?: Record<string, string>;
  }): Promise<SandboxSession>;
  get(sessionId: string): Promise<SandboxSession>;
  /** Releases the client's connections (the SDK's TenkiSandbox.close). */
  close(): void | Promise<void>;
}

export async function tenkiClient(env: Env): Promise<SandboxClient> {
  const authToken = env.TENKI_API_KEY || env.TENKI_AUTH_TOKEN;
  if (!authToken) throw new Error("TENKI_API_KEY is not set");
  const { TenkiSandbox } = await import("@tenkicloud/sandbox");
  return new TenkiSandbox({ authToken }) as unknown as SandboxClient;
}

// ------------------------------------------------------------ sandbox layout

export const HOME = "/home/tenki";
export const REPO_DIR = `${HOME}/repo`;
export const ENV_FILE = `${HOME}/orchestrator.env`;
export const START_SCRIPT = `${HOME}/start-orchestrator.sh`;
export const LOG_FILE = `${HOME}/orchestrator.log`;
export const PID_FILE = `${HOME}/orchestrator.pid`;
export const WORK_DIR = `${HOME}/work`;
export const SANDBOX_NAME = "frictionswarm-orchestrator";
export const PUBLIC_REPO = "https://github.com/jbecerra73/build101_grupo16.git";
export const TERMINAL_STATES = new Set(["TERMINATED", "TERMINATING", "USER_SHUTDOWN"]);

/** Env forwarded into the sandbox's env file when set. */
export const FORWARDED_ENV = [
  "NETLIFY_BLOBS_STORE",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "POSTHOG_SOURCE",
  "POSTHOG_HOST",
  "POSTHOG_APP_HOST",
  "POSTHOG_PROJECT_ID",
  "POSTHOG_PROJECT_KEY",
  "POSTHOG_PERSONAL_API_KEY",
  "PRODUCTION_BUILD_SHA",
  "SWARM_RUNNER",
  "SWARM_SPEED",
  "FIX_LOOP",
  "FIX_STAGE_DELAY_MS",
  "MAX_RUNS_PER_DAY",
  "DEFAULT_SEEDS_PER_PERSONA",
  "ORCHESTRATOR_MAX_CONCURRENT",
  "GITHUB_TOKEN",
];

/** Also forwarded by the autostart: the tenki swarm and the real fix loop open
 * sandboxes of their own, and the daemon closes its sandbox when idle. */
export const AUTOSTART_FORWARDED_ENV = [...FORWARDED_ENV, "TENKI_API_KEY", "TENKI_AUTH_TOKEN", "TENKI_SNAPSHOT_ID", "ORCHESTRATOR_IDLE_EXIT_MS"];

/** Single-quoted for bash. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function envFile(vars: Record<string, string>): string {
  const lines = ["# Written by the orchestrator launcher. Secrets: keep 0600."];
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`);
    lines.push(`export ${k}=${shq(v)}`);
  }
  return lines.join("\n") + "\n";
}

/** The daemon's env inside the sandbox. */
export function daemonEnv(env: Env, o: { sandboxId: string; version: string; forwarded?: string[] }): Record<string, string> {
  const vars: Record<string, string> = {
    RUN_STORE: "blobs",
    NETLIFY_SITE_ID: env.NETLIFY_SITE_ID || env.SITE_ID || "",
    NETLIFY_AUTH_TOKEN: env.NETLIFY_AUTH_TOKEN ?? "",
    ORCHESTRATOR_HOST: "tenki",
    TENKI_SANDBOX_ID: o.sandboxId,
    ORCHESTRATOR_VERSION: o.version,
    ORCHESTRATOR_WORK_DIR: WORK_DIR,
    POSTHOG_DATA_DIR: `${REPO_DIR}/data/posthog`,
    SWARM_SHOTS_DIR: `${REPO_DIR}/apps/dashboard/scripts/shots`,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  };
  for (const k of o.forwarded ?? FORWARDED_ENV) if (env[k] && !(k in vars)) vars[k] = env[k]!;
  return vars;
}

/** Clone, install, generate the file source's history, then exec the daemon.
 * Everything runs inside the sandbox, detached from whoever started it. */
export function bootstrapScript(o: { repoUrl: string; ref: string }): string {
  const tokenUrl = o.repoUrl.replace(/^https:\/\//, "https://x-access-token:${GITHUB_TOKEN}@");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "set -a",
    `. ${ENV_FILE}`,
    "set +a",
    'echo "[bootstrap] $(date -u +%FT%TZ) cloning"',
    `rm -rf ${REPO_DIR}`,
    `if [ -n "\${GITHUB_TOKEN:-}" ]; then git clone --depth 1 --branch ${shq(o.ref)} "${tokenUrl}" ${REPO_DIR}; ` +
      `else git clone --depth 1 --branch ${shq(o.ref)} ${shq(o.repoUrl)} ${REPO_DIR}; fi`,
    `git -C ${REPO_DIR} remote set-url origin ${shq(o.repoUrl)}`,
    `cd ${REPO_DIR}`,
    'echo "[bootstrap] $(date -u +%FT%TZ) npm ci"',
    "NEXT_TELEMETRY_DISABLED=1 npm ci --no-audit --no-fund",
    'echo "[bootstrap] $(date -u +%FT%TZ) posthog:generate"',
    "npm run posthog:generate",
    `mkdir -p ${WORK_DIR}`,
    'echo "[bootstrap] $(date -u +%FT%TZ) starting the orchestrator"',
    "exec npm run orchestrator",
    "",
  ].join("\n");
}

// ------------------------------------------------------------ launch lock

/** In the store next to the heartbeat. One launch at a time across functions. */
export type LaunchRecord = {
  nonce: string;
  reason: string;
  state: "launching" | "booting" | "failed";
  requestedAt: string;
  updatedAt: string;
  sandboxId?: string;
  error?: string;
};

/** A sandbox that hasn't sent a heartbeat this long after launch is presumed dead. */
export const BOOT_GRACE_MS = 20 * 60_000;
/** After a failed launch, wait this long before trying again. */
export const FAILED_RETRY_MS = 5 * 60_000;

export type LaunchDecision = { launch: true } | { launch: false; why: "online" | "booting" | "failed-recently" };

export function launchDecision(hb: OrchestratorHeartbeat | undefined, lock: LaunchRecord | undefined, now: number): LaunchDecision {
  if (isOnline(hb, now)) return { launch: false, why: "online" };
  if (!lock) return { launch: true };
  const age = now - Date.parse(lock.updatedAt);
  if (lock.state === "failed") return age < FAILED_RETRY_MS ? { launch: false, why: "failed-recently" } : { launch: true };
  return age < BOOT_GRACE_MS ? { launch: false, why: "booting" } : { launch: true };
}

const MISSING = (env: Env) =>
  [
    !(env.TENKI_API_KEY || env.TENKI_AUTH_TOKEN) && "TENKI_API_KEY",
    !(env.NETLIFY_SITE_ID || env.SITE_ID) && "NETLIFY_SITE_ID",
    !env.NETLIFY_AUTH_TOKEN && "NETLIFY_AUTH_TOKEN",
  ].filter((x): x is string => !!x);

/** Env names the autostart needs and doesn't have. */
export const missingLaunchEnv = (env: Env) => MISSING(env);

export type LaunchDeps = {
  store: RunStore;
  env: Env;
  client?: () => Promise<SandboxClient>;
  log?: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
};

export type LaunchResult =
  | { state: "online" | "booting" | "failed-recently" | "idle" }
  | { state: "unconfigured"; missing: string[] }
  | { state: "lost-race" }
  | { state: "launched"; sandboxId: string }
  | { state: "failed"; error: string };

/**
 * Starts a sandboxed orchestrator when there is queued work and none is running
 * or booting. Safe to call often: the heartbeat and the launch record decide.
 */
export async function launchOrchestrator(deps: LaunchDeps, reason: string, opts: { requireQueue?: boolean } = {}): Promise<LaunchResult> {
  const { store, env } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const [hb, lock, queue] = await Promise.all([
    store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat).catch(() => undefined),
    store.getJson<LaunchRecord>(KEYS.launch).catch(() => undefined),
    store.list(KEYS.queue),
  ]);
  const decision = launchDecision(hb, lock, now());
  if (!decision.launch) return { state: decision.why };
  if ((opts.requireQueue ?? true) && queue.length === 0) return { state: "idle" };
  const missing = missingLaunchEnv(env);
  if (missing.length) return { state: "unconfigured", missing };

  // Claim the launch, then re-read: if another caller wrote after us, it launches.
  const stamp = new Date(now()).toISOString();
  const mine: LaunchRecord = {
    nonce: (deps.nonce ?? (() => Math.random().toString(36).slice(2)))(),
    reason,
    state: "launching",
    requestedAt: stamp,
    updatedAt: stamp,
  };
  await store.putJson(KEYS.launch, mine);
  await sleep(750);
  if ((await store.getJson<LaunchRecord>(KEYS.launch))?.nonce !== mine.nonce) return { state: "lost-race" };

  const client = await (deps.client ?? (() => tenkiClient(env)))();
  try {
    // A previous sandbox that never came up still bills: close it first.
    if (lock?.sandboxId) {
      const old = await client.get(lock.sandboxId).catch(() => undefined);
      if (old && !TERMINAL_STATES.has(old.state)) {
        log(`closing stale sandbox ${lock.sandboxId} (${old.state})`);
        await old.closeIfOpen().catch(() => {});
      }
    }
    const ref = env.ORCHESTRATOR_REF || "main";
    const repoUrl = env.TENKI_REPO_URL || PUBLIC_REPO;
    const hours = Number(env.TENKI_MAX_HOURS || 3);
    const snapshotId = env.TENKI_CHROME_SNAPSHOT_ID || undefined;
    log(`creating sandbox (${ref}, max ${hours} h)`);
    const session = await client.create({
      name: SANDBOX_NAME,
      cpuCores: 4,
      memoryMb: 8192,
      diskSizeGb: 20,
      maxDurationMs: hours * 3_600_000,
      ...(snapshotId ? { snapshotId } : {}),
      tags: ["frictionswarm", "orchestrator", "autostart"],
      metadata: { repo: repoUrl, ref, reason },
    });
    await store.putJson(KEYS.launch, { ...mine, state: "booting", sandboxId: session.id, updatedAt: new Date(now()).toISOString() } satisfies LaunchRecord);
    try {
      const vars = daemonEnv(
        { ...env, ORCHESTRATOR_IDLE_EXIT_MS: env.ORCHESTRATOR_IDLE_EXIT_MS || String(30 * 60_000) },
        { sandboxId: session.id, version: `${ref}@autostart`, forwarded: AUTOSTART_FORWARDED_ENV },
      );
      await session.writeFile(ENV_FILE, envFile(vars));
      await session.writeFile(START_SCRIPT, bootstrapScript({ repoUrl, ref }));
      // Detached: both streams redirected, or exec would wait for the daemon.
      const r = await session.exec(
        [
          "bash",
          "-c",
          `chmod 600 ${ENV_FILE} && chmod 700 ${START_SCRIPT} && setsid nohup ${START_SCRIPT} >> ${LOG_FILE} 2>&1 < /dev/null & echo $! > ${PID_FILE}`,
        ],
        { cwd: HOME, timeoutMs: 60_000 },
      );
      if (r.exitCode !== 0) throw new Error(`bootstrap did not start (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).slice(-500)}`);
    } catch (e) {
      await session.closeIfOpen().catch(() => {});
      throw e;
    }
    log(`sandbox ${session.id} booting; logs in ${LOG_FILE}`);
    return { state: "launched", sandboxId: session.id };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await store.putJson(KEYS.launch, { ...mine, state: "failed", error, updatedAt: new Date(now()).toISOString() } satisfies LaunchRecord).catch(() => {});
    log(`launch failed: ${error}`);
    return { state: "failed", error };
  } finally {
    await client.close();
  }
}

// ------------------------------------------------------------ Netlify wiring

/** The background function in netlify/functions/orchestrator-launch.mts. */
export const LAUNCH_PATH = "/.netlify/functions/orchestrator-launch";
export const LAUNCH_HEADER = "x-frictionswarm-launch";
/** The launcher's shared secret: the one that signs the login cookie. */
export const launchSecret = (env: Env = process.env) => env.AUTH_SECRET || env.DASHBOARD_PASSWORD || "";
