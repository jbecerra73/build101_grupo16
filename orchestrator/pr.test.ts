import { describe, expect, it } from "vitest";
import type { Finding, Metrics, PersonaMetrics } from "../shared";
import { finalizePr, renderNotProvenComment, renderReadyBody, type PrContext } from "./pr";
import { compareRuns } from "./verdict";

const persona = (personaId: string, completed: number): PersonaMetrics => ({
  personaId, n: 10, completed, completionRate: completed / 10, gaveUp: 10 - completed,
  invalidCompletions: 0, medianSteps: completed ? 18 : 0, medianTimeMs: completed ? 60_000 : 0, funnel: [],
});
const metrics = (...personas: PersonaMetrics[]): Metrics => ({ runId: "r", flowId: "buy-tshirt", buildSha: "x", personas });
const before = metrics(persona("rosa", 2), persona("kai", 1), persona("typical", 9));

const finding: Finding = {
  id: "F1", severity: "high", personas: ["rosa"], step: "Shipping", page: "/checkout",
  title: "'Continue to payment' is invisible", suggestedFix: "Use a button",
  evidence: { screenshots: ["screenshots/rosa-1-004.png"], quotes: ["I can't find how to continue"], agentCount: 6 },
};

const ctx = (after: Metrics): PrContext => ({
  repo: "FrissA/demo-ecommerce", prNumber: 42,
  baselineRunId: "base-1", retestRunId: "retest-1", baselineSha: "aaaaaaaaaa", retestSha: "bbbbbbbbbb",
  verdict: compareRuns(before, after, ["rosa", "kai"]),
  findings: [finding],
  screenshotUrls: { "screenshots/rosa-1-004.png": "https://raw.example/rosa.png" },
});

const recordGh = () => {
  const calls: string[][] = [];
  return { calls, gh: async (args: string[]) => (calls.push(args), "") };
};

describe("PR verdict", () => {
  const improved = ctx(metrics(persona("rosa", 8), persona("kai", 6), persona("typical", 9)));
  const regressed = ctx(metrics(persona("rosa", 8), persona("kai", 6), persona("typical", 7)));

  it("ready body has the before/after table per persona, fixed findings and before screenshots", () => {
    const body = renderReadyBody(improved, "Made the link a button.");
    expect(body).toContain("| Rosa, 67, low vision (targeted) | 20% (2/10) | 80% (8/10) | +60 pts |");
    expect(body).toContain("| Typical shopper (control) | 90% (9/10) | 90% (9/10) | 0 pts |");
    expect(body).toContain("'Continue to payment' is invisible");
    expect(body).toContain('<img src="https://raw.example/rosa.png"');
    expect(body).toContain("`aaaaaaa`");
    expect(body).toContain("Made the link a button.");
  });

  it("not-proven comment names the regression", () => {
    const comment = renderNotProvenComment(regressed);
    expect(comment).toContain("fix attempted, not proven");
    expect(comment).toContain("typical: completion 90% → 70%");
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
