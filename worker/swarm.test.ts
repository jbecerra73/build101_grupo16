import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SwarmAgentResult } from "../shared";
import { pool, runSwarmWorker, type SwarmWorkerInput } from "./swarm";

describe("pool", () => {
  it("never runs more than the limit at once and keeps results in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5 + (n % 3)));
      inFlight--;
      if (n === 5) throw new Error("five");
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : "x"))).toEqual([2, 4, 6, 8, "x", 12, 14, 16, 18]);
  });
});

describe("runSwarmWorker", () => {
  const input: SwarmWorkerInput = {
    runId: "r1",
    flowId: "buy-tshirt",
    targetUrl: "https://preview.test",
    agents: [1, 2, 3, 4].flatMap((seed) => ["rosa", "kai"].map((personaId) => ({ personaId, seed }))),
  };

  it("runs at most 6 agents at once, all in one shared browser, and closes it", async () => {
    let inFlight = 0;
    let peak = 0;
    let closed = 0;
    const seen: { agentId: string; browserWs?: string; runDir: string; targetUrl: string }[] = [];
    const results = await runSwarmWorker(input, {
      runsDir: join(mkdtempSync(join(tmpdir(), "worker-")), "runs"),
      model: "haiku",
      timeoutMs: 1000,
      log: () => {},
      launchBrowser: async () => ({ wsEndpoint: () => "ws://browser", close: async () => void closed++ }),
      runAgent: async (o) => {
        peak = Math.max(peak, ++inFlight);
        const agentId = `${o.persona.id}-${o.seed}`;
        seen.push({ agentId, browserWs: o.browserWs, runDir: o.runDir, targetUrl: o.targetUrl });
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        const now = new Date().toISOString();
        const result: SwarmAgentResult = { runId: o.runId, agentId, personaId: o.persona.id, seed: o.seed, outcome: "give_up", actions: 3, startedAt: now, endedAt: now };
        return { result };
      },
    });
    expect(results).toHaveLength(8);
    expect(peak).toBe(6);
    expect(closed).toBe(1);
    expect(seen.every((s) => s.browserWs === "ws://browser" && s.runDir.endsWith("/runs/r1") && s.targetUrl === "https://preview.test")).toBe(true);
  });

  it("rejects unknown personas before launching anything", async () => {
    let launched = false;
    await expect(
      runSwarmWorker({ ...input, agents: [{ personaId: "nobody", seed: 1 }] }, {
        runsDir: "/nowhere",
        model: "haiku",
        timeoutMs: 1000,
        launchBrowser: async () => ((launched = true), { wsEndpoint: () => "", close: async () => {} }),
      }),
    ).rejects.toThrow(/Unknown personas: nobody/);
    expect(launched).toBe(false);
  });
});
