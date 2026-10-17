import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buyTshirt, type Finding } from "../shared";
import { buildFixPrompt, topFindings } from "./fix-prompt";

const findings: Finding[] = JSON.parse(
  readFileSync(join(__dirname, "..", "runs", "fixture-baseline", "findings.json"), "utf8"),
);

describe("topFindings", () => {
  it("ranks by severity, then agent count, and caps at 3", () => {
    const extra: Finding = { ...findings[0], id: "F9", severity: "high", evidence: { ...findings[0].evidence, agentCount: 9 } };
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

  it("includes the findings' evidence", () => {
    expect(prompt).toContain("'Continue to payment' is invisible to low-vision shoppers");
    expect(prompt).toContain("9 fields just to buy a shirt?? no way");
    expect(prompt).not.toContain("Size buttons are too small");
  });
});
