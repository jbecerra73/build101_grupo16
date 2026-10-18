import { describe, expect, it } from "vitest";
import { buyTshirt, type FixAttempt, type PersonaComparison, type RunPhase, type SegmentMetrics } from "@frictionswarm/shared";
import type { RunDetail } from "../../dashboard/lib/types";
import { analysisReport, decisionPackage, flowCard, story, type Links } from "./format";

const links: Links = { dashboard: (p) => `http://localhost:3000${p}` };

const funnel = (n: number) => buyTshirt.steps.map((s, i) => ({ step: s.name, reached: Math.round(n / (i + 1)), droppedHere: i === 2 ? Math.round(n / 4) : 0 }));
const segment = (segmentId: SegmentMetrics["segmentId"], n: number): SegmentMetrics => ({
  segmentId,
  n,
  users: n,
  completed: Math.round(n / 10),
  completionRate: n ? 0.1 : 0,
  gaveUp: n - Math.round(n / 10),
  invalidCompletions: 0,
  medianSteps: 15,
  medianTimeMs: 160_000,
  funnel: n ? funnel(n) : [],
});

const comparison = (personaId: string, segmentId: SegmentMetrics["segmentId"], n: number, delta: number): PersonaComparison => ({
  personaId,
  segmentId,
  before: segment(segmentId, n),
  after: { ...segment(segmentId, 10), personaId, completionRate: 0.1 + delta / 100 },
  completionDeltaPts: delta,
  regressions: [],
});

const attempt = (over: Partial<FixAttempt> = {}): FixAttempt => ({
  attempt: 1,
  findingIds: ["F1"],
  status: "ready",
  branch: "frictionswarm/fix",
  commitSha: "abc1234ff",
  prNumber: 12,
  prUrl: "https://github.com/FrissA/demo-ecommerce/pull/12",
  previewUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app",
  summary: "Size buttons are visible and tappable.",
  retestRunId: "run-1-retest1",
  verdict: {
    improved: true,
    targetedPersonas: ["rosa", "kai"],
    comparisons: [comparison("rosa", "low_vision", 320, 34.4), comparison("kai", "mobile", 2625, 27), comparison("typical", "desktop", 1870, 2)],
    reasons: ["kai: +27 pts vs mobile (n=10 vs 2625)"],
  },
  ...over,
});

const run = (phase: RunPhase, over: Partial<RunDetail> = {}): RunDetail => ({
  runId: "run-1",
  config: {
    runId: "run-1",
    kind: "analysis",
    flowId: "buy-tshirt",
    window: { from: "2026-09-20", to: "2026-10-18" },
    posthog: { source: "file", buildSha: "f0a2c4e6b8d1" },
    personaIds: [],
    seeds: {},
    targetUrl: "https://swarm-ecommerce.netlify.app",
    createdAt: "2026-10-17T21:00:00.000Z",
  },
  status: { runId: "run-1", phase, updatedAt: "2026-10-17T21:01:00.000Z" },
  flow: buyTshirt,
  agents: [],
  giveUps: [],
  metrics: { runId: "run-1", flowId: "buy-tshirt", buildSha: "f0a2c4e6b8d1", segments: [segment("low_vision", 320), segment("mobile", 2625), segment("desktop", 1870)], personas: [] },
  findings: [
    {
      id: "F1",
      severity: "high",
      segments: ["low_vision", "mobile"],
      personas: ["rosa", "kai"],
      step: "Product",
      page: "/shop/product/*",
      title: "Mobile shoppers can't pick a size",
      evidence: {
        sessions: 533,
        users: 521,
        sinceRelease: { sha: "8e4d2a6", date: "2026-05-20", name: "New product page" },
        exampleSessions: ["s1", "s2", "s3", "s4"],
        quotes: [],
      },
      suggestedFix: "Show every size as a button.",
    },
  ],
  replayBase: "https://eu.posthog.com/project/1/replay/",
  ...over,
});

describe("flowCard", () => {
  it("shows goal, start URL, success, required fields and numbered steps with locks", () => {
    const card = flowCard(buyTshirt);
    expect(card).toContain("1. / → Home");
    expect(card).toContain("🔒 Cart");
    expect(card).toContain("Success: URL matches /checkout/success");
    expect(card).toContain("cardNumber");
    expect(card.indexOf("Goal")).toBeLessThan(card.indexOf("Start URL"));
    expect(card.indexOf("Start URL")).toBeLessThan(card.indexOf("Success"));
    expect(card.indexOf("Success")).toBeLessThan(card.indexOf("Required fields"));
    expect(card.indexOf("Required fields")).toBeLessThan(card.indexOf("1. / → Home"));
    expect(card).not.toContain("🔒 Home");
  });

  it("lists changes for an edit", () => {
    expect(flowCard(buyTshirt, ['goal: "a" → "b"'])).toContain('goal: "a" → "b"');
  });
});

describe("story", () => {
  const history = (["analyzing", "fixing", "waiting-preview", "retesting", "awaiting-decision"] as RunPhase[]).map((phase, i) => ({
    phase,
    at: `2026-10-17T21:0${i}:00.000Z`,
    message: phase === "analyzing" ? "Analyzing real users" : undefined,
  }));

  it("weaves the fix attempt into the phase history", () => {
    const r = run("awaiting-decision", {
      status: { runId: "run-1", phase: "awaiting-decision", updatedAt: "x", history },
      fix: { baselineRunId: "run-1", repo: "r", attempts: [attempt()] },
    });
    const text = story(r).join("\n");
    const pr = text.indexOf("PR #12 opened (draft)");
    const preview = text.indexOf("preview live (abc1234)");
    const awaiting = text.indexOf("awaiting your decision");
    expect(pr).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(pr);
    expect(awaiting).toBeGreaterThan(preview);
  });

  it("collapses consecutive duplicate history entries", () => {
    const dup = [history[0], { ...history[0], at: "2026-10-17T21:00:05.000Z" }];
    const r = run("analyzing", { status: { runId: "run-1", phase: "analyzing", updatedAt: "x", history: dup } });
    expect(story(r)).toHaveLength(1);
  });

  it("counts finished agents while re-testing", () => {
    const r = run("retesting", {
      status: { runId: "run-1", phase: "retesting", updatedAt: "x", history: history.slice(0, 4) },
      fix: { baselineRunId: "run-1", repo: "r", attempts: [attempt({ status: "retesting", verdict: undefined })] },
    });
    const lines = story(r, {
      runId: "run-1-retest1",
      backend: "offline",
      updatedAt: "x",
      sandboxes: [
        { id: "a", label: "sbx-1", status: "done", agentIds: ["rosa-1", "rosa-2"] },
        { id: "b", label: "sbx-2", status: "running", agentIds: ["kai-1"] },
      ],
    });
    expect(lines.at(-1)).toBe("… re-test 2/3 agents done");
  });
});

describe("decisionPackage", () => {
  const r = run("awaiting-decision", { fix: { baselineRunId: "run-1", repo: "r", attempts: [attempt()] } });

  it("covers the verdict, comparisons, findings, change, links and what accept does", () => {
    const pkg = decisionPackage(r, "diff --git a/x.tsx b/x.tsx\n+ok", links);
    expect(pkg).toContain("before = real users");
    expect(pkg).toContain("after = constrained persona agents");
    const rows = pkg.split("\n").filter((l) => l.includes("Δ +") && l.includes("N "));
    expect(rows).toHaveLength(3);
    expect(pkg).toContain("Mobile shoppers can't pick a size");
    expect(pkg).toContain("Size buttons are visible and tappable.");
    expect(pkg).toContain("https://github.com/FrissA/demo-ecommerce/pull/12");
    expect(pkg).toContain("http://localhost:3000/runs/run-1");
    expect(pkg).toContain("Accept merges to production main; reject closes the PR.");
  });

  it("shows N next to every per-step conversion", () => {
    const pkg = decisionPackage(r, undefined, links);
    const section3 = pkg.split("### 3.")[1].split("### 4.")[0];
    const rows = section3.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Step"));
    expect(rows.length).toBe(2 * buyTshirt.steps.length);
    for (const row of rows) expect(row).toMatch(/^\| [^|]+ \| [\d.]+% \(\d+\/\d+\) \| [\d.]+% \(\d+\/\d+\) \|$/);
  });

  it("fences the diff so a ``` line inside it can't close the block", () => {
    const pkg = decisionPackage(r, "diff --git a/README.md b/README.md\n+```\n+code", links);
    expect(pkg).toContain("````diff\ndiff --git a/README.md b/README.md\n+```\n+code\n````");
  });

  it("truncates a long diff and lists its files", () => {
    const diff = ["diff --git a/a.ts b/a.ts", ...Array.from({ length: 199 }, (_, i) => `+a${i}`), "diff --git a/b.ts b/b.ts", ...Array.from({ length: 199 }, (_, i) => `+b${i}`)].join("\n");
    const pkg = decisionPackage(r, diff, links);
    const body = pkg.split("````diff\n")[1].split("\n````")[0];
    expect(body.split("\n").length).toBeLessThanOrEqual(300);
    expect(pkg).toContain("… 100 more lines; files: a.ts, b.ts");
  });

  it("says when the fix is a rehearsal", () => {
    const rehearsal = run("awaiting-decision", { fix: { baselineRunId: "run-1", repo: "r", attempts: [attempt({ prNumber: 0, prUrl: "about:blank#rehearsal" })] } });
    expect(decisionPackage(rehearsal, undefined, links)).toContain("(rehearsal — no PR merged)");
  });
});

describe("analysisReport", () => {
  it("shows the funnel per segment and the top findings with replay links", () => {
    const report = analysisReport(run("done"), links);
    expect(report).toMatch(/\| Product \| .*% \| .*% \| \d+ \|/);
    expect(report).toContain("F1");
    expect(report).toContain("New product page");
    expect(report).toContain("https://eu.posthog.com/project/1/replay/s3");
    expect(report).not.toContain("replay/s4");
    expect(report).toContain("http://localhost:3000/runs/run-1");
  });

  it("is honest when no real users went through the flow", () => {
    const r = run("done", { metrics: { runId: "run-1", flowId: "x", buildSha: "s", segments: [segment("mobile", 0), segment("desktop", 0)], personas: [] }, findings: [] });
    const report = analysisReport(r, links);
    expect(report).toContain("No real-user sessions for this flow in the window");
    expect(report).not.toContain("| Step |");
  });
});
