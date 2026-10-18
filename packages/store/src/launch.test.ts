import { describe, expect, it } from "vitest";
import { KEYS } from "./control";
import {
  BOOT_GRACE_MS,
  BOOT_STATUS_FILE,
  bootstrapScript,
  ENV_FILE,
  FAILED_RETRY_MS,
  failedRetryMs,
  launchDecision,
  launchOrchestrator,
  STALLED_MS,
  START_SCRIPT,
  type LaunchRecord,
  type SandboxClient,
  type SandboxSession,
} from "./launch";
import { MemoryStore } from "./memory";

const T0 = Date.parse("2026-10-18T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ENV = { TENKI_API_KEY: "tk_x", NETLIFY_SITE_ID: "site", NETLIFY_AUTH_TOKEN: "nfp_x", CLAUDE_CODE_OAUTH_TOKEN: "oauth", SWARM_RUNNER: "tenki" };

function fakeClient(opts: { failExec?: boolean; bootStatus?: string; failCreateClient?: boolean } = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let closed = 0;
  const session: SandboxSession = {
    id: "sbx_1",
    state: "RUNNING",
    async exec(cmd) {
      calls.push(cmd.join(" "));
      const stdout = new TextEncoder().encode(cmd.join(" ").includes(BOOT_STATUS_FILE) ? (opts.bootStatus ?? "booting") : "npm ERR! x-access-token:ghp_secret@github.com");
      return { exitCode: opts.failExec ? 1 : 0, status: "COMPLETED", stdout, stderr: new TextEncoder().encode("boom") };
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

const hb = (lastSeen: number, sandboxId?: string) => ({ host: "tenki" as const, version: "v", startedAt: iso(T0), lastSeenAt: iso(lastSeen), activeRunIds: [], queueDepth: 0, ...(sandboxId ? { sandboxId } : {}) });
const lock = (state: LaunchRecord["state"], at: number, extra: Partial<LaunchRecord> = {}): LaunchRecord => ({ nonce: "n", reason: "r", state, requestedAt: iso(at), updatedAt: iso(at), ...extra });

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

  it("judges a sandbox whose daemon came up by its heartbeat, not by the record's age", () => {
    const old = lock("booting", T0 - 2 * BOOT_GRACE_MS, { sandboxId: "sbx_1" });
    // A 1-minute heartbeat gap on a 40-minute-old record: not dead yet.
    expect(launchDecision(hb(T0 - 60_000, "sbx_1"), old, T0)).toEqual({ launch: false, why: "booting" });
    expect(launchDecision(hb(T0 - STALLED_MS - 1, "sbx_1"), old, T0)).toEqual({ launch: true });
    // Another sandbox's heartbeat says nothing about this one.
    expect(launchDecision(hb(T0 - 60_000, "sbx_other"), old, T0)).toEqual({ launch: true });
  });

  it("relaunches at once after a daemon marked its sandbox closing", () => {
    expect(launchDecision(hb(T0 - 30_000, "sbx_1"), lock("closing", T0 - 1_000, { sandboxId: "sbx_1" }), T0)).toEqual({ launch: true });
  });

  it("backs off longer after failures in a row", () => {
    expect([1, 2, 3, 9].map(failedRetryMs)).toEqual([FAILED_RETRY_MS, 2 * FAILED_RETRY_MS, 4 * FAILED_RETRY_MS, 60 * 60_000]);
    expect(launchDecision(undefined, lock("failed", T0 - FAILED_RETRY_MS - 1, { failures: 2 }), T0)).toEqual({ launch: false, why: "failed-recently" });
  });
});

describe("launchOrchestrator", () => {
  const deps = (store: MemoryStore, c: ReturnType<typeof fakeClient>, env: Record<string, string> = ENV) => ({
    store,
    env,
    client: async () => c.client,
    now: () => T0,
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

  it("backs off when another caller claimed the launch between its read and its write", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient();
    let creates = 0;
    c.client.create = async () => (creates++, c.client.get("sbx_1"));
    const read = store.getJsonVersioned.bind(store);
    store.getJsonVersioned = async <T,>(key: string) => {
      const v = await read<T>(key);
      await store.putJson(KEYS.launch, { ...lock("launching", T0), nonce: "theirs" });
      return v;
    };
    expect(await launchOrchestrator(deps(store, c), "enqueue")).toEqual({ state: "lost-race" });
    expect(creates).toBe(0);
    expect(await store.getJson<LaunchRecord>(KEYS.launch)).toMatchObject({ nonce: "theirs" });
  });

  it("closes the new sandbox when its booting record can't be written", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient();
    const put = store.putJsonIf.bind(store);
    store.putJsonIf = async (key, data, version) => {
      if ((data as LaunchRecord).state === "booting") throw new Error("Blobs 503");
      return put(key, data, version);
    };
    expect(await launchOrchestrator(deps(store, c), "enqueue")).toEqual({ state: "failed", error: "Blobs 503" });
    expect(c.closed()).toBe(1);
    const rec = await store.getJson<LaunchRecord>(KEYS.launch);
    expect(rec).toMatchObject({ state: "failed", failures: 1 });
    expect(rec?.sandboxId).toBeUndefined();
  });

  it("keeps the id of a sandbox it couldn't close, and closes it on the next pass", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient({ failExec: true });
    let closeFails = true;
    const session = await c.client.get("sbx_1");
    const close = session.closeIfOpen.bind(session);
    session.closeIfOpen = async () => {
      if (closeFails) throw new Error("tenki down");
      return close();
    };
    expect((await launchOrchestrator(deps(store, c), "enqueue")).state).toBe("failed");
    expect(await store.getJson<LaunchRecord>(KEYS.launch)).toMatchObject({ state: "failed", sandboxId: "sbx_1" });
    closeFails = false;
    expect(await launchOrchestrator(deps(store, c), "watch")).toEqual({ state: "failed-recently" });
    expect(c.closed()).toBe(1);
    expect((await store.getJson<LaunchRecord>(KEYS.launch))?.sandboxId).toBeUndefined();
  });

  it("keeps the id of an earlier sandbox it couldn't close", async () => {
    const store = new MemoryStore();
    await queued(store);
    await store.putJson(KEYS.launch, lock("closing", T0 - 60_000, { sandboxId: "sbx_1" }));
    const c = fakeClient();
    (await c.client.get("sbx_1")).closeIfOpen = async () => Promise.reject(new Error("tenki down"));
    expect((await launchOrchestrator(deps(store, c), "enqueue")).state).toBe("failed");
    expect(await store.getJson<LaunchRecord>(KEYS.launch)).toMatchObject({ state: "failed", sandboxId: "sbx_1" });
  });

  it("records a failure (not a stuck 'launching') when the tenki client can't be created", async () => {
    const store = new MemoryStore();
    await queued(store);
    const r = await launchOrchestrator({ ...deps(store, fakeClient()), client: async () => Promise.reject(new Error("no SDK")) }, "enqueue");
    expect(r).toEqual({ state: "failed", error: "no SDK" });
    expect(await store.getJson<LaunchRecord>(KEYS.launch)).toMatchObject({ state: "failed", error: "no SDK" });
  });

  it("closes a booting sandbox whose bootstrap failed, even with nothing queued", async () => {
    const store = new MemoryStore();
    await store.putJson(KEYS.launch, lock("booting", T0 - 60_000, { sandboxId: "sbx_1" }));
    const c = fakeClient({ bootStatus: "failed: exit 128 at line 9" });
    const r = await launchOrchestrator(deps(store, c), "watch");
    expect(r.state).toBe("failed");
    expect(c.closed()).toBe(1);
    const rec = (await store.getJson<LaunchRecord>(KEYS.launch))!;
    expect(rec).toMatchObject({ state: "failed", failures: 1 });
    expect(rec.sandboxId).toBeUndefined();
    expect(rec.error).toContain("failed: exit 128 at line 9");
    expect(rec.error).not.toContain("ghp_secret");
  });

  it("leaves a booting sandbox alone while its bootstrap is still going", async () => {
    const store = new MemoryStore();
    await queued(store);
    await store.putJson(KEYS.launch, lock("booting", T0 - 60_000, { sandboxId: "sbx_1" }));
    const c = fakeClient({ bootStatus: "booting" });
    expect(await launchOrchestrator(deps(store, c), "watch")).toEqual({ state: "booting" });
    expect(c.closed()).toBe(0);
  });

  it("closes a sandbox left 'closing' and clears the record when nothing is queued", async () => {
    const store = new MemoryStore();
    await store.putJson(KEYS.launch, lock("closing", T0 - 60_000, { sandboxId: "sbx_1" }));
    const c = fakeClient();
    expect(await launchOrchestrator(deps(store, c), "watch")).toEqual({ state: "idle" });
    expect(c.closed()).toBe(1);
    expect(await store.getJson(KEYS.launch)).toBeUndefined();
  });

  it("tells the daemon its deadline", async () => {
    const store = new MemoryStore();
    await queued(store);
    const c = fakeClient();
    await launchOrchestrator(deps(store, c), "enqueue");
    expect(c.files.get(ENV_FILE)).toContain(`export ORCHESTRATOR_DEADLINE='${iso(T0 + 3 * 3_600_000)}'`);
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

  it("records a failed step, and 'started' only right before the daemon", () => {
    const s = bootstrapScript({ repoUrl: "https://github.com/o/r.git", ref: "main" });
    expect(s.indexOf("trap ")).toBeLessThan(s.indexOf(". /home/tenki/orchestrator.env"));
    expect(s).toContain(`> ${BOOT_STATUS_FILE}' ERR`);
    expect(s.indexOf(`echo started > ${BOOT_STATUS_FILE}`)).toBeGreaterThan(s.indexOf("npm run posthog:generate"));
  });
});
