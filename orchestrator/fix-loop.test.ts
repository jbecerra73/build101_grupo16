import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyDecision, FixLoop } from "@frictionswarm/pipeline";
import { describe, expect, it } from "vitest";
import { buyTshirt, DIFF_UNAVAILABLE, unavailableDiff, type FixResult, type Finding, type Metrics, type PersonaMetrics, type RunConfig } from "../shared";
import { applyDecision, readJson, retestSeeds, runFixLoop, type FixLoopOptions } from "./fix-loop";

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
    ghImpl: async (args) => (ghCalls.push(args), args[1] === "diff" ? "diff --git a/src/app/checkout/page.tsx b/src/app/checkout/page.tsx" : ""),
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

const retryFinding: Finding = {
  id: "R1", severity: "high", segments: ["mobile"], personas: ["kai"], step: "Product", page: "/shop/product/*",
  title: "Sizes hidden behind hover", suggestedFix: "Show size buttons",
  evidence: { sessions: 4, users: 4, exampleSessions: [], quotes: [] },
};

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
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["diff", "edit", "ready"]);
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

  it("not proven: labels the PR and leaves it open for the decision, after one attempt by default", async () => {
    const { opts, ghCalls } = await setup([metrics("r1", 0, 0, 1)]);
    const result = await runFixLoop(opts);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven"]);
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["diff", "comment", "edit"]);
  });

  it("fixes exactly the chosen findings, in order, and saves the PR diff", async () => {
    const { runsDir, opts, agentCalls } = await setup([metrics("r1", 6, 7, 10)]);
    await runFixLoop({ ...opts, findingIds: ["F3", "F1"] });
    expect(agentCalls).toEqual([{ attempt: 1, findingIds: ["F3", "F1"] }]);
    const diff = await readFile(join(runsDir, "fixture-analysis", "fix", "pr.diff"), "utf8");
    expect(diff).toContain("diff --git a/src/app/checkout/page.tsx b/src/app/checkout/page.tsx");
  });

  it("rejects an unknown chosen finding", async () => {
    const { opts, agentCalls } = await setup([]);
    await expect(runFixLoop({ ...opts, findingIds: ["nope"] })).rejects.toThrow('Unknown finding "nope"');
    expect(agentCalls).toEqual([]);
  });

  it("a PR diff that can't be fetched is logged, not fatal", async () => {
    const { opts } = await setup([metrics("r1", 6, 7, 10)]);
    const logs: string[] = [];
    const result = await runFixLoop({
      ...opts,
      log: (l) => void logs.push(l),
      ghImpl: async (args) => {
        if (args[1] === "diff") throw new Error("gh pr diff failed: boom");
        return "";
      },
    });
    expect(result.attempts[0].status).toBe("ready");
    expect(logs.some((l) => l.includes("could not save the PR diff") && l.includes("boom"))).toBe(true);
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

    // Attempt 1: a retry comment, the PR stays open. Attempt 2 (the last): labelled not-proven and
    // still open for the Product Owner's decision. The diff is re-fetched after each push.
    const prCalls = ghCalls.filter((c) => c[0] === "pr");
    expect(prCalls.map((c) => c[1])).toEqual(["diff", "comment", "diff", "comment", "edit"]);
    const comments = prCalls.filter((c) => c[1] === "comment");
    expect(comments[0][6]).toContain("attempt 1 not proven yet, retrying");
    expect(comments[0][6]).toContain("Sizes hidden behind hover");
    expect(comments[1][6]).toContain("not proven (attempt 2)");
    expect(prCalls.every((c) => c[2] === "41")).toBe(true);
    expect(result.attempts.map((a) => a.branch)).toEqual(["b1", "b1"]);
  });

  it("a retry keeps the targets when the re-test names no friction", async () => {
    const { opts, agentCalls } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 6, 7, 10)]);
    const result = await runFixLoop({ ...opts, maxAttempts: 3 });
    expect(agentCalls.map((c) => c.findingIds)).toEqual([["F1", "F2", "F3"], ["F1", "F2", "F3"]]);
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven", "ready"]);
  });

  // Main closed the PR here; this branch's decision gate never auto-closes, so the PR is labelled
  // not-proven on the last verdict and left open.
  // The run then parks in awaiting-decision, so the Product Owner can still reject the PR.
  it("a failed retry labels the PR not-proven on the last verdict, re-fetches the diff and returns for the decision", async () => {
    const { runsDir, opts, ghCalls } = await setup([metrics("r1", 0, 0, 1)]);
    const agent = opts.codingAgent!;
    const ghImpl = opts.ghImpl!;
    let diffs = 0;
    const result = await runFixLoop({
      ...opts,
      maxAttempts: 2,
      ghImpl: async (args) => (args[1] === "diff" ? (ghCalls.push(args), `diff --git a/v${++diffs} b/v${diffs}`) : ghImpl(args)),
      codingAgent: async (shell, input) => {
        if (input.retry) throw new Error("build fails after the fix");
        return agent(shell, input);
      },
    });
    expect(result.attempts.map((a) => a.status)).toEqual(["not-proven", "not-proven"]);
    expect(result.attempts[1]).toMatchObject({ prNumber: 41, prUrl: "u", branch: "b1", error: "build fails after the fix" });
    expect(result.attempts[1].verdict).toBeUndefined();
    expect(ghCalls.filter((c) => c[0] === "pr").map((c) => c[1])).toEqual(["diff", "comment", "comment", "edit", "diff"]);
    expect(ghCalls.some((c) => c[0] === "label" && c[1] === "create")).toBe(true);
    expect(ghCalls.some((c) => c[0] === "pr" && (c[1] === "close" || c[1] === "merge"))).toBe(false);
    expect(await readFile(join(runsDir, "fixture-analysis", "fix", "pr.diff"), "utf8")).toBe("diff --git a/v2 b/v2\n");
    const saved = await readJson<FixResult>(join(runsDir, "fixture-analysis", "fix.json"));
    expect(saved.attempts.at(-1)).toMatchObject({ status: "not-proven", error: "build fails after the fix" });
  });

  it("a failed retry's diff that can't be re-fetched becomes the placeholder", async () => {
    const { runsDir, opts } = await setup([metrics("r1", 0, 0, 1)]);
    const agent = opts.codingAgent!;
    const ghImpl = opts.ghImpl!;
    let diffs = 0;
    await runFixLoop({
      ...opts,
      maxAttempts: 2,
      ghImpl: async (args) => {
        if (args[1] === "diff" && ++diffs === 2) throw new Error("gh pr diff failed: boom");
        return ghImpl(args);
      },
      codingAgent: async (shell, input) => {
        if (input.retry) throw new Error("build fails after the fix");
        return agent(shell, input);
      },
    });
    expect(await readFile(join(runsDir, "fixture-analysis", "fix", "pr.diff"), "utf8")).toBe(unavailableDiff(41, "gh pr diff failed: boom"));
  });

  it("a retry that fails after its verdict (finalizePr) still throws, without the last verdict's label", async () => {
    const { opts, ghCalls } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 6, 7, 10)], [retryFinding]);
    const ghImpl = opts.ghImpl!;
    await expect(
      runFixLoop({
        ...opts,
        maxAttempts: 2,
        ghImpl: async (args) => {
          if (args[0] === "pr" && args[1] === "ready") throw new Error("gh pr ready failed");
          return ghImpl(args);
        },
      }),
    ).rejects.toThrow("gh pr ready failed");
    expect(ghCalls.some((c) => c[0] === "label")).toBe(false);
  });

  it("retry: the chosen findings apply to attempt 1 only, and the PR is never closed", async () => {
    const newFinding: Finding = {
      id: "R1", severity: "high", segments: ["mobile"], personas: ["kai"], step: "Product", page: "/shop/product/*",
      title: "Sizes hidden behind hover", suggestedFix: "Show size buttons",
      evidence: { sessions: 4, users: 4, exampleSessions: [], quotes: [] },
    };
    const { opts, agentCalls, ghCalls } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 0, 0, 1)], [newFinding]);
    const result = await runFixLoop({ ...opts, maxAttempts: 2, findingIds: ["F3"] });
    // The PO's chosen findings apply to attempt 1 only; the retry takes the re-test's.
    expect(agentCalls.map((c) => c.findingIds)).toEqual([["F3"], ["R1"]]);
    expect(result.attempts.map((a) => a.prNumber)).toEqual([41, 41]);
    expect(ghCalls.some((a) => a[0] === "pr" && a[1] === "close")).toBe(false);
    expect(ghCalls.some((a) => a[1] === "comment" && a[2] === "41" && a.some((x) => x.includes("retrying")))).toBe(true);
  });

  it("retry: the saved diff is re-fetched after each push, so it shows the PR's latest commit", async () => {
    const { runsDir, opts } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 0, 0, 1)], [retryFinding]);
    const ghImpl = opts.ghImpl!;
    let diffs = 0;
    await runFixLoop({
      ...opts,
      maxAttempts: 2,
      ghImpl: async (args) => (args[1] === "diff" ? `diff --git a/v${++diffs} b/v${diffs}` : ghImpl(args)),
    });
    expect(diffs).toBe(2);
    const diff = await readFile(join(runsDir, "fixture-analysis", "fix", "pr.diff"), "utf8");
    expect(diff).toBe("diff --git a/v2 b/v2\n");
  });

  it("retry: a diff that can't be fetched after the retry's push replaces attempt 1's with a placeholder", async () => {
    const { runsDir, opts } = await setup([metrics("r1", 0, 0, 1), metrics("r2", 0, 0, 1)], [retryFinding]);
    const ghImpl = opts.ghImpl!;
    let diffs = 0;
    await runFixLoop({
      ...opts,
      maxAttempts: 2,
      ghImpl: async (args) => {
        if (args[1] === "diff" && ++diffs === 2) throw new Error("gh pr diff failed: boom");
        return ghImpl(args);
      },
    });
    const diff = await readFile(join(runsDir, "fixture-analysis", "fix", "pr.diff"), "utf8");
    expect(diff).toBe(unavailableDiff(41, "gh pr diff failed: boom"));
    expect(diff.startsWith(DIFF_UNAVAILABLE)).toBe(true);
    expect(diff).not.toContain("diff --git");
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

describe("applyDecision", () => {
  const fixDir = async (attempt: Partial<FixResult["attempts"][number]>) => {
    const runsDir = await mkdtemp(join(tmpdir(), "fs-decision-"));
    await cp(join(import.meta.dirname, "..", "runs", "fixture-analysis"), join(runsDir, "r"), { recursive: true });
    const fix: FixResult = { baselineRunId: "r", repo: "FrissA/demo-ecommerce", attempts: [{ attempt: 1, findingIds: ["F1"], status: "ready", ...attempt }] };
    await writeFile(join(runsDir, "r", "fix.json"), JSON.stringify(fix));
    return runsDir;
  };
  const request = (decision: "accept" | "reject", reason?: string) => ({ runId: "r", decision, reason, requestedAt: "2026-10-17T12:00:00Z" });

  it("accept merges the PR and records the merge sha", async () => {
    const asPipelineHook: ApplyDecision = applyDecision; // compile-time check of the seam
    expect(asPipelineHook).toBe(applyDecision);
    const runsDir = await fixDir({ prNumber: 41 });
    const calls: string[][] = [];
    const ghImpl = async (args: string[]) => (calls.push(args), args[1] !== "view" ? "" : args.includes("isDraft") ? "false" : "mergesha1");
    const a = await applyDecision({ runsDir, runId: "r", request: request("accept"), log: () => {}, ghImpl });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["pr view 41", "pr merge 41", "pr view 41"]);
    expect(a).toMatchObject({ status: "merged", decision: { decision: "accept", mergeSha: "mergesha1", decidedAt: expect.any(String) } });
    const saved = await readJson<FixResult>(join(runsDir, "r", "fix.json"));
    expect(saved.attempts[0]).toEqual(a);
  });

  it("accepting a not-proven fix (override) marks its draft PR ready, then merges", async () => {
    const runsDir = await fixDir({ prNumber: 41, status: "not-proven" });
    const calls: string[][] = [];
    const ghImpl = async (args: string[]) => (calls.push(args), args[1] !== "view" ? "" : args.includes("isDraft") ? "true" : "mergesha2");
    const a = await applyDecision({ runsDir, runId: "r", request: { ...request("accept"), override: true }, log: () => {}, ghImpl });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["pr view 41", "pr ready 41", "pr merge 41", "pr view 41"]);
    expect(a).toMatchObject({ status: "merged", decision: { decision: "accept", override: true, mergeSha: "mergesha2" } });
  });

  it("reject closes the PR with the reason", async () => {
    const runsDir = await fixDir({ prNumber: 41, status: "not-proven" });
    const calls: string[][] = [];
    const ghImpl = async (args: string[]) => (calls.push(args), "");
    const a = await applyDecision({ runsDir, runId: "r", request: request("reject", "too risky"), log: () => {}, ghImpl });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["pr comment 41", "pr close 41"]);
    expect(a).toMatchObject({ status: "rejected", decision: { decision: "reject", reason: "too risky" } });
  });

  it("refuses when the last attempt has no PR", async () => {
    const runsDir = await fixDir({});
    await expect(applyDecision({ runsDir, runId: "r", request: request("accept"), log: () => {} })).rejects.toThrow("No PR to decide on");
  });
});
