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

  it("asks for a non-technical summary aimed at a product owner", () => {
    expect(prompt).toContain("summary for a product owner");
    expect(prompt).toContain("No file names, code");
  });
});
