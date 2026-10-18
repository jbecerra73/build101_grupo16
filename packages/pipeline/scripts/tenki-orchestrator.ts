// Runs the orchestrator daemon (`npm run orchestrator`) in a tenki sandbox,
// against the same Netlify Blobs store the deployed dashboard reads. The
// sandbox exposes no ports: it polls the Blobs queue and mirrors runs back.
//
//   npm run orchestrator:tenki -- up [--ref <branch>] [--tarball] [--hours 8] [--keep-on-failure]
//   npm run orchestrator:tenki -- status
//   npm run orchestrator:tenki -- logs [-n 200] [--follow]
//   npm run orchestrator:tenki -- stop
//
// Env (shell or <repo>/.env.local): TENKI_API_KEY (the "tenki3" key; the SDK
// also accepts TENKI_AUTH_TOKEN), NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN, and
// optionally TENKI_CHROME_SNAPSHOT_ID, GITHUB_TOKEN, plus the pipeline env that
// is forwarded into the sandbox (FORWARDED_ENV in packages/store/src/launch.ts). See docs/DEPLOY.md.
//
// Status: unit-tested with a mocked SDK; untested against real tenki.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createStore, HEARTBEAT_STALE_MS, isOnline, KEYS, type OrchestratorHeartbeat, type RunStore } from "@frictionswarm/store";
import {
  daemonEnv,
  ENV_FILE,
  envFile,
  FORWARDED_ENV,
  HOME,
  LOG_FILE,
  PID_FILE,
  PUBLIC_REPO,
  REPO_DIR,
  SANDBOX_NAME,
  shq,
  START_SCRIPT,
  tenkiClient,
  TERMINAL_STATES,
  WORK_DIR,
  type SandboxClient,
  type SandboxSession,
} from "@frictionswarm/store/launch";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

// The SDK surface, sandbox layout and env file are shared with the Netlify
// autostart (packages/store/src/launch.ts).
export {
  ENV_FILE,
  envFile,
  FORWARDED_ENV,
  HOME,
  LOG_FILE,
  PID_FILE,
  REPO_DIR,
  shq,
  START_SCRIPT,
  WORK_DIR,
  type SandboxClient,
  type SandboxSession,
};
const realClient = tenkiClient;
export const RECORD_FILE = ".tenki-orchestrator.json";

export type SandboxRecord = {
  sandboxId: string;
  createdAt: string;
  source: string;
  ref: string;
  version: string;
  snapshotId?: string;
};

export type Deps = {
  client: () => Promise<SandboxClient>;
  /** The Blobs store the site reads (heartbeat). */
  store: () => RunStore;
  env: Env;
  log: Log;
  /** Repo root on this machine. */
  root: string;
  /** Local git/tar, returns stdout. */
  sh: (cmd: string, args: string[], input?: string) => Buffer;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

// ------------------------------------------------------------ helpers

const text = (b: Uint8Array) => new TextDecoder().decode(b);

export function readRecord(root: string): SandboxRecord | undefined {
  const p = join(root, RECORD_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SandboxRecord;
  } catch {
    return undefined;
  }
}
const writeRecord = (root: string, r: SandboxRecord) => writeFileSync(join(root, RECORD_FILE), JSON.stringify(r, null, 2) + "\n");
const removeRecord = (root: string) => rmSync(join(root, RECORD_FILE), { force: true });

class StepError extends Error {}

/** Runs a bash script in the sandbox; throws with the output tail on failure. */
async function run(session: SandboxSession, step: string, script: string, opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  const r = await session.exec(["bash", "-c", script], { cwd: HOME, env: opts.env, timeoutMs: opts.timeoutMs });
  if (r.exitCode !== 0 || r.status === "TIMED_OUT") {
    const out = (text(r.stderr) || text(r.stdout)).slice(-2000);
    throw new StepError(`${step} failed (${r.status === "TIMED_OUT" ? "timed out" : `exit ${r.exitCode}`}):\n${out}`);
  }
  return text(r.stdout).trim();
}

const TERMINAL = TERMINAL_STATES;

function requireEnv(env: Env, names: string[]) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")} (shell env or repo-root .env.local; see docs/DEPLOY.md)`);
}

/** Files to upload with --tarball: tracked + untracked-not-ignored, minus heavy/irrelevant folders. */
export function tarballFiles(listing: string): string[] {
  return listing
    .split("\0")
    .filter(Boolean)
    .filter((f) => !/^(node_modules|data|runs|\.orchestrator-work|\.netlify|\.next)\//.test(f) && !f.includes("/node_modules/") && !f.includes("/.next/"))
    .filter((f) => !/(^|\/)\.env(\.|$)/.test(f) || f.endsWith(".env.example"));
}

// ------------------------------------------------------------ commands

export type UpOptions = { ref?: string; tarball?: boolean; hours?: number; keepOnFailure?: boolean; heartbeatTimeoutMs?: number };

export async function up(deps: Deps, opts: UpOptions = {}): Promise<SandboxRecord> {
  const { env, log, root } = deps;
  requireEnv(env, ["NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"]);
  if (!env.TENKI_API_KEY && !env.TENKI_AUTH_TOKEN) requireEnv(env, ["TENKI_API_KEY"]);

  const existing = readRecord(root);
  const client = await deps.client();
  try {
    if (existing) {
      const old = await client.get(existing.sandboxId).catch(() => undefined);
      if (old && !TERMINAL.has(old.state))
        throw new Error(`Sandbox ${existing.sandboxId} is still ${old.state}: run \`npm run orchestrator:tenki -- stop\` first`);
      removeRecord(root);
    }

    const version = deps.sh("git", ["rev-parse", "--short", "HEAD"]).toString().trim() || "dev";
    const ref = opts.ref || env.TENKI_REPO_REF || deps.sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    const repoUrl = env.TENKI_REPO_URL || PUBLIC_REPO;
    let tarball: Buffer | undefined;
    if (opts.tarball) {
      const files = tarballFiles(deps.sh("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString());
      tarball = deps.sh("tar", ["-czf", "-", "--null", "-T", "-"], files.join("\0") + "\0");
      log(`working tree: ${files.length} files, ${(tarball.length / 1e6).toFixed(1)} MB tarball`);
    } else {
      // The sandbox clones from GitHub, so the ref must be pushed.
      try {
        deps.sh("git", ["ls-remote", "--exit-code", "--heads", repoUrl, ref]);
      } catch {
        throw new Error(`Branch "${ref}" is not on ${repoUrl}: push it, pass --ref main, or use --tarball`);
      }
    }

    const snapshotId = env.TENKI_CHROME_SNAPSHOT_ID || undefined;
    const hours = opts.hours ?? Number(env.TENKI_MAX_HOURS || 8);
    log(`creating sandbox${snapshotId ? ` from snapshot ${snapshotId}` : ""} (max ${hours} h)...`);
    const session = await client.create({
      name: SANDBOX_NAME,
      cpuCores: 4,
      memoryMb: 8192,
      diskSizeGb: 20,
      maxDurationMs: hours * 3_600_000,
      ...(snapshotId ? { snapshotId } : {}),
      tags: ["frictionswarm", "orchestrator"],
      metadata: { repo: repoUrl, ref: tarball ? "working-tree" : ref, version },
    });
    const record: SandboxRecord = {
      sandboxId: session.id,
      createdAt: new Date(deps.now()).toISOString(),
      source: tarball ? "tarball" : repoUrl,
      ref: tarball ? "working-tree" : ref,
      version,
      ...(snapshotId ? { snapshotId } : {}),
    };
    writeRecord(root, record);
    log(`sandbox ${session.id} created`);

    try {
      const node = await run(session, "node check", "node -v && npm -v");
      const major = Number(/^v(\d+)/.exec(node)?.[1] ?? 0);
      if (major < 22) throw new StepError(`The sandbox has Node ${node.split("\n")[0]}; the orchestrator needs Node >= 22`);
      log(`node ${node.split("\n")[0]}`);

      if (tarball) {
        await session.writeFile(`${HOME}/repo.tgz`, new Uint8Array(tarball));
        await run(session, "unpack", `rm -rf ${REPO_DIR} && mkdir -p ${REPO_DIR} && tar -xzf ${HOME}/repo.tgz -C ${REPO_DIR} && rm ${HOME}/repo.tgz`);
      } else {
        // The token (if any) only lives in this command's env, and origin is reset to the public URL.
        const tokenUrl = repoUrl.replace(/^https:\/\//, "https://x-access-token:${GITHUB_TOKEN}@");
        await run(
          session,
          "git clone",
          `rm -rf ${REPO_DIR} && if [ -n "$GITHUB_TOKEN" ]; then git clone --depth 1 --branch ${shq(ref)} "${tokenUrl}" ${REPO_DIR}; ` +
            `else git clone --depth 1 --branch ${shq(ref)} ${shq(repoUrl)} ${REPO_DIR}; fi && git -C ${REPO_DIR} remote set-url origin ${shq(repoUrl)}`,
          { env: env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}, timeoutMs: 5 * 60_000 },
        );
      }
      log(`repo in ${REPO_DIR} (${record.ref})`);

      log("npm ci (a few minutes)...");
      await run(session, "npm ci", `cd ${REPO_DIR} && npm ci --no-audit --no-fund`, {
        env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", NEXT_TELEMETRY_DISABLED: "1" },
        timeoutMs: 20 * 60_000,
      });

      log("npm run posthog:generate (the file source's history)...");
      await run(session, "posthog:generate", `cd ${REPO_DIR} && npm run posthog:generate`, { timeoutMs: 20 * 60_000 });

      const vars = daemonEnv(env, { sandboxId: session.id, version });
      await session.writeFile(ENV_FILE, envFile(vars));
      await session.writeFile(
        START_SCRIPT,
        `#!/usr/bin/env bash\nset -a\n. ${ENV_FILE}\nset +a\nmkdir -p ${WORK_DIR}\ncd ${REPO_DIR}\nexec npm run orchestrator\n`,
      );
      // Detached: both streams redirected, or exec would wait for the daemon.
      await run(
        session,
        "start orchestrator",
        `chmod 600 ${ENV_FILE} && chmod 700 ${START_SCRIPT} && ` +
          `setsid nohup ${START_SCRIPT} >> ${LOG_FILE} 2>&1 < /dev/null & echo $! > ${PID_FILE}`,
      );
      log(`orchestrator started; logs in ${LOG_FILE}`);
    } catch (e) {
      const tail = await session
        .exec(["bash", "-c", `tail -n 40 ${LOG_FILE} 2>/dev/null`], { cwd: HOME })
        .then((r) => text(r.stdout))
        .catch(() => "");
      if (tail.trim()) log(`orchestrator log tail:\n${tail}`);
      if (opts.keepOnFailure) {
        log(`kept sandbox ${session.id} for inspection (--keep-on-failure); stop it with: npm run orchestrator:tenki -- stop`);
      } else {
        log(`closing sandbox ${session.id} (failed sessions still bill)`);
        await session.closeIfOpen().catch((err) => log(`close failed: ${err}`));
        removeRecord(root);
      }
      throw e;
    }

    // The daemon writes its first heartbeat right after boot.
    const store = deps.store();
    const deadline = deps.now() + (opts.heartbeatTimeoutMs ?? 90_000);
    for (;;) {
      const hb = await store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat).catch(() => undefined);
      if (hb?.sandboxId === session.id && isOnline(hb, deps.now())) {
        log(`heartbeat OK: host=${hb.host} version=${hb.version} queue=${hb.queueDepth}. /control should show "tenki".`);
        break;
      }
      if (deps.now() > deadline) {
        log(`no heartbeat from ${session.id} yet; check \`npm run orchestrator:tenki -- logs\` (the sandbox keeps running)`);
        break;
      }
      await deps.sleep(3000);
    }
    return record;
  } finally {
    await client.close();
  }
}

export async function status(deps: Deps): Promise<{ heartbeat?: OrchestratorHeartbeat; online: boolean; state?: string }> {
  const { log, root, env } = deps;
  const record = readRecord(root);
  let heartbeat: OrchestratorHeartbeat | undefined;
  if (env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN) {
    heartbeat = await deps.store().getJson<OrchestratorHeartbeat>(KEYS.heartbeat).catch((e) => {
      log(`heartbeat: could not read Blobs (${e instanceof Error ? e.message : e})`);
      return undefined;
    });
  } else log("heartbeat: NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN not set, skipping Blobs");
  const online = isOnline(heartbeat, deps.now());
  if (heartbeat) {
    const age = Math.round((deps.now() - Date.parse(heartbeat.lastSeenAt)) / 1000);
    log(
      `heartbeat: ${online ? "online" : `OFFLINE (older than ${HEARTBEAT_STALE_MS / 1000} s)`}, host=${heartbeat.host}` +
        `${heartbeat.sandboxId ? ` sandbox=${heartbeat.sandboxId}` : ""} version=${heartbeat.version} last seen ${age} s ago, ` +
        `active=[${heartbeat.activeRunIds.join(", ")}] queue=${heartbeat.queueDepth}`,
    );
  } else if (env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN) log("heartbeat: none in Blobs");

  if (!record) {
    log(`sandbox: none recorded in ${RECORD_FILE}`);
    return { heartbeat, online };
  }
  const client = await deps.client();
  try {
    const session = await client.get(record.sandboxId);
    await session.refresh().catch(() => {});
    let proc = "";
    if (session.state === "RUNNING")
      proc = await session
        .exec(["bash", "-c", `kill -0 "$(cat ${PID_FILE} 2>/dev/null)" 2>/dev/null && echo running || echo "not running"`], { cwd: HOME })
        .then((r) => text(r.stdout).trim())
        .catch(() => "unknown");
    log(
      `sandbox: ${record.sandboxId} ${session.state}${proc ? `, orchestrator process ${proc}` : ""}` +
        `${session.timeoutAt ? `, ends ${session.timeoutAt.toISOString()}` : ""} (${record.ref} @ ${record.version})`,
    );
    return { heartbeat, online, state: session.state };
  } finally {
    await client.close();
  }
}

export async function logs(deps: Deps, opts: { lines?: number; follow?: boolean } = {}) {
  const record = readRecord(deps.root);
  if (!record) throw new Error(`No sandbox recorded in ${RECORD_FILE}; run up first`);
  const client = await deps.client();
  try {
    const session = await client.get(record.sandboxId);
    const n = Math.max(1, Math.min(opts.lines ?? 200, 5000));
    const out = await run(session, "tail", `tail -n ${n} ${LOG_FILE}; echo; echo "@@size $(wc -c < ${LOG_FILE})"`);
    let offset = Number(/@@size (\d+)$/.exec(out)?.[1] ?? 0);
    deps.log(out.replace(/\s*@@size \d+$/, ""));
    while (opts.follow) {
      await deps.sleep(2000);
      const more = await run(session, "tail", `tail -c +${offset + 1} ${LOG_FILE}; echo; echo "@@size $(wc -c < ${LOG_FILE})"`);
      const size = Number(/@@size (\d+)$/.exec(more)?.[1] ?? offset);
      const chunk = more.replace(/\s*@@size \d+$/, "");
      if (size > offset && chunk) deps.log(chunk);
      offset = size;
    }
  } finally {
    await client.close();
  }
}

export async function stop(deps: Deps) {
  const record = readRecord(deps.root);
  if (!record) {
    deps.log(`No sandbox recorded in ${RECORD_FILE}; nothing to stop`);
    return;
  }
  const client = await deps.client();
  try {
    const session = await client.get(record.sandboxId).catch(() => undefined);
    if (session && !TERMINAL.has(session.state)) {
      if (session.state === "RUNNING") {
        // SIGTERM lets the daemon write a last heartbeat; runs in flight are marked failed on the next start.
        await session
          .exec(["bash", "-c", `kill -TERM "$(cat ${PID_FILE})" 2>/dev/null; sleep 3`], { cwd: HOME, timeoutMs: 15_000 })
          .catch(() => {});
      }
      await session.closeIfOpen();
      deps.log(`sandbox ${record.sandboxId} closed`);
    } else deps.log(`sandbox ${record.sandboxId} already ${session?.state ?? "gone"}`);
    removeRecord(deps.root);
  } finally {
    await client.close();
  }
}

// ------------------------------------------------------------ CLI

export function repoRoot(): string {
  return resolve(import.meta.dirname, "..", "..", "..");
}

export function defaultDeps(env: Env = process.env, root = repoRoot()): Deps {
  return {
    client: () => realClient(env),
    store: () => createStore(join(root, "runs"), { ...env, RUN_STORE: "blobs" }),
    env,
    log: (line) => console.log(`[tenki] ${line}`),
    root,
    sh: (cmd, args, input) => execFileSync(cmd, args, { cwd: root, input, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

const USAGE = "usage: npm run orchestrator:tenki -- up [--ref <branch>] [--tarball] [--hours N] [--keep-on-failure] | status | logs [-n N] [--follow] | stop";

export async function main(argv: string[], deps: Deps) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      tarball: { type: "boolean" },
      hours: { type: "string" },
      "keep-on-failure": { type: "boolean" },
      n: { type: "string", short: "n" },
      follow: { type: "boolean", short: "f" },
    },
  });
  switch (positionals[0]) {
    case "up":
      await up(deps, {
        ref: values.ref,
        tarball: values.tarball,
        hours: values.hours ? Number(values.hours) : undefined,
        keepOnFailure: values["keep-on-failure"],
      });
      return;
    case "status":
      await status(deps);
      return;
    case "logs":
      await logs(deps, { lines: values.n ? Number(values.n) : undefined, follow: values.follow });
      return;
    case "stop":
      await stop(deps);
      return;
    default:
      throw new Error(USAGE);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = repoRoot();
  const envFilePath = join(root, ".env.local");
  if (existsSync(envFilePath)) process.loadEnvFile(envFilePath);
  main(process.argv.slice(2), defaultDeps(process.env, root)).catch((e) => {
    console.error(`[tenki] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
