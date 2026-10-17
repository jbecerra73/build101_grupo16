import { describe, expect, it } from "vitest";
import type { Metrics, PersonaMetrics, SegmentMetrics } from "../shared";
import { compareRuns } from "./verdict";

// Funnels are left empty, so only completion is compared; step conversions are covered in the analyzer.
const group = (n: number, completed: number) => ({
  n, users: n, completed, completionRate: completed / n, gaveUp: n - completed,
  invalidCompletions: 0, medianSteps: completed ? 18 : 0, medianTimeMs: completed ? 60_000 : 0, funnel: [],
});
const segment = (segmentId: SegmentMetrics["segmentId"], rate: number): SegmentMetrics => ({ segmentId, ...group(1000, rate * 1000) });
const persona = (personaId: string, completed: number): PersonaMetrics => ({ personaId, ...group(10, completed) });

const analysis: Metrics = {
  runId: "analysis", flowId: "buy-tshirt", buildSha: "prod", personas: [],
  segments: [segment("low_vision", 0.04), segment("mobile", 0.03), segment("desktop", 0.14)],
};
const retest = (rosa: number, kai: number, typical: number): Metrics => ({
  runId: "retest", flowId: "buy-tshirt", buildSha: "preview", segments: [],
  personas: [persona("rosa", rosa), persona("kai", kai), persona("typical", typical)],
});

describe("compareRuns (segment's real users vs persona swarm)", () => {
  it("improved: a targeted persona is ≥20 pts above its segment and nobody is below theirs", () => {
    const v = compareRuns(analysis, retest(7, 6, 5), ["rosa", "kai"]);
    expect(v.improved).toBe(true);
    expect(v.comparisons.map((c) => [c.personaId, c.segmentId, c.completionDeltaPts])).toEqual([
      ["rosa", "low_vision", 66], ["kai", "mobile", 57], ["typical", "desktop", 36],
    ]);
  });

  it("not improved: no targeted persona clears the threshold", () => {
    const v = compareRuns(analysis, retest(2, 2, 2), ["rosa", "kai"]);
    expect(v.improved).toBe(false);
    expect(v.reasons.some((r) => /no targeted persona/.test(r))).toBe(true);
  });

  it("not improved: the control falls below its segment even though targets improve", () => {
    const v = compareRuns(analysis, retest(8, 7, 1), ["rosa", "kai"]);
    expect(v.improved).toBe(false);
    expect(v.comparisons.find((c) => c.personaId === "typical")!.regressions).toEqual(["completion 10% < 14%"]);
  });

  it("gains for a persona the fix did not target don't count", () => {
    expect(compareRuns(analysis, retest(0, 8, 5), ["rosa"]).improved).toBe(false);
  });
});
