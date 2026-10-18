import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunConfig } from "../../shared";
import { FakeSandboxProvider, finishingWorker, hangingWorker, type FakeWorker } from "./fake";
import { FIRST_SEED, peekNextSeed, reserveSeeds } from "./ledger";
import { freshSeeds, planSwarm } from "./plan";
import { sandboxPath } from "./provider";
import { runSwarm, SwarmAbortedError, type RunSwarmOptions } from "./run";
import { generateArgs } from "./runner";
import { localResultsWaiter, SwarmWaitTimeout, type SwarmWaiter } from "./wait";

const PERSONAS = ["rosa", "kai", "typical"];
const tmp = () => mkdtempSync(join(tmpdir(), "swarm-test-"));
const until = async (cond: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

function setup(provider: FakeSandboxProvider, over: Partial<RunSwarmOptions> = {}) {
  const runsDir = tmp();
  const waiter: SwarmWaiter & { calls: { agentIds: string[]; closedAtCall: boolean[] }[] } = {
    calls: [],
    async waitForSwarm(q) {
      waiter.calls.push({ agentIds: q.agentIds, closedAtCall: provider.sandboxes.map((s) => s.closed) });
    },
  };
  const opts: RunSwarmOptions = {
    runId: "r1",
    flowId: "buy-tshirt",
    previewUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app",
    buildSha: "abc123",
    personaIds: PERSONAS,
    provider,
    waiter,
    runsDir,
    ledgerFile: join(runsDir, ".swarm-ledger.json"),
    pollMs: 5,
    log: () => {},
    ...over,
  };
  return { opts, runsDir, waiter };
}

describe("planSwarm", () => {
  const seeds = freshSeeds(PERSONAS, 10, 1001);

  it("spreads 3 personas × 10 seeds over 5 sandboxes of 6, mixing personas", () => {
    const plan = planSwarm({ runId: "r1", previewUrl: "https://p.test", personaIds: PERSONAS, seeds });
    expect(plan.agents).toHaveLength(30);
    expect(new Set(plan.agents.map((a) => a.agentId)).size).toBe(30);
    expect(plan.sandboxes.map((s) => s.length)).toEqual([6, 6, 6, 6, 6]);
    for (const s of plan.sandboxes) expect(new Set(s.map((a) => a.personaId))).toEqual(new Set(PERSONAS));
    expect(plan.sandboxes.flat().map((a) => a.agentId).sort()).toEqual(plan.agents.map((a) => a.agentId).sort());
  });

  it("tags each agent's start URL with run, agent and persona", () => {
    const plan = planSwarm({ runId: "r1", previewUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app", personaIds: PERSONAS, seeds });
    const kai = plan.agents.find((a) => a.agentId === "kai-1007")!;
    expect(kai).toMatchObject({ personaId: "kai", seed: 1007 });
    expect(kai.startUrl).toBe("https://deploy-preview-12--swarm-ecommerce.netlify.app/?swarm=r1&agent=kai-1007&persona=kai");
  });

  it("uses only as many sandboxes as needed and refuses more than the limit", () => {
    expect(planSwarm({ runId: "r", previewUrl: "https://p.test", personaIds: PERSONAS, seeds: freshSeeds(PERSONAS, 2, 1) }).sandboxes).toHaveLength(1);
    expect(planSwarm({ runId: "r", previewUrl: "https://p.test", personaIds: PERSONAS, seeds: freshSeeds(PERSONAS, 3, 1) }).sandboxes.map((s) => s.length)).toEqual([5, 4]);
    expect(() => planSwarm({ runId: "r", previewUrl: "https://p.test", personaIds: PERSONAS, seeds: freshSeeds(PERSONAS, 11, 1) })).toThrow(/limit is 5/);
    expect(() => planSwarm({ runId: "r", previewUrl: "https://p.test", personaIds: ["rosa"], seeds: { rosa: [1, 1] } })).toThrow(/Duplicate/);
  });
});

describe("ledger", () => {
  it("hands out fresh, non-overlapping seeds across runs", () => {
    const file = join(tmp(), "ledger.json");
    expect(peekNextSeed(file)).toBe(FIRST_SEED);
    expect(reserveSeeds(file, 10)).toBe(FIRST_SEED);
    expect(reserveSeeds(file, 10)).toBe(FIRST_SEED + 10);
    expect(peekNextSeed(file)).toBe(FIRST_SEED + 20);
  });
});

describe("runSwarm", () => {
  it("runs 30 agents in 5 sandboxes, copies their results, closes every sandbox, then waits for PostHog", async () => {
    const provider = new FakeSandboxProvider();
    const { opts, runsDir, waiter } = setup(provider, { env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, model: "haiku" });
    const { results, config } = await runSwarm(opts);

    expect(provider.sandboxes).toHaveLength(5);
    expect(provider.sandboxes.every((s) => s.closeCalls === 1)).toBe(true);
    expect(results).toHaveLength(30);
    expect(existsSync(join(runsDir, "r1", "screenshots", "rosa-1001.png"))).toBe(true);
    expect(existsSync(join(runsDir, "r1", "agents", "typical-1010.json"))).toBe(true);
    // waitForSwarm comes after the sandboxes are gone (nothing billing while PostHog ingests).
    expect(waiter.calls).toHaveLength(1);
    expect(waiter.calls[0].agentIds).toHaveLength(30);
    expect(waiter.calls[0].closedAtCall.every(Boolean)).toBe(true);
    // The run folder records the swarm for the analyzer.
    expect(config).toMatchObject({ runId: "r1", kind: "retest", posthog: { source: "api", buildSha: "abc123" }, personaIds: PERSONAS });
    expect(config.seeds.kai).toEqual(Array.from({ length: 10 }, (_, i) => FIRST_SEED + i));
    expect(JSON.parse(readFileSync(join(runsDir, "r1", "config.json"), "utf8"))).toEqual(config);
    // The worker gets its input and run folder under /home/tenki, and credentials via env.
    const sb = provider.sandboxes[0];
    const argv = sb.started[0].argv;
    expect(argv[argv.indexOf("--input") + 1]).toBe("/home/tenki/runs/r1/worker-1.json");
    expect(argv[argv.indexOf("--runs") + 1]).toBe("/home/tenki/runs");
    expect(sb.started[0].cwd).toBe("/home/tenki/frictionswarm");
    expect(sb.options.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "t", AGENT_MODEL: "haiku" });
    for (const s of provider.sandboxes) for (const path of s.files.keys()) expect(path.startsWith("/home/tenki/")).toBe(true);
  });

  it("uses fresh seeds on the next run", async () => {
    const provider = new FakeSandboxProvider();
    const { opts } = setup(provider);
    const first = await runSwarm(opts);
    const second = await runSwarm({ ...opts, runId: "r2" });
    const a = new Set(first.config.seeds.rosa);
    expect(second.config.seeds.rosa.some((s) => a.has(s))).toBe(false);
  });

  it("shows live-grid screenshots in the run folder while agents are still running", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const slow: FakeWorker = async (ctx) => {
      const [first] = ctx.input.agents;
      await ctx.sandbox.writeFile(`${ctx.runsDir}/${ctx.input.runId}/screenshots/${first.personaId}-${first.seed}.png`, new Uint8Array([1]));
      await released;
      return finishingWorker(ctx);
    };
    const provider = new FakeSandboxProvider({ workerFor: () => slow });
    const { opts, runsDir } = setup(provider);
    const run = runSwarm(opts);
    await until(() => existsSync(join(runsDir, "r1", "screenshots", "rosa-1001.png")));
    expect(provider.sandboxes.some((s) => s.closed)).toBe(false);
    release();
    await run;
  });

  it("closes every sandbox and stops the other workers when one worker fails", async () => {
    const provider = new FakeSandboxProvider({ workerFor: (n) => (n === 3 ? async () => 1 : hangingWorker) });
    const { opts, waiter } = setup(provider);
    await expect(runSwarm(opts)).rejects.toThrow(/sandbox 3 .* exited 1/);
    expect(provider.sandboxes).toHaveLength(5);
    expect(provider.sandboxes.every((s) => s.closeCalls === 1)).toBe(true);
    expect(provider.sandboxes.filter((s, i) => i !== 2).every((s) => s.started[0].stopped)).toBe(true);
    expect(waiter.calls).toHaveLength(0);
  });

  it("closes the sandboxes it got when creating another one fails", async () => {
    const provider = new FakeSandboxProvider({ failCreate: 4, workerFor: () => hangingWorker });
    const { opts } = setup(provider);
    await expect(runSwarm(opts)).rejects.toThrow(/no capacity/);
    expect(provider.creates).toBe(5);
    expect(provider.sandboxes).toHaveLength(4);
    expect(provider.sandboxes.every((s) => s.closeCalls === 1)).toBe(true);
  });

  it("closes every sandbox on abort (Ctrl-C), including ones still being created", async () => {
    const provider = new FakeSandboxProvider({ workerFor: () => hangingWorker, createDelayMs: 20 });
    const abort = new AbortController();
    const { opts, waiter } = setup(provider, { signal: abort.signal });
    const run = runSwarm(opts);
    await new Promise((r) => setTimeout(r, 5)); // creates still in flight
    abort.abort();
    await expect(run).rejects.toBeInstanceOf(SwarmAbortedError);
    expect(provider.sandboxes).toHaveLength(5);
    expect(provider.sandboxes.every((s) => s.closeCalls === 1)).toBe(true);
    // Sandboxes that came up after the abort never started a worker.
    expect(provider.sandboxes.every((s) => s.started.length === 0)).toBe(true);
    expect(waiter.calls).toHaveLength(0);
  });

  it("stops running workers and closes sandboxes on abort mid-run", async () => {
    const provider = new FakeSandboxProvider({ workerFor: () => hangingWorker });
    const abort = new AbortController();
    const { opts } = setup(provider, { signal: abort.signal });
    const run = runSwarm(opts);
    await until(() => provider.sandboxes.length === 5 && provider.sandboxes.every((s) => s.started.length === 1));
    abort.abort();
    await expect(run).rejects.toBeInstanceOf(SwarmAbortedError);
    expect(provider.sandboxes.every((s) => s.started[0].stopped && s.closeCalls === 1)).toBe(true);
  });

  it("honours seeds given by the pipeline", async () => {
    const provider = new FakeSandboxProvider();
    const { opts, waiter } = setup(provider, { personaIds: ["rosa"], seeds: { rosa: [7, 8] } });
    await runSwarm(opts);
    expect(provider.sandboxes).toHaveLength(1);
    expect(waiter.calls[0].agentIds).toEqual(["rosa-7", "rosa-8"]);
  });
});

describe("localResultsWaiter", () => {
  it("times out naming the agents still missing", async () => {
    const provider = new FakeSandboxProvider();
    const { opts, runsDir } = setup(provider, { personaIds: ["rosa"], seeds: { rosa: [1] } });
    await runSwarm(opts);
    await expect(localResultsWaiter(runsDir, 5).waitForSwarm({ runId: "r1", agentIds: ["rosa-1"], timeoutMs: 50 })).resolves.toBeUndefined();
    const err = await localResultsWaiter(runsDir, 5).waitForSwarm({ runId: "r1", agentIds: ["rosa-1", "kai-2"], timeoutMs: 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(SwarmWaitTimeout);
    expect(err.missing).toEqual(["kai-2"]);
  });
});

describe("sandboxPath", () => {
  it("keeps everything under /home/tenki", () => {
    expect(sandboxPath("runs", "r1")).toBe("/home/tenki/runs/r1");
    expect(() => sandboxPath("..", "etc")).toThrow();
  });
});

describe("offline runner", () => {
  const config: RunConfig = {
    runId: "r9",
    kind: "retest",
    flowId: "buy-tshirt",
    posthog: { source: "file", buildSha: "def456" },
    personaIds: PERSONAS,
    seeds: freshSeeds(PERSONAS, 10, 1001),
    targetUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app/",
    createdAt: "2026-10-17T00:00:00Z",
  };

  it("builds the posthog:generate swarm-mode arguments from the RunConfig", () => {
    expect(generateArgs(config, ["T1", "T2"])).toEqual([
      "--swarm", "r9", "--flow", "buy-tshirt", "--sha", "def456", "--host", "deploy-preview-12--swarm-ecommerce.netlify.app",
      "--personas", "rosa,kai,typical", "--seeds", "1001-1010", "--fixed", "T1,T2",
    ]);
    expect(() => generateArgs({ ...config, seeds: { ...config.seeds, kai: [1, 3] } })).toThrow(/consecutive/);
  });
});

vi.setConfig({ testTimeout: 10_000 });
