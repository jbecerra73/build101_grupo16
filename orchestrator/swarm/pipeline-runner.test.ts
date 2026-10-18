import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SwarmTopology } from "@frictionswarm/store";
import type { RunConfig } from "../../shared";
import { FakeSandboxProvider, hangingWorker } from "./fake";
import { tenkiRunnerFactory } from "./pipeline-runner";

const config: RunConfig = {
  runId: "retest-1",
  kind: "retest",
  flowId: "buy-tshirt",
  posthog: { source: "api", buildSha: "abc123" },
  personaIds: ["rosa", "kai", "typical"],
  seeds: { rosa: [1, 2, 3, 4], kai: [1, 2, 3, 4], typical: [1, 2, 3, 4] },
  targetUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app",
  createdAt: "2026-10-17T00:00:00.000Z",
};

function setup(provider: FakeSandboxProvider) {
  const runsDir = mkdtempSync(join(tmpdir(), "pipeline-runner-"));
  mkdirSync(join(runsDir, config.runId), { recursive: true });
  // The fix loop writes the re-test's config.json before calling the runner.
  writeFileSync(join(runsDir, config.runId, "config.json"), JSON.stringify({ ...config, note: "from the fix loop" }));
  const topologies: SwarmTopology[] = [];
  const abort = new AbortController();
  const runner = tenkiRunnerFactory({ provider: async () => provider, swarm: { pollMs: 5 } })({
    runsDir,
    signal: abort.signal,
    reportTopology: async (t) => void topologies.push(t),
    log: () => {},
  });
  return { runsDir, topologies, abort, runner };
}

describe("tenki runner for the pipeline", () => {
  it("runs the config's agents, reports each sandbox's state and leaves config.json alone", async () => {
    const provider = new FakeSandboxProvider();
    const { runsDir, topologies, runner } = setup(provider);
    await runner(config);

    expect(provider.sandboxes).toHaveLength(2);
    expect(provider.sandboxes.every((s) => s.closed)).toBe(true);
    expect(JSON.parse(readFileSync(join(runsDir, config.runId, "config.json"), "utf8")).note).toBe("from the fix loop");

    const first = topologies[0];
    expect(first.backend).toBe("tenki");
    expect(first.sandboxes.map((s) => s.status)).toEqual(["booting", "booting"]);
    expect(first.sandboxes.flatMap((s) => s.agentIds).sort()).toEqual(
      config.personaIds.flatMap((p) => config.seeds[p].map((s) => `${p}-${s}`)).sort(),
    );
    expect(topologies.some((t) => t.sandboxes.some((s) => s.status === "running"))).toBe(true);
    const last = topologies.at(-1)!;
    expect(last.sandboxes.map((s) => s.status)).toEqual(["done", "done"]);
    expect(last.sandboxes.map((s) => s.id)).toEqual(["fake-1", "fake-2"]);
    expect(last.sandboxes.every((s) => s.endedAt)).toBe(true);
  });

  it("rejects with \"cancelled\" and closes every sandbox when the run is cancelled", async () => {
    const provider = new FakeSandboxProvider({ workerFor: () => hangingWorker });
    const { topologies, abort, runner } = setup(provider);
    const run = runner(config);
    for (const end = Date.now() + 2000; !topologies.some((t) => t.sandboxes.every((s) => s.status === "running")); ) {
      if (Date.now() > end) throw new Error("sandboxes never ran");
      await new Promise((r) => setTimeout(r, 5));
    }
    abort.abort();
    await expect(run).rejects.toThrow("cancelled");
    expect(provider.sandboxes.every((s) => s.closed)).toBe(true);
    expect(topologies.at(-1)!.sandboxes.map((s) => s.status)).toEqual(["closed", "closed"]);
  });

  it("marks a sandbox that failed to come up", async () => {
    const provider = new FakeSandboxProvider({ failCreate: 2 });
    const { topologies, runner } = setup(provider);
    await expect(runner(config)).rejects.toThrow("no capacity");
    expect(topologies.at(-1)!.sandboxes[1].status).toBe("failed");
    expect(provider.sandboxes.every((s) => s.closed)).toBe(true);
  });
});
