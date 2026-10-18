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
/** "booting", "started" (the daemon was exec'd) or "failed: ..." (see bootstrapScript). */
export const BOOT_STATUS_FILE = `${HOME}/bootstrap.status`;
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
export const AUTOSTART_FORWARDED_ENV = [...FORWARDED_ENV, "TENKI_API_KEY", "TENKI_AUTH_TOKEN", "TENKI_SNAPSHOT_ID", "ORCHESTRATOR_IDLE_EXIT_MS", "ORCHESTRATOR_DEADLINE", "ORCHESTRATOR_DRAIN_MS"];

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
 * Everything runs inside the sandbox, detached from whoever started it. A failed
 * step leaves "failed: ..." in BOOT_STATUS_FILE, which the launcher reads to
 * close the sandbox (checkBoot). */
export function bootstrapScript(o: { repoUrl: string; ref: string }): string {
  const tokenUrl = o.repoUrl.replace(/^https:\/\//, "https://x-access-token:${GITHUB_TOKEN}@");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `echo booting > ${BOOT_STATUS_FILE}`,
    `trap 'rc=$?; echo "failed: exit $rc at line $LINENO" > ${BOOT_STATUS_FILE}' ERR`,
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
    `echo started > ${BOOT_STATUS_FILE}`,
    "trap - ERR",
    "exec npm run orchestrator",
    "",
  ].join("\n");
}

// ------------------------------------------------------------ launch lock

/** In the store next to the heartbeat. One launch at a time across functions:
 * every write that claims it is a compare-and-set (RunStore.putJsonIf). */
export type LaunchRecord = {
  nonce: string;
  reason: string;
  /** closing: the daemon is closing its own sandbox (idle or near its time
   * limit). If that close failed, the launcher closes it. */
  state: "launching" | "booting" | "closing" | "failed";
  requestedAt: string;
  updatedAt: string;
  /** The sandbox this record owns: set while it may still be running (and
   * after a failure whose close didn't go through), so it can be closed. */
  sandboxId?: string;
  error?: string;
  /** Launches that failed in a row, for the retry backoff. */
  failures?: number;
};

/** A sandbox that hasn't sent a heartbeat this long after launch is presumed dead. */
export const BOOT_GRACE_MS = 20 * 60_000;
/** A sandbox whose daemon was online and then stopped beating this long is presumed dead. */
export const STALLED_MS = 3 * 60_000;
/** After a failed launch, wait this long before trying again; doubles per failure in a row. */
export const FAILED_RETRY_MS = 5 * 60_000;
export const MAX_FAILED_RETRY_MS = 60 * 60_000;

export const failedRetryMs = (failures = 1) => Math.min(FAILED_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_FAILED_RETRY_MS);

export type LaunchDecision = { launch: true } | { launch: false; why: "online" | "booting" | "failed-recently" };

export function launchDecision(hb: OrchestratorHeartbeat | undefined, lock: LaunchRecord | undefined, now: number): LaunchDecision {
  if (isOnline(hb, now)) return { launch: false, why: "online" };
  if (!lock || lock.state === "closing") return { launch: true };
  const age = now - Date.parse(lock.updatedAt);
  if (lock.state === "failed") return age < failedRetryMs(lock.failures) ? { launch: false, why: "failed-recently" } : { launch: true };
  // Its daemon came up: the record's age says nothing any more (nothing
  // refreshes it), only how long the heartbeat has been quiet.
  if (hb?.sandboxId && hb.sandboxId === lock.sandboxId && Date.parse(hb.lastSeenAt) >= Date.parse(lock.updatedAt))
    return now - Date.parse(hb.lastSeenAt) < STALLED_MS ? { launch: false, why: "booting" } : { launch: true };
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
  nonce?: () => string;
};

export type LaunchResult =
  | { state: "online" | "booting" | "failed-recently" | "idle" }
  | { state: "unconfigured"; missing: string[] }
  | { state: "lost-race" }
  | { state: "launched"; sandboxId: string }
  | { state: "failed"; error: string };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
/** Log lines can carry a clone URL with a token in it. */
const redact = (s: string) => s.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");

/** Whether a booting sandbox will never come online: its bootstrap failed (it
 * is then closed) or it already ended. Throws when the sandbox can't be asked. */
export async function checkBoot(client: SandboxClient, sandboxId: string): Promise<{ error: string; closed: boolean } | undefined> {
  const s = await client.get(sandboxId).catch(() => undefined);
  if (!s || TERMINAL_STATES.has(s.state)) return { error: `sandbox ${sandboxId} ended before the orchestrator came online`, closed: true };
  const status = decode((await s.exec(["bash", "-c", `cat ${BOOT_STATUS_FILE} 2>/dev/null || true`], { cwd: HOME, timeoutMs: 30_000 })).stdout).trim();
  if (!status.startsWith("failed")) return undefined;
  const tail = await s
    .exec(["tail", "-n", "15", LOG_FILE], { cwd: HOME, timeoutMs: 30_000 })
    .then((r) => decode(r.stdout).trim(), () => "");
  const closed = await s.closeIfOpen().then(() => true, () => false);
  return { error: redact(`bootstrap ${status}${tail ? `\n${tail}` : ""}`).slice(-1500), closed };
}

/**
 * Starts a sandboxed orchestrator when there is queued work and none is running
 * or booting. Safe to call often: the heartbeat and the launch record decide.
 * It also cleans up: a booting sandbox whose bootstrap failed, and a dead or
 * closing one, are closed even with nothing queued.
 */
export async function launchOrchestrator(deps: LaunchDeps, reason: string, opts: { requireQueue?: boolean } = {}): Promise<LaunchResult> {
  const { store, env } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const stamp = () => new Date(now()).toISOString();

  const [hb, current, queue] = await Promise.all([
    store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat).catch(() => undefined),
    store.getJsonVersioned<LaunchRecord>(KEYS.launch),
    store.list(KEYS.queue),
  ]);
  const lock = current.value;
  const decision = launchDecision(hb, lock, now());
  const missing = missingLaunchEnv(env);
  const wanted = !(opts.requireQueue ?? true) || queue.length > 0;
  // Not launching: still check a booting sandbox, and close one a failed launch left behind.
  const check = !decision.launch && !!lock?.sandboxId && (decision.why === "booting" || lock.state === "failed");
  if (!decision.launch && !check) return { state: decision.why };
  if (decision.launch && !wanted && !lock?.sandboxId) return { state: "idle" };
  if (missing.length) return { state: "unconfigured", missing };

  let client: SandboxClient | undefined;
  let session: SandboxSession | undefined;
  /** The earlier sandbox while it may still be running. */
  let earlier = lock?.sandboxId;
  // Every write below is conditional on the record we read: whoever loses a
  // race (another launcher, the watch) backs off.
  let version = current.version;
  const claim = async (rec: LaunchRecord) => {
    if (!(await store.putJsonIf(KEYS.launch, rec, version))) return false;
    version = (await store.getJsonVersioned<LaunchRecord>(KEYS.launch)).version;
    return true;
  };
  const failures = (lock?.state === "failed" ? (lock.failures ?? 1) : 0) + 1;
  const mine: LaunchRecord = {
    nonce: (deps.nonce ?? (() => Math.random().toString(36).slice(2)))(),
    reason,
    state: "launching",
    requestedAt: stamp(),
    updatedAt: stamp(),
  };

  try {
    client = await (deps.client ?? (() => tenkiClient(env)))();

    if (!decision.launch) {
      const { sandboxId } = lock!;
      if (lock!.state === "failed") {
        // Left running by a failed launch whose close didn't go through.
        const old = await client.get(sandboxId!).catch(() => undefined);
        const closed = !old || TERMINAL_STATES.has(old.state) || (await old.closeIfOpen().then(() => true, () => false));
        if (closed) {
          const rec: LaunchRecord = { ...lock! };
          delete rec.sandboxId;
          await claim(rec);
        }
        return { state: decision.why };
      }
      // Booting: has its bootstrap failed? A sandbox we can't reach right now is left alone.
      const boot = await checkBoot(client, sandboxId!).catch((e) => void log(`could not check sandbox ${sandboxId}: ${errMsg(e)}`));
      if (!boot) return { state: "booting" };
      log(`sandbox ${sandboxId} failed to boot: ${boot.error}`);
      const rec: LaunchRecord = { ...lock!, state: "failed", error: boot.error, failures, updatedAt: stamp() };
      if (boot.closed) delete rec.sandboxId;
      if (!(await claim(rec))) return { state: "lost-race" };
      return { state: "failed", error: boot.error };
    }

    // Claim the launch before touching any sandbox.
    if (!(await claim(mine))) return { state: "lost-race" };

    // A previous sandbox that never came up, stalled, or failed to close itself still bills: close it.
    if (lock?.sandboxId) {
      const old = await client.get(lock.sandboxId).catch(() => undefined);
      if (old && !TERMINAL_STATES.has(old.state)) {
        log(`closing stale sandbox ${lock.sandboxId} (${old.state}, record ${lock.state})`);
        await old.closeIfOpen();
      }
      earlier = undefined;
    }
    if (!wanted) {
      await store.delete(KEYS.launch);
      return { state: "idle" };
    }

    const ref = env.ORCHESTRATOR_REF || "main";
    const repoUrl = env.TENKI_REPO_URL || PUBLIC_REPO;
    const hours = Number(env.TENKI_MAX_HOURS || 3);
    const snapshotId = env.TENKI_CHROME_SNAPSHOT_ID || undefined;
    log(`creating sandbox (${ref}, max ${hours} h)`);
    const createdAt = now();
    session = await client.create({
      name: SANDBOX_NAME,
      cpuCores: 4,
      memoryMb: 8192,
      diskSizeGb: 20,
      maxDurationMs: hours * 3_600_000,
      ...(snapshotId ? { snapshotId } : {}),
      tags: ["frictionswarm", "orchestrator", "autostart"],
      metadata: { repo: repoUrl, ref, reason },
    });
    if (!(await claim({ ...mine, state: "booting", sandboxId: session.id, updatedAt: stamp() }))) throw new Error("launch record changed while creating the sandbox");
    const deadline = session.timeoutAt?.getTime() ?? createdAt + hours * 3_600_000;
    const vars = daemonEnv(
      {
        ...env,
        ORCHESTRATOR_IDLE_EXIT_MS: env.ORCHESTRATOR_IDLE_EXIT_MS || String(30 * 60_000),
        ORCHESTRATOR_DEADLINE: new Date(deadline).toISOString(),
      },
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
    if (r.exitCode !== 0) throw new Error(`bootstrap did not start (exit ${r.exitCode}): ${decode(r.stderr).slice(-500)}`);
    log(`sandbox ${session.id} booting; logs in ${LOG_FILE}`);
    return { state: "launched", sandboxId: session.id };
  } catch (e) {
    const error = errMsg(e);
    // Close what we created; if that fails too, keep its id so the next launch closes it.
    const closed = session ? await session.closeIfOpen().then(() => true, () => false) : true;
    const orphan = !closed ? session!.id : earlier;
    const rec: LaunchRecord = { ...(decision.launch ? mine : lock!), state: "failed", error, failures, updatedAt: stamp(), ...(orphan ? { sandboxId: orphan } : {}) };
    if (!orphan) delete rec.sandboxId;
    await claim(rec).catch((we) => log(`could not record the failure: ${errMsg(we)}`));
    log(`launch failed: ${error}${orphan ? ` (sandbox ${orphan} may still be running)` : ""}`);
    return { state: "failed", error };
  } finally {
    await client?.close();
  }
}

// ------------------------------------------------------------ Netlify wiring

/** The background function in netlify/functions/orchestrator-launch.mts. */
export const LAUNCH_PATH = "/.netlify/functions/orchestrator-launch";
export const LAUNCH_HEADER = "x-frictionswarm-launch";
/** The launcher's shared secret: the one that signs the login cookie. */
export const launchSecret = (env: Env = process.env) => env.AUTH_SECRET || env.DASHBOARD_PASSWORD || "";
