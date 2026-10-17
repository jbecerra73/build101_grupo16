import { describe, expect, it } from "vitest";
import type { Finding, Metrics, PersonaMetrics, SegmentMetrics } from "../shared";
import { finalizePr, renderNotProvenComment, renderReadyBody, type PrContext } from "./pr";
import { compareRuns } from "./verdict";

const group = (n: number, completed: number) => ({
  n, users: n, completed, completionRate: completed / n, gaveUp: n - completed,
  invalidCompletions: 0, medianSteps: completed ? 18 : 0, medianTimeMs: completed ? 60_000 : 0, funnel: [],
});
const segment = (segmentId: SegmentMetrics["segmentId"], n: number, completed: number): SegmentMetrics => ({ segmentId, ...group(n, completed) });
const persona = (personaId: string, completed: number): PersonaMetrics => ({ personaId, ...group(10, completed) });
const before: Metrics = {
  runId: "base-1", flowId: "buy-tshirt", buildSha: "aaaaaaaaaa", personas: [],
  segments: [segment("low_vision", 50, 2), segment("mobile", 100, 3), segment("desktop", 100, 15)],
};
const after = (...personas: PersonaMetrics[]): Metrics => ({ runId: "retest-1", flowId: "buy-tshirt", buildSha: "bbbbbbbbbb", segments: [], personas });

const finding: Finding = {
  id: "F1", severity: "high", segments: ["low_vision"], personas: ["rosa"], step: "Shipping", page: "/checkout",
  title: "'Continue to payment' is invisible", suggestedFix: "Use a button",
  evidence: {
    sessions: 31, users: 29, exampleSessions: ["s1"], quotes: [], screenshots: ["screenshots/rosa-1001.png"],
    sinceRelease: { sha: "cccccccccc", date: "2026-06-24", name: "Checkout redesign" },
  },
};

const ctx = (a: Metrics): PrContext => ({
  repo: "FrissA/demo-ecommerce", prNumber: 42,
  baselineRunId: "base-1", retestRunId: "retest-1", baselineSha: "aaaaaaaaaa", retestSha: "bbbbbbbbbb",
  verdict: compareRuns(before, a, ["rosa", "kai"]),
  findings: [finding],
  screenshotUrls: { "screenshots/rosa-1001.png": "https://raw.example/rosa.png" },
});

const recordGh = () => {
  const calls: string[][] = [];
  return { calls, gh: async (args: string[]) => (calls.push(args), "") };
};

describe("PR verdict", () => {
  const improved = ctx(after(persona("rosa", 8), persona("kai", 6), persona("typical", 2)));
  const regressed = ctx(after(persona("rosa", 8), persona("kai", 6), persona("typical", 1)));

  it("ready body has the segment ↔ persona table, fixed findings with their release, and screenshots", () => {
    const body = renderReadyBody(improved, "Made the link a button.");
    expect(body).toContain("| Large text or high contrast ↔ Rosa, 67, low vision (targeted) | 4% (2/50) | 80% (8/10) | +76 pts | ✓ |");
    expect(body).toContain("↔ Typical shopper (control) | 15% (15/100) | 20% (2/10) | +5 pts | ✓ |");
    expect(body).toContain("different populations");
    expect(body).toContain('since release "Checkout redesign" (2026-06-24, `ccccccc`)');
    expect(body).toContain('<img src="https://raw.example/rosa.png"');
    expect(body).toContain("`aaaaaaa`");
    expect(body).toContain("Made the link a button.");
  });

  it("not-proven comment names the regression", () => {
    const comment = renderNotProvenComment(regressed);
    expect(comment).toContain("fix attempted, not proven");
    expect(comment).toContain("typical vs desktop: completion 10% < 15%");
  });

  it("improved → edit body, mark ready", async () => {
    const { calls, gh } = recordGh();
    expect(await finalizePr(improved, "", gh)).toBe("ready");
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["pr edit", "pr ready"]);
  });

  it("not improved → comment, label not-proven, close", async () => {
    const { calls, gh } = recordGh();
    expect(await finalizePr(regressed, "", gh)).toBe("not-proven");
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["pr comment", "label create", "pr edit", "pr close"]);
    expect(calls[2]).toContain("not-proven");
  });
});
