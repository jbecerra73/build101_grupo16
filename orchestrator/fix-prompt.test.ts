import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buyTshirt, type Finding } from "../shared";
import { buildFixPrompt, topFindings } from "./fix-prompt";

const findings: Finding[] = JSON.parse(
  readFileSync(join(__dirname, "..", "runs", "fixture-analysis", "findings.json"), "utf8"),
);

describe("topFindings", () => {
  it("ranks by severity, then sessions affected, and caps at 3", () => {
    const extra: Finding = { ...findings[0], id: "F9", severity: "high", evidence: { ...findings[0].evidence, sessions: 999 } };
    expect(topFindings([...findings, extra]).map((f) => f.id)).toEqual(["F9", "F1", "F2"]);
    expect(topFindings(findings, 2).map((f) => f.id)).toEqual(["F1", "F2"]);
  });
});

describe("buildFixPrompt", () => {
  const prompt = buildFixPrompt(buyTshirt, topFindings(findings, 2));

  it("states every required step and field as a hard constraint", () => {
    const constraints = prompt.slice(prompt.indexOf("## Hard constraints"), prompt.indexOf("## How to work"));
    for (const s of buyTshirt.required.steps) expect(constraints).toContain(s);
    for (const f of buyTshirt.required.fields) expect(constraints).toContain(f);
  });

  it("forbids touching tracking", () => {
    expect(prompt).toContain("src/lib/analytics.ts");
  });

  it("includes the findings' evidence and the release that introduced each", () => {
    for (const f of topFindings(findings, 2)) {
      expect(prompt).toContain(f.title);
      expect(prompt).toContain(`${f.evidence.sessions} sessions (${f.evidence.users} users)`);
      expect(prompt).toContain(`release "${f.evidence.sinceRelease!.name}"`);
    }
    expect(prompt).not.toContain(findings[3].title);
  });

  it("has no retry section on attempt 1", () => {
    expect(prompt).not.toContain("This is attempt");
  });
});

describe("buildFixPrompt on a retry", () => {
  const original = topFindings(findings, 2);
  const swarmFinding: Finding = { ...findings[0], id: "F1", title: "Agents still miss the Continue button", persistsFrom: original[0].id };
  const prompt = buildFixPrompt(buyTshirt, [swarmFinding], {
    attempt: 2,
    original,
    previousTargets: original,
    previousSummary: "Enlarged the Continue button on shipping",
    previousVerdict: {
      improved: false,
      targetedPersonas: ["rosa"],
      reasons: ["Rosa: +5 pts, below the 20 pts bar"],
      comparisons: [{
        personaId: "rosa", segmentId: "low_vision", completionDeltaPts: 5, regressions: [],
        before: { n: 100, completed: 4, completionRate: 0.04, medianTimeMs: 0 },
        after: { n: 10, completed: 1, completionRate: 0.1, medianTimeMs: 0 },
      } as never],
    },
  });

  it("says what was already tried, how the swarm did and what it still hit", () => {
    expect(prompt).toContain("This is attempt 2");
    expect(prompt).toContain("Enlarged the Continue button on shipping");
    expect(prompt).toContain("Rosa: +5 pts, below the 20 pts bar");
    expect(prompt).toContain("10% of 10 agents completed");
    expect(prompt).toContain(`"${original[0].title}" is still a problem (finding 1 below)`);
    expect(prompt).toContain("Agents still miss the Continue button");
    for (const f of original) expect(prompt).toContain(f.title);
  });

  it("keeps the hard constraints", () => {
    for (const s of buyTshirt.required.steps) expect(prompt).toContain(s);
    expect(prompt).toContain("Do not undo the previous attempt wholesale");
  });
});
