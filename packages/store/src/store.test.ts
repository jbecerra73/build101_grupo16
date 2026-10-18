import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BlobsStore,
  createStore,
  defaultSettings,
  FsStore,
  isOnline,
  MemoryStore,
  parseSettings,
  readSettings,
  readUsage,
  storeKind,
  type BlobsClient,
  type RunStore,
} from "./index";

/** In-memory stand-in for @netlify/blobs' Store, with request counting. */
function fakeBlobs() {
  const data = new Map<string, { body: string | ArrayBuffer; etag: string }>();
  let n = 0;
  const calls: string[] = [];
  const client: BlobsClient = {
    async get(key) {
      calls.push(`get ${key}`);
      const v = data.get(key);
      if (!v) return null;
      return typeof v.body === "string" ? (new TextEncoder().encode(v.body).buffer as ArrayBuffer) : v.body;
    },
    async getWithMetadata(key, opts) {
      calls.push(`getWithMetadata ${key}`);
      const v = data.get(key);
      if (!v) return null;
      if (opts?.etag === v.etag) return { data: null, etag: v.etag };
      return { data: typeof v.body === "string" ? v.body : new TextDecoder().decode(v.body), etag: v.etag };
    },
    async set(key, body, opts) {
      calls.push(`set ${key}`);
      const cur = data.get(key);
      if ((opts?.onlyIfNew && cur) || (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch)) return { modified: false };
      data.set(key, { body, etag: `"${++n}"` });
      return { modified: true };
    },
    async delete(key) {
      data.delete(key);
    },
    async *list({ prefix = "", directories }) {
      calls.push(`list ${prefix}`);
      const blobs: { key: string; etag: string }[] = [];
      const dirs = new Set<string>();
      for (const [key, v] of [...data].sort()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (directories && rest.includes("/")) dirs.add(prefix + rest.slice(0, rest.indexOf("/")));
        else blobs.push({ key, etag: v.etag });
      }
      yield { blobs, directories: [...dirs] };
    },
  };
  return { client, data, calls };
}

function contract(name: string, make: () => Promise<RunStore>) {
  describe(`${name} (RunStore contract)`, () => {
    it("compare-and-set: writes only while the version it read is current", async () => {
      const s = await make();
      const k = "orchestrator-launch.json";
      expect(await s.getJsonVersioned(k)).toEqual({});
      expect(await s.putJsonIf(k, { n: 1 }, undefined)).toBe(true);
      expect(await s.putJsonIf(k, { n: 2 }, undefined)).toBe(false);
      const v1 = await s.getJsonVersioned<{ n: number }>(k);
      expect(v1.value).toEqual({ n: 1 });
      expect(await s.putJsonIf(k, { n: 2 }, v1.version)).toBe(true);
      expect(await s.putJsonIf(k, { n: 3 }, v1.version)).toBe(false);
      expect(await s.getJson(k)).toEqual({ n: 2 });
    });

    it("round-trips text, json and bytes, and reports missing keys as undefined", async () => {
      const s = await make();
      expect(await s.getText("runs/r1/status.json")).toBeUndefined();
      expect(await s.getBytes("runs/r1/screenshots/a.png")).toBeUndefined();
      await s.putJson("runs/r1/status.json", { phase: "swarming" });
      expect(await s.getJson("runs/r1/status.json")).toEqual({ phase: "swarming" });
      await s.putText("runs/r1/notes.txt", "hi");
      expect(await s.getText("runs/r1/notes.txt")).toBe("hi");
      await s.putBytes("runs/r1/screenshots/a.png", new Uint8Array([1, 2, 3]));
      expect([...(await s.getBytes("runs/r1/screenshots/a.png"))!]).toEqual([1, 2, 3]);
      await s.putText("runs/r1/bad.json", "{half");
      expect(await s.getJson("runs/r1/bad.json")).toBeUndefined();
    });

    it("lists keys under a folder and its sub-folders", async () => {
      const s = await make();
      await s.putJson("runs/a/config.json", {});
      await s.putText("runs/a/events/kai-1.jsonl", "");
      await s.putJson("runs/b/config.json", {});
      await s.putJson("queue/q1.json", {});
      await s.putJson("settings.json", {});
      expect(await s.list("runs/a/")).toEqual(["runs/a/config.json", "runs/a/events/kai-1.jsonl"]);
      expect(await s.list("runs/a/events")).toEqual(["runs/a/events/kai-1.jsonl"]);
      expect(await s.listDirs("runs/")).toEqual(["a", "b"]);
      expect(await s.list("queue/")).toEqual(["queue/q1.json"]);
      expect(await s.list("runs/zzz/")).toEqual([]);
      expect(await s.listDirs("runs/zzz/")).toEqual([]);
    });

    it("appends event lines and deletes keys", async () => {
      const s = await make();
      await s.appendText("runs/a/events/kai-1.jsonl", '{"n":1}\n');
      await Promise.all([s.appendText("runs/a/events/kai-1.jsonl", '{"n":2}\n'), s.appendText("runs/a/events/kai-1.jsonl", '{"n":3}\n')]);
      const lines = (await s.getText("runs/a/events/kai-1.jsonl"))!.trim().split("\n");
      expect(lines.sort()).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
      await s.delete("runs/a/events/kai-1.jsonl");
      expect(await s.getText("runs/a/events/kai-1.jsonl")).toBeUndefined();
      await s.delete("runs/a/never-existed.json");
    });

    it("refuses keys that escape the root", async () => {
      const s = await make();
      for (const k of ["../x", "runs/../../etc/passwd", "/abs", "runs//x", "a\\b"]) await expect(s.getText(k)).rejects.toThrow(/Invalid store key/);
    });
  });
}

const tmp: string[] = [];
const tmpDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "fs-store-"));
  tmp.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(tmp.map((d) => rm(d, { recursive: true, force: true })));
});

contract("FsStore", async () => new FsStore(await tmpDir()));
contract("MemoryStore", async () => new MemoryStore());
contract("BlobsStore (fake client)", async () => new BlobsStore({ client: fakeBlobs().client }));

describe("BlobsStore against a local Netlify Blobs server", () => {
  let server: BlobsServer;
  let port: number;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "blobs-server-"));
    tmp.push(dir);
    server = new BlobsServer({ directory: dir, token: "test-token", logger: () => {} });
    ({ port } = await server.start());
  });
  afterAll(() => server.stop());
  const real = () =>
    new BlobsStore({ siteID: "test-site", token: "test-token", edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, name: `t${Math.random().toString(36).slice(2)}` });
  contract("BlobsStore (BlobsServer)", async () => real());
});

describe("FsStore layout", () => {
  it("keeps run folders under RUNS_DIR and control keys under .control/", async () => {
    const root = await tmpDir();
    const s = new FsStore(root);
    await s.putJson("runs/r1/config.json", { runId: "r1" });
    await s.putJson("queue/q.json", {});
    await s.putJson("orchestrator.json", {});
    expect(JSON.parse(await readFile(join(root, "r1", "config.json"), "utf8"))).toEqual({ runId: "r1" });
    expect(existsSync(join(root, ".control", "queue", "q.json"))).toBe(true);
    expect(existsSync(join(root, ".control", "orchestrator.json"))).toBe(true);
    // .control is not a run
    expect(await s.listDirs("runs/")).toEqual(["r1"]);
  });

  it("does not follow symlinks out of the root", async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, "secret.png"), "secret");
    await mkdir(join(root, "r1", "screenshots"), { recursive: true });
    await symlink(join(outside, "secret.png"), join(root, "r1", "screenshots", "a.png"));
    expect(await new FsStore(root).getBytes("runs/r1/screenshots/a.png")).toBeUndefined();
  });
});

describe("BlobsStore etag cache", () => {
  it("serves unchanged listed blobs from memory and refetches changed ones", async () => {
    const fake = fakeBlobs();
    const s = new BlobsStore({ client: fake.client });
    await s.putText("runs/r/events/a.jsonl", "a1\n");
    await s.putText("runs/r/events/b.jsonl", "b1\n");
    const read = async () => {
      const keys = await s.list("runs/r/events/");
      return Promise.all(keys.map((k) => s.getText(k)));
    };
    expect(await read()).toEqual(["a1\n", "b1\n"]);
    fake.calls.length = 0;
    expect(await read()).toEqual(["a1\n", "b1\n"]);
    expect(fake.calls).toEqual(["list runs/r/events/"]);
    // another writer (the orchestrator) rewrites b
    await fake.client.set("runs/r/events/b.jsonl", "b1\nb2\n");
    fake.calls.length = 0;
    expect(await read()).toEqual(["a1\n", "b1\nb2\n"]);
    expect(fake.calls).toEqual(["list runs/r/events/", "getWithMetadata runs/r/events/b.jsonl"]);
  });
});

describe("store selection", () => {
  it("defaults to fs locally and blobs on Netlify; RUN_STORE wins", () => {
    expect(storeKind({})).toBe("fs");
    expect(storeKind({ NETLIFY: "true" })).toBe("blobs");
    expect(storeKind({ AWS_LAMBDA_FUNCTION_NAME: "x" })).toBe("blobs");
    expect(storeKind({ NETLIFY: "true", RUN_STORE: "fs" })).toBe("fs");
    expect(storeKind({ RUN_STORE: "blobs" })).toBe("blobs");
    expect(() => storeKind({ RUN_STORE: "s3" })).toThrow();
    expect(createStore("/tmp/x", {}).kind).toBe("fs");
    expect(createStore("/tmp/x", { RUN_STORE: "blobs", NETLIFY_SITE_ID: "s", NETLIFY_AUTH_TOKEN: "t" }).kind).toBe("blobs");
  });
});

describe("settings", () => {
  const base = defaultSettings({});
  it("has offline-demo defaults and follows the env vars", () => {
    expect(base).toEqual({ swarmRunner: "offline", fixLoop: "fake", swarmSpeed: 1, maxRunsPerDay: 10, defaultSeedsPerPersona: 10 });
    expect(defaultSettings({ SWARM_RUNNER: "p2" })).toMatchObject({ swarmRunner: "tenki", fixLoop: "real" });
    expect(defaultSettings({ SWARM_SPEED: "4", MAX_RUNS_PER_DAY: "3", DEFAULT_SEEDS_PER_PERSONA: "5" })).toMatchObject({ swarmSpeed: 4, maxRunsPerDay: 3, defaultSeedsPerPersona: 5 });
  });
  it("accepts valid partial updates, and the retired names", () => {
    expect(parseSettings({ swarmSpeed: 6, swarmRunner: "tenki" }, base)).toEqual({ ok: true, value: { ...base, swarmSpeed: 6, swarmRunner: "tenki" } });
    expect(parseSettings({ swarmRunner: "replay", replaySpeed: 2, verifyBuild: true }, base)).toEqual({ ok: true, value: { ...base, swarmRunner: "offline" } });
  });
  it("rejects bad values and unknown keys", () => {
    const r = parseSettings({ swarmSpeed: 0, maxRunsPerDay: 2.5, swarmRunner: "p2", fixLoop: 1, defaultSeedsPerPersona: 11, extra: 1 }, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(6);
    expect(parseSettings([], base).ok).toBe(false);
    expect(parseSettings(null, base).ok).toBe(false);
  });
  it("reads settings.json over the defaults, ignoring a corrupt file", async () => {
    const s = new MemoryStore();
    expect(await readSettings(s, {})).toEqual(base);
    await s.putJson("settings.json", { swarmSpeed: 8 });
    expect((await readSettings(s, {})).swarmSpeed).toBe(8);
    await s.putJson("settings.json", { swarmSpeed: "fast" });
    expect(await readSettings(s, {})).toEqual(base);
  });
});

describe("usage and heartbeat", () => {
  it("resets the day count on a new day and keeps the seed counter", async () => {
    const s = new MemoryStore();
    await s.putJson("usage.json", { date: "2026-10-16", runs: 7, nextSeed: 40 });
    expect(await readUsage(s, new Date("2026-10-17T10:00:00Z"))).toEqual({ date: "2026-10-17", runs: 0, nextSeed: 40 });
    expect(await readUsage(s, new Date("2026-10-16T10:00:00Z"))).toEqual({ date: "2026-10-16", runs: 7, nextSeed: 40 });
  });
  it("treats a heartbeat older than 20 s as offline", () => {
    const now = Date.parse("2026-10-17T10:00:30Z");
    const hb = (lastSeenAt: string) => ({ host: "local" as const, version: "1", startedAt: lastSeenAt, lastSeenAt, activeRunIds: [], queueDepth: 0 });
    expect(isOnline(undefined, now)).toBe(false);
    expect(isOnline(hb("2026-10-17T10:00:15Z"), now)).toBe(true);
    expect(isOnline(hb("2026-10-17T10:00:05Z"), now)).toBe(false);
  });
});
