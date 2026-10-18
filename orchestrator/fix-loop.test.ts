import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixLoop } from "@frictionswarm/pipeline";
import { describe, expect, it } from "vitest";
import { buyTshirt, type FixResult, type Finding, type Metrics, type PersonaMetrics, type RunConfig } from "../shared";
import { readJson, retestSeeds, runFixLoop, type FixLoopOptions } from "./fix-loop";

// Every agent reaches each required step; the ones that don't complete stop before Confirmation.
const funnel = (completed: number) =>
  buyTshirt.required.steps.map((step, i, all) => ({ step, reached: i === all.length - 1 ? completed : 10, droppedHere: 0 }));
const persona = (personaId: string, completed: number): PersonaMetrics => ({
  personaId, n: 10, users: 10, completed, completionRate: completed / 10, gaveUp: 10 - completed,
  invalidCompletions: 0, medianSteps: completed ? 18 : 0, medianTimeMs: completed ? 45_000 : 0, funnel: funnel(completed),
});
// Retest metrics; fixture-analysis has low_vision 4%, mobile 5%, desktop 15%.
const metrics = (runId: string, rosa: number, kai: number, typical: number): Metrics => ({
  runId, flowId: "buy-tshirt", buildSha: "x", segments: [],
  personas: [persona("rosa", rosa), persona("kai", kai), persona("typical", typical)],
});

async function setup(retests: Metrics[], retestFindings: Finding[] = []) {
  const runsDir = await mkdtemp(join(tmpdir(), "fs-runs-"));
  await cp(join(import.meta.dirname, "..", "runs", "fixture-analysis"), join(runsDir, "fixture-analysis"), { recursive: true });
  const swarmConfigs: RunConfig[] = [];
  const agentCalls: { attempt: number; findingIds: string[] }[] = [];
  const ghCalls: string[][] = [];
  const opts: FixLoopOptions = {
    baselineRunId: "fixture-analysis",
    runsDir,
    log: () => {},
    shell: async () => ({ home: "/x", exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), writeFile: async () => {}, close: async () => {} }),
    codingAgent: async (_shell, input) => {
      agentCalls.push({ attempt: input.attempt, findingIds: input.findings.map((f) => f.id) });
      const pr = input.retry ?? { branch: `b${input.attempt}`, prNumber: 40 + input.attempt, prUrl: "u" };
      return { branch: pr.branch, commitSha: `sha${input.attempt}`, prNumber: pr.prNumber, prUrl: pr.prUrl, summary: "s" };
    },
    waitForBuild: async () => {},
    runSwarm: async (c) => void swarmConfigs.push(c),
    analyze: async () => ({ metrics: retests.shift()!, findings: retestFindings }),
    ghImpl: async (args) => (ghCalls.push(args), args[0] === "api" ? "" : ""),
  };
  return { runsDir, opts, swarmConfigs, agentCalls, ghCalls };
}

describe("retestSeeds", () => {
  it("gives each attempt its own block of seeds", () => {
    expect(retestSeeds(["rosa"], 3, 1)).toEqual({ rosa: [1001, 1002, 1003] });
    const a1 = retestSeeds(["kai"], 10, 1).kai;
    const a2 = retestSeeds(["kai"], 10, 2).kai;
    expect(new Set([...a1, ...a2]).size).toBe(20);
  });
});

describe("runFixLoop", () => {
  it("improved: re-tests the preview build with fresh seeds and marks the PR ready", async () => {
    const { runsDir, opts, swarmConfigs, agentCalls, ghCalls } = await setup([metrics("r1", 6, 7, 10)]);
    const result = await runFixLoop({ ...opts, maxFindings: 2 });

    expect(agentCalls).toEqual([{ attempt: 1, findingIds: ["F1", "F2"] }]);
    const [retest] = swarmConfigs;
    expect(retest).toMatchObject({
      kind: "retest", targetUrl: "https://deploy-preview-41--swarm-ecommerce.netlify.app",
      posthog: { source: "file", buildSha: "sha1" }, baselineRunId: "fixture-analysis",
      personaIds: ["rosa", "kai", "typical"],
    });
    expect(retest.seeds.kai).toEqual(Array.from({ length: 10 }, (_, i) => 1001 + i));

    expect(result.attempts[0]).toMatchObject({ status: "ready", prNumber: 41, retestRunId: "fixture-analysis-retest1" });
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["edit", "ready"]);
    const saved = await readJson<FixResult>(join(runsDir, "fixture-analysis", "fix.json"));
    expect(saved.attempts[0].verdict?.improved).toBe(true);
  });

  it("plugs into the pipeline: its seeds, collect after the swarm, its compare", async () => {
    const asPipelineFixLoop: FixLoop = runFixLoop; // compile-time check of the seam
    const { opts, swarmConfigs } = await setup([metrics("r1", 6, 7, 10)]);
    const calls: string[] = [];
    const result = await asPipelineFixLoop({
      ...opts,
      runsDir: opts.runsDir!,
      log: () => {},
      retestSeeds: { rosa: [31, 32], kai: [33, 34], typical: [35, 36] },
      runSwarm: async (c) => void calls.push(`swarm ${c.runId}`),
      collect: async (c) => void calls.push(`collect ${c.runId}`),
      compare: (_a, _r, targeted) => (calls.push("compare"), { improved: true, targetedPersonas: targeted, comparisons: [], reasons: [] }),
    });
    expect(swarmConfigs).toEqual([]);
    expect(calls).toEqual(["swarm fixture-analysis-retest1", "collect fixture-analysis-retest1", "compare"]);
    expect(result.attempts[0].status).toBe("ready");
  });

  it("not proven: closes with the label after one attempt by default", async () => {
    const { opts, ghCalls } = await setup([metrics("r1", 0, 0, 1)]);
    const result = await runFixLoop(opts);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven"]);
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["comment", "edit", "close"]);
  });

  it("retries on the same PR with the re-test's findings, never past maxAttempts", async () => {
    const newFinding: Finding = {
      id: "F1", severity: "high", segments: ["mobile"], personas: ["kai"], step: "Product", page: "/shop/product/*",
      title: "Sizes hidden behind hover", suggestedFix: "Show size buttons", persistsFrom: "F2",
      evidence: { sessions: 4, users: 4, exampleSessions: [], quotes: ["where are the sizes"] },
    };
    const { runsDir, opts, agentCalls, swarmConfigs, ghCalls } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 0, 0, 1)], [newFinding]);
    const retries: unknown[] = [];
    const result = await runFixLoop({
      ...opts,
      maxAttempts: 2,
      codingAgent: async (shell, input) => {
        retries.push(input.retry);
        return opts.codingAgent!(shell, input);
      },
    });
    expect(agentCalls.map((c) => c.findingIds)).toEqual([["F1", "F2", "F3"], ["F1"]]);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven", "not-proven"]);
    expect(result.attempts[1].targets?.[0].title).toBe("Sizes hidden behind hover");
    expect(swarmConfigs[0].seeds.kai).not.toEqual(swarmConfigs[1].seeds.kai);

    // The retry continues attempt 1's branch and PR, with its change, verdict and the original findings.
    expect(retries[0]).toBeUndefined();
    expect(retries[1]).toMatchObject({
      attempt: 2, branch: "b1", prNumber: 41, previousSummary: "s",
      previousTargets: [{ id: "F1" }, { id: "F2" }, { id: "F3" }], original: [{ id: "F1" }, { id: "F2" }, { id: "F3" }],
      previousVerdict: { improved: false },
    });
    // The re-test's analyzer is told which fix it checks.
    expect(swarmConfigs[0].fix).toMatchObject({ attempt: 1, summary: "s", targets: [{ id: "F1" }, { id: "F2" }, { id: "F3" }] });
    expect(swarmConfigs[1].fix?.targets.map((t) => t.title)).toEqual(["Sizes hidden behind hover"]);
    const saved = await readJson<RunConfig>(join(runsDir, "fixture-analysis-retest1", "config.json"));
    expect(saved.fix?.attempt).toBe(1);

    // Attempt 1: a retry comment, the PR stays open. Attempt 2 (the last): not-proven and closed.
    const prCalls = ghCalls.filter((c) => c[0] === "pr");
    expect(prCalls.map((c) => c[1])).toEqual(["comment", "comment", "edit", "close"]);
    expect(prCalls[0][6]).toContain("attempt 1 not proven yet, retrying");
    expect(prCalls[0][6]).toContain("Sizes hidden behind hover");
    expect(prCalls[1][6]).toContain("not proven (attempt 2)");
    expect(prCalls.every((c) => c[2] === "41")).toBe(true);
    expect(result.attempts.map((a) => a.branch)).toEqual(["b1", "b1"]);
  });

  it("a retry keeps the targets when the re-test names no friction", async () => {
    const { opts, agentCalls } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 6, 7, 10)]);
    const result = await runFixLoop({ ...opts, maxAttempts: 3 });
    expect(agentCalls.map((c) => c.findingIds)).toEqual([["F1", "F2", "F3"], ["F1", "F2", "F3"]]);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven", "ready"]);
  });

  it("a failed retry closes the PR on the last verdict", async () => {
    const { opts, ghCalls } = await setup([metrics("r1", 0, 0, 1)]);
    const agent = opts.codingAgent!;
    await expect(
      runFixLoop({
        ...opts,
        maxAttempts: 2,
        codingAgent: async (shell, input) => {
          if (input.retry) throw new Error("build fails after the fix");
          return agent(shell, input);
        },
      }),
    ).rejects.toThrow("build fails");
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["comment", "comment", "edit", "close"]);
  });

  it("a re-test without agents fails the attempt instead of judging the fix", async () => {
    const { runsDir, opts, ghCalls } = await setup([metrics("r1", 0, 0, 0)].map((m) => ({ ...m, personas: m.personas.map((p) => ({ ...p, n: 0, users: 0 })) })));
    await expect(runFixLoop({ ...opts, maxAttempts: 2 })).rejects.toThrow("has no agents");
    const saved = await readJson<FixResult>(join(runsDir, "fixture-analysis", "fix.json"));
    expect(saved.attempts.map((a) => a.status)).toEqual(["failed"]);
    expect(ghCalls.filter((c) => c[0] === "pr")).toEqual([]);
  });

  it("records a failed attempt in fix.json", async () => {
    const { runsDir, opts } = await setup([]);
    await expect(
      runFixLoop({ ...opts, codingAgent: async () => { throw new Error("guardrail: no changes"); } }),
    ).rejects.toThrow("guardrail");
    const saved = await readJson<FixResult>(join(runsDir, "fixture-analysis", "fix.json"));
    expect(saved.attempts[0]).toMatchObject({ status: "failed", error: "guardrail: no changes" });
  });
});
