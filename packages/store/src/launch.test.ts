import { describe, expect, it } from "vitest";
import { KEYS } from "./control";
import {
  BOOT_GRACE_MS,
  bootstrapScript,
  ENV_FILE,
  FAILED_RETRY_MS,
  launchDecision,
  launchOrchestrator,
  START_SCRIPT,
  type LaunchRecord,
  type SandboxClient,
  type SandboxSession,
} from "./launch";
import { MemoryStore } from "./memory";

const T0 = Date.parse("2026-10-18T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ENV = { TENKI_API_KEY: "tk_x", NETLIFY_SITE_ID: "site", NETLIFY_AUTH_TOKEN: "nfp_x", CLAUDE_CODE_OAUTH_TOKEN: "oauth", SWARM_RUNNER: "tenki" };

function fakeClient(opts: { failExec?: boolean } = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let closed = 0;
  const session: SandboxSession = {
    id: "sbx_1",
    state: "RUNNING",
    async exec(cmd) {
      calls.push(cmd.join(" "));
      return { exitCode: opts.failExec ? 1 : 0, status: "COMPLETED", stdout: new Uint8Array(), stderr: new TextEncoder().encode("boom") };
    },
    async writeFile(path, data) {
      files.set(path, String(data));
    },
    async refresh() {},
    async closeIfOpen() {
      closed++;
    },
  };
  const client: SandboxClient = {
    create: async () => session,
    get: async () => session,
    close: () => {},
  };
  return { client, files, calls, closed: () => closed };
}

const hb = (lastSeen: number) => ({ host: "tenki" as const, version: "v", startedAt: iso(T0), lastSeenAt: iso(lastSeen), activeRunIds: [], queueDepth: 0 });
const lock = (state: LaunchRecord["state"], at: number): LaunchRecord => ({ nonce: "n", reason: "r", state, requestedAt: iso(at), updatedAt: iso(at) });

async function queued(store: MemoryStore) {
  await store.putJson(KEYS.queued("q1"), { requestId: "q1", runId: "r1", req: { flowId: "buy-tshirt" }, requestedAt: iso(T0) });
}

describe("launchDecision", () => {
  it("launches only when offline and nothing is booting", () => {
    expect(launchDecision(hb(T0 - 5_000), undefined, T0)).toEqual({ launch: false, why: "online" });
    expect(launchDecision(hb(T0 - 60_000), undefined, T0)).toEqual({ launch: true });
    expect(launchDecision(undefined, lock("booting", T0 - 60_000), T0)).toEqual({ launch: false, why: "booting" });
    expect(launchDecision(undefined, lock("booting", T0 - BOOT_GRACE_MS - 1), T0)).toEqual({ launch: true });
    expect(launchDecision(undefined, lock("failed", T0 - 60_000), T0)).toEqual({ launch: false, why: "failed-recently" });
    expect(launchDecision(undefined, lock("failed", T0 - FAILED_RETRY_MS - 1), T0)).toEqual({ launch: true });
  });
});

describe("launchOrchestrator", () => {
  const deps = (store: MemoryStore, c: ReturnType<typeof fakeClient>, env: Record<string, string> = ENV) => ({
    store,
    env,
    client: async () => c.client,
    now: () => T0,
    sleep: async () => {},
    nonce: () => "mine",
  });

  it("does nothing without queued runs or with missing credentials", async () => {
    const store = new MemoryStore();
    const c = fakeClient();
    expect(await launchOrchestrator(deps(store, c), "test")).toEqual({ state: "idle" });
    await queued(store);
    expect(await launchOrchestrator(deps(store, c, { NETLIFY_AUTH_TOKEN: "x" }), "test")).toEqual({
      state: "unconfigured",
      missing: ["TENKI_API_KEY", "NETLIFY_SITE_ID"],
    });
    expect(await store.getJson(KEYS.launch)).toBeUndefined();
  });

  it("boots a sandbox: env file, bootstrap script, detached start, launch record", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient();
    expect(await launchOrchestrator(deps(store, c), "enqueue")).toEqual({ state: "launched", sandboxId: "sbx_1" });
    const env = c.files.get(ENV_FILE)!;
    expect(env).toContain("export RUN_STORE='blobs'");
    expect(env).toContain("export TENKI_SANDBOX_ID='sbx_1'");
    expect(env).toContain("export TENKI_API_KEY='tk_x'");
    expect(env).toContain("export CLAUDE_CODE_OAUTH_TOKEN='oauth'");
    expect(env).toContain(`export ORCHESTRATOR_IDLE_EXIT_MS='${30 * 60_000}'`);
    expect(c.files.get(START_SCRIPT)).toContain("exec npm run orchestrator");
    expect(c.calls.at(-1)).toContain("setsid nohup");
    expect(await store.getJson<LaunchRecord>(KEYS.launch)).toMatchObject({ state: "booting", sandboxId: "sbx_1", reason: "enqueue" });
    // A second poke while it boots is a no-op
    expect(await launchOrchestrator(deps(store, c), "watch")).toEqual({ state: "booting" });
  });

  it("backs off when another caller claimed the launch", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient();
    const d = { ...deps(store, c), sleep: async () => void (await store.putJson(KEYS.launch, { ...lock("launching", T0), nonce: "theirs" })) };
    expect(await launchOrchestrator(d, "enqueue")).toEqual({ state: "lost-race" });
    expect(c.calls).toEqual([]);
  });

  it("closes the sandbox and records the failure when the bootstrap can't start", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient({ failExec: true });
    const r = await launchOrchestrator(deps(store, c), "enqueue");
    expect(r.state).toBe("failed");
    expect(c.closed()).toBe(1);
    expect(await store.getJson<LaunchRecord>(KEYS.launch)).toMatchObject({ state: "failed" });
  });
});

describe("bootstrapScript", () => {
  it("clones the ref, installs, generates the history, then execs the daemon", () => {
    const s = bootstrapScript({ repoUrl: "https://github.com/o/r.git", ref: "main" });
    const order = ["git clone", "npm ci", "npm run posthog:generate", "exec npm run orchestrator"].map((x) => s.indexOf(x));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s).toContain("x-access-token:${GITHUB_TOKEN}@github.com/o/r.git");
  });
});
