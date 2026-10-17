import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FixResult, Finding, Metrics, PersonaMetrics, RunConfig } from "../shared";
import { freshSeeds, readJson, runFixLoop, type FixLoopOptions } from "./fix-loop";

const persona = (personaId: string, completed: number): PersonaMetrics => ({
  personaId, n: 10, completed, completionRate: completed / 10, gaveUp: 10 - completed,
  invalidCompletions: 0, medianSteps: completed ? 18 : 0, medianTimeMs: completed ? 45_000 : 0, funnel: [],
});
const metrics = (runId: string, rosa: number, kai: number, typical: number): Metrics => ({
  runId, flowId: "buy-tshirt", buildSha: "x",
  personas: [persona("rosa", rosa), persona("kai", kai), persona("typical", typical)],
});

async function setup(retests: Metrics[], retestFindings: Finding[] = []) {
  const runsDir = await mkdtemp(join(tmpdir(), "fs-runs-"));
  await cp(join(import.meta.dirname, "..", "runs", "fixture-baseline"), join(runsDir, "fixture-baseline"), { recursive: true });
  const swarmConfigs: RunConfig[] = [];
  const agentCalls: { attempt: number; findingIds: string[] }[] = [];
  const ghCalls: string[][] = [];
  const opts: FixLoopOptions = {
    baselineRunId: "fixture-baseline",
    runsDir,
    log: () => {},
    shell: async () => ({ home: "/x", exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), writeFile: async () => {}, close: async () => {} }),
    codingAgent: async (_shell, input) => {
      agentCalls.push({ attempt: input.attempt, findingIds: input.findings.map((f) => f.id) });
      return { branch: `b${input.attempt}`, commitSha: `sha${input.attempt}`, prNumber: 40 + input.attempt, prUrl: "u", summary: "s" };
    },
    waitForBuild: async () => {},
    runSwarm: async (c) => void swarmConfigs.push(c),
    analyze: async () => ({ metrics: retests.shift()!, findings: retestFindings }),
    ghImpl: async (args) => (ghCalls.push(args), args[0] === "api" ? "" : ""),
  };
  return { runsDir, opts, swarmConfigs, agentCalls, ghCalls };
}

describe("freshSeeds", () => {
  it("never reuses a baseline seed or an earlier attempt's seed", () => {
    const base = { rosa: [1, 2, 3], kai: [1, 2, 3] };
    const a1 = freshSeeds(base, 1);
    const a2 = freshSeeds(base, 2);
    for (const p of ["rosa", "kai"] as const)
      expect(new Set([...base[p], ...a1[p], ...a2[p]]).size).toBe(9);
  });
});

describe("runFixLoop", () => {
  it("improved: re-tests the preview build with fresh seeds and marks the PR ready", async () => {
    const { runsDir, opts, swarmConfigs, agentCalls, ghCalls } = await setup([metrics("r1", 6, 7, 10)]);
    const result = await runFixLoop({ ...opts, maxFindings: 2 });

    expect(agentCalls).toEqual([{ attempt: 1, findingIds: ["F1", "F2"] }]);
    const [retest] = swarmConfigs;
    expect(retest).toMatchObject({ kind: "retest", targetUrl: "https://deploy-preview-41--swarm-ecommerce.netlify.app", buildSha: "sha1", baselineRunId: "fixture-baseline" });
    expect(retest.seeds.kai.some((s) => [1, 2].includes(s))).toBe(false);

    expect(result.attempts[0]).toMatchObject({ status: "ready", prNumber: 41, retestRunId: "fixture-baseline-retest1" });
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["edit", "ready"]);
    const saved = await readJson<FixResult>(join(runsDir, "fixture-baseline", "fix.json"));
    expect(saved.attempts[0].verdict?.improved).toBe(true);
  });

  it("not proven: closes with the label after one attempt by default", async () => {
    const { opts, ghCalls } = await setup([metrics("r1", 0, 0, 1)]);
    const result = await runFixLoop(opts);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven"]);
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["comment", "edit", "close"]);
  });

  it("retry (stretch): a second attempt uses the re-test's findings, never a third", async () => {
    const newFinding: Finding = {
      id: "R1", severity: "high", personas: ["kai"], step: "Product", page: "/shop/product/*",
      title: "Sizes hidden behind hover", suggestedFix: "Show size buttons",
      evidence: { screenshots: [], quotes: [], agentCount: 4 },
    };
    const { opts, agentCalls, swarmConfigs } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 0, 0, 1)], [newFinding]);
    const result = await runFixLoop({ ...opts, maxAttempts: 2 });
    expect(agentCalls.map((c) => c.findingIds)).toEqual([["F1", "F2", "F3"], ["R1"]]);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven", "not-proven"]);
    expect(swarmConfigs[0].seeds.kai).not.toEqual(swarmConfigs[1].seeds.kai);
  });

  it("records a failed attempt in fix.json", async () => {
    const { runsDir, opts } = await setup([]);
    await expect(
      runFixLoop({ ...opts, codingAgent: async () => { throw new Error("guardrail: no changes"); } }),
    ).rejects.toThrow("guardrail");
    const saved = await readJson<FixResult>(join(runsDir, "fixture-baseline", "fix.json"));
    expect(saved.attempts[0]).toMatchObject({ status: "failed", error: "guardrail: no changes" });
  });
});
