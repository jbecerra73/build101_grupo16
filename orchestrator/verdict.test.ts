import { describe, expect, it } from "vitest";
import type { Metrics, PersonaMetrics } from "../shared";
import { compareRuns } from "./verdict";

const persona = (personaId: string, completed: number, extra: Partial<PersonaMetrics> = {}): PersonaMetrics => ({
  personaId,
  n: 10,
  completed,
  completionRate: completed / 10,
  gaveUp: 10 - completed,
  invalidCompletions: 0,
  medianSteps: completed ? 18 : 0,
  medianTimeMs: completed ? 60_000 : 0,
  funnel: [],
  ...extra,
});

const metrics = (runId: string, ...personas: PersonaMetrics[]): Metrics => ({
  runId,
  flowId: "buy-tshirt",
  buildSha: runId,
  personas,
});

const baseline = metrics("before", persona("rosa", 2), persona("kai", 1), persona("typical", 9));

describe("compareRuns", () => {
  it("improved: a targeted persona gains ≥20 pts and nothing regresses", () => {
    const after = metrics("after", persona("rosa", 7), persona("kai", 6), persona("typical", 9));
    const v = compareRuns(baseline, after, ["rosa", "kai"]);
    expect(v.improved).toBe(true);
    expect(v.reasons).toEqual(["rosa: completion +50 pts (N=10→10)", "kai: completion +50 pts (N=10→10)"]);
  });

  it("not improved: no change", () => {
    const v = compareRuns(baseline, metrics("after", ...baseline.personas), ["rosa", "kai"]);
    expect(v.improved).toBe(false);
    expect(v.reasons[0]).toMatch(/no targeted persona/);
  });

  it("not improved: gain below threshold", () => {
    const after = metrics("after", persona("rosa", 3), persona("kai", 2), persona("typical", 9));
    expect(compareRuns(baseline, after, ["rosa", "kai"]).improved).toBe(false);
  });

  it("not improved: control regresses even though targets improve", () => {
    const after = metrics("after", persona("rosa", 8), persona("kai", 7), persona("typical", 8));
    const v = compareRuns(baseline, after, ["rosa", "kai"]);
    expect(v.improved).toBe(false);
    expect(v.reasons).toContain("typical: completion 90% → 80%");
    expect(v.comparisons.find((c) => c.personaId === "typical")!.regressions).toHaveLength(2); // completion + give-up
  });

  it("gains for a persona the fix did not target don't count", () => {
    const after = metrics("after", persona("rosa", 2), persona("kai", 8), persona("typical", 9));
    expect(compareRuns(baseline, after, ["rosa"]).improved).toBe(false);
  });

  it("more invalid completions is a regression", () => {
    const after = metrics("after", persona("rosa", 7), persona("kai", 1, { invalidCompletions: 2 }), persona("typical", 9));
    const v = compareRuns(baseline, after, ["rosa"]);
    expect(v.improved).toBe(false);
    expect(v.reasons).toContain("kai: invalid completions 0% → 20%");
  });

  it("effort medians only regress past the noise tolerance", () => {
    const slightlySlower = persona("typical", 9, { medianSteps: 19, medianTimeMs: 70_000 });
    const after = metrics("after", persona("rosa", 7), persona("kai", 1), slightlySlower);
    expect(compareRuns(baseline, after, ["rosa"]).improved).toBe(true);

    const muchSlower = persona("typical", 9, { medianSteps: 24 });
    const after2 = metrics("after", persona("rosa", 7), persona("kai", 1), muchSlower);
    expect(compareRuns(baseline, after2, ["rosa"]).reasons).toContain("typical: median steps 18 → 24");
  });

  it("a persona missing from the re-test blocks the verdict", () => {
    const after = metrics("after", persona("rosa", 9), persona("kai", 1));
    const v = compareRuns(baseline, after, ["rosa"]);
    expect(v.improved).toBe(false);
    expect(v.reasons).toContain("typical: missing from the re-test");
  });
});
