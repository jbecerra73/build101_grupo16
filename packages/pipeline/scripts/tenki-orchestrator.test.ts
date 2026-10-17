import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYS, MemoryStore } from "@frictionswarm/store";
import { describe, expect, it } from "vitest";
import {
  ENV_FILE,
  envFile,
  LOG_FILE,
  main,
  RECORD_FILE,
  shq,
  START_SCRIPT,
  tarballFiles,
  up,
  type Deps,
  type SandboxClient,
  type SandboxSession,
} from "./tenki-orchestrator";

const enc = (s: string) => new TextEncoder().encode(s);

/** A fake tenki SDK: records every call; scripted command results. */
function fakeTenki(opts: { failOn?: RegExp; node?: string; state?: string } = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const sessions = new Map<string, SandboxSession>();
  let n = 0;
  const makeSession = (id: string): SandboxSession => ({
    id,
    state: opts.state ?? "RUNNING",
    async exec(command, o) {
      const script = command[2] ?? command.join(" ");
      calls.push(`exec ${script}${o?.env && Object.keys(o.env).length ? ` env=${Object.keys(o.env).join(",")}` : ""}`);
      if (opts.failOn?.test(script)) return { exitCode: 1, status: "FAILED", stdout: enc(""), stderr: enc("boom") };
      if (script.startsWith("node -v")) return { exitCode: 0, status: "COMPLETED", stdout: enc(`${opts.node ?? "v22.11.0"}\n10.9.0\n`), stderr: enc("") };
      if (script.startsWith("tail -n")) return { exitCode: 0, status: "COMPLETED", stdout: enc("line1\nline2\n\n@@size 12\n"), stderr: enc("") };
      return { exitCode: 0, status: "COMPLETED", stdout: enc(""), stderr: enc("") };
    },
    async writeFile(path, data) {
      calls.push(`write ${path}`);
      files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    async refresh() {},
    async closeIfOpen() {
      calls.push(`close ${id}`);
      this.state = "TERMINATED";
    },
  });
  let clientCloses = 0;
  const client: SandboxClient = {
    async create(o) {
      calls.push(`create ${JSON.stringify(o)}`);
      const s = makeSession(`sbx-${++n}`);
      sessions.set(s.id, s);
      return s;
    },
    async get(id) {
      const s = sessions.get(id);
      if (!s) throw new Error("not found");
      return s;
    },
    close() {
      clientCloses++;
    },
  };
  return { client, calls, files, sessions, closes: () => clientCloses };
}

function deps(tenki: ReturnType<typeof fakeTenki>, env: Record<string, string> = {}, store = new MemoryStore()) {
  const root = mkdtempSync(join(tmpdir(), "tenki-orch-"));
  const lines: string[] = [];
  let now = Date.parse("2026-10-17T20:00:00Z");
  const sh: Deps["sh"] = (cmd, args) => {
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--short") return Buffer.from("abc1234\n");
    if (cmd === "git" && args[0] === "rev-parse") return Buffer.from("p3/deploy-netlify\n");
    if (cmd === "git" && args[0] === "ls-files") return Buffer.from(["package.json", "runs/fixture-a/x.json", "data/posthog/e.jsonl", ".env.local", "apps/dashboard/.env.example", ""].join("\0"));
    if (cmd === "tar") return Buffer.from("TARBALL");
    return Buffer.from("");
  };
  const d: Deps = {
    client: async () => tenki.client,
    store: () => store,
    env: { TENKI_API_KEY: "tk_test", NETLIFY_SITE_ID: "site-1", NETLIFY_AUTH_TOKEN: "nfp_x", ...env },
    log: (l) => lines.push(l),
    root,
    sh,
    sleep: async (ms) => {
      now += ms;
      // The daemon comes up "after" the first poll.
      const hb = { host: "tenki", sandboxId: "sbx-1", version: "abc1234", startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), activeRunIds: [], queueDepth: 0 };
      await store.putJson(KEYS.heartbeat, hb);
    },
    now: () => now,
  };
  return { d, lines, root, store };
}

describe("tenki orchestrator bootstrap (mocked SDK)", () => {
  it("up: creates the sandbox, clones, installs, generates data, writes the env file and starts the daemon detached", async () => {
    const tenki = fakeTenki();
    const { d, lines, root } = deps(tenki, { TENKI_CHROME_SNAPSHOT_ID: "snap_1", ANTHROPIC_API_KEY: "sk-a", GITHUB_TOKEN: "ghp_x" });
    const rec = await up(d, { hours: 2 });

    expect(rec).toMatchObject({ sandboxId: "sbx-1", ref: "p3/deploy-netlify", version: "abc1234", snapshotId: "snap_1" });
    expect(JSON.parse(readFileSync(join(root, RECORD_FILE), "utf8")).sandboxId).toBe("sbx-1");

    const create = JSON.parse(tenki.calls[0].slice("create ".length));
    expect(create).toMatchObject({ snapshotId: "snap_1", maxDurationMs: 2 * 3_600_000, cpuCores: 4 });

    const steps = tenki.calls.slice(1).join("\n");
    expect(steps).toMatch(/git clone --depth 1 --branch 'p3\/deploy-netlify'/);
    expect(steps).toMatch(/x-access-token:\$\{GITHUB_TOKEN\}@.* env=GITHUB_TOKEN/); // token via env, not argv
    expect(steps).not.toContain("ghp_x");
    expect(steps).toMatch(/npm ci/);
    expect(steps).toMatch(/npm run posthog:generate/);
    expect(steps).toMatch(new RegExp(`setsid nohup ${START_SCRIPT} >> ${LOG_FILE} 2>&1 < /dev/null &`));
    // Order: clone before install before generate before start.
    const idx = (re: RegExp) => tenki.calls.findIndex((c) => re.test(c));
    expect(idx(/git clone/)).toBeLessThan(idx(/npm ci/));
    expect(idx(/npm ci/)).toBeLessThan(idx(/posthog:generate/));
    expect(idx(/posthog:generate/)).toBeLessThan(idx(/setsid/));

    // Everything lives under /home/tenki.
    for (const c of tenki.calls.filter((c) => c.startsWith("write "))) expect(c).toMatch(/^write \/home\/tenki\//);
    const env = tenki.files.get(ENV_FILE)!;
    expect(env).toContain("export RUN_STORE='blobs'");
    expect(env).toContain("export NETLIFY_SITE_ID='site-1'");
    expect(env).toContain("export NETLIFY_AUTH_TOKEN='nfp_x'");
    expect(env).toContain("export ORCHESTRATOR_HOST='tenki'");
    expect(env).toContain("export TENKI_SANDBOX_ID='sbx-1'");
    expect(env).toContain("export ANTHROPIC_API_KEY='sk-a'");
    expect(env).not.toContain("TENKI_API_KEY"); // the tenki key never enters the sandbox
    expect(tenki.files.get(START_SCRIPT)).toContain("exec npm run orchestrator");

    expect(lines.join("\n")).toMatch(/heartbeat OK: host=tenki/);
    expect(tenki.closes()).toBe(1); // client released; the sandbox keeps running
    expect(tenki.sessions.get("sbx-1")!.state).toBe("RUNNING");
  });

  it("up --tarball uploads the working tree minus runs/, data/ and .env files", async () => {
    const tenki = fakeTenki();
    const { d, lines } = deps(tenki);
    await up(d, { tarball: true });
    expect(tenki.calls).toContain("write /home/tenki/repo.tgz");
    expect(tenki.calls.join("\n")).not.toMatch(/git clone/);
    expect(lines.join("\n")).toMatch(/working tree: 2 files/);
    expect(tarballFiles(["a.ts", "runs/x", "data/y", "node_modules/z", "apps/d/node_modules/q", ".env.local", "apps/d/.env.example", ""].join("\0"))).toEqual([
      "a.ts",
      "apps/d/.env.example",
    ]);
  });

  it("closes the sandbox when a step fails, and keeps no record", async () => {
    const tenki = fakeTenki({ failOn: /npm ci/ });
    const { d, root } = deps(tenki);
    await expect(up(d)).rejects.toThrow(/npm ci failed/);
    expect(tenki.calls).toContain("close sbx-1");
    expect(existsSync(join(root, RECORD_FILE))).toBe(false);
    expect(tenki.closes()).toBe(1);
  });

  it("refuses an old Node in the sandbox", async () => {
    const tenki = fakeTenki({ node: "v18.19.0" });
    const { d } = deps(tenki);
    await expect(up(d)).rejects.toThrow(/Node >= 22/);
    expect(tenki.calls).toContain("close sbx-1");
  });

  it("refuses to start a second sandbox while one is running", async () => {
    const tenki = fakeTenki();
    const { d } = deps(tenki);
    await up(d);
    await expect(up(d)).rejects.toThrow(/still RUNNING/);
  });

  it("requires the keys", async () => {
    const tenki = fakeTenki();
    const { d } = deps(tenki);
    await expect(up({ ...d, env: { TENKI_API_KEY: "tk" } })).rejects.toThrow(/NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN/);
    await expect(up({ ...d, env: { NETLIFY_SITE_ID: "s", NETLIFY_AUTH_TOKEN: "t" } })).rejects.toThrow(/TENKI_API_KEY/);
  });

  it("status, logs and stop", async () => {
    const tenki = fakeTenki();
    const { d, lines, root } = deps(tenki);
    await up(d);
    lines.length = 0;
    await main(["status"], d);
    expect(lines.join("\n")).toMatch(/heartbeat: online, host=tenki sandbox=sbx-1/);
    expect(lines.join("\n")).toMatch(/sandbox: sbx-1 RUNNING/);
    lines.length = 0;
    await main(["logs", "-n", "50"], d);
    expect(tenki.calls.some((c) => c.includes(`tail -n 50 ${LOG_FILE}`))).toBe(true);
    expect(lines).toEqual(["line1\nline2"]);
    await main(["stop"], d);
    expect(tenki.calls.some((c) => c.includes("kill -TERM"))).toBe(true);
    expect(tenki.calls).toContain("close sbx-1");
    expect(existsSync(join(root, RECORD_FILE))).toBe(false);
    await expect(main(["nope"], d)).rejects.toThrow(/usage/);
  });

  it("stop is a no-op without a record; a dead sandbox just clears it", async () => {
    const tenki = fakeTenki();
    const { d, lines, root } = deps(tenki);
    await main(["stop"], d);
    expect(lines.at(-1)).toMatch(/nothing to stop/);
    writeFileSync(join(root, RECORD_FILE), JSON.stringify({ sandboxId: "gone" }));
    await main(["stop"], d);
    expect(lines.at(-1)).toMatch(/already gone/);
    expect(existsSync(join(root, RECORD_FILE))).toBe(false);
  });

  it("quotes env values for bash", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(envFile({ A: "x y", B: "$HOME" })).toContain("export A='x y'\nexport B='$HOME'\n");
    expect(() => envFile({ "bad-name": "x" })).toThrow();
  });
});
