// Ground truth (#5, #11, #15): on the fake six-month history (npm run posthog:generate), the
// analyzer must reproduce the generator's per-release segment completion and surface the six
// planted traps, each attributed to the release that shipped it. Skips when the history is missing.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSource } from "@frictionswarm/posthog";
import type { Finding, RunConfig } from "@frictionswarm/shared";
import { analyzeRun } from "../src";

const DATA = process.env.POSTHOG_DATA_DIR ?? join(import.meta.dirname, "..", "..", "..", "data", "posthog");
const HISTORY = join(DATA, "events.jsonl");
const have = existsSync(HISTORY) && existsSync(join(DATA, "events.manifest.json"));

type Manifest = {
  from: string;
  to: string;
  releases: { sha: string; name: string }[];
  byRelease: { sha: string; name: string; segments: Record<string, { sessions: number; completed: number; completionRate: number }> }[];
};

/** How a finding about each trap looks, whichever path (heuristic or Sonnet) wrote it. */
export const TRAPS: { id: string; release: string; match: (f: Finding) => boolean }[] = [
  { id: "T1", release: "Checkout redesign", match: (f) => f.step === "Shipping" && f.segments.includes("low_vision") && !/promo|coupon|discount/i.test(f.title) },
  { id: "T2", release: "Accounts", match: (f) => f.step === "Account" },
  { id: "T3", release: "Simulated checkout", match: (f) => f.step === "Payment" },
  { id: "T4", release: "New product page", match: (f) => f.step === "Product" },
  { id: "T5", release: "Promo codes", match: (f) => f.step === "Shipping" && /promo|coupon|discount/i.test(f.title) },
  { id: "T6", release: "Shop filters", match: (f) => f.step === "Browse" },
];

/** Per trap: the finding that covers it and the release it names. */
export function trapCoverage(findings: Finding[]) {
  return TRAPS.map((t) => {
    const f = findings.find(t.match);
    return { trap: t.id, expected: t.release, finding: f?.id, release: f?.evidence.sinceRelease?.name, ok: f?.evidence.sinceRelease?.name === t.release };
  });
}

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function runDir(window: { from: string; to: string }, buildSha: string) {
  const dir = mkdtempSync(join(tmpdir(), "gt-"));
  const config: RunConfig = {
    runId: "ground-truth", kind: "analysis", flowId: "buy-tshirt", window, posthog: { source: "file", buildSha },
    personaIds: [], seeds: {}, targetUrl: "https://swarm-ecommerce.netlify.app", createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

describe.skipIf(!have)("ground truth on the fake PostHog history", () => {
  const manifest: Manifest = have ? JSON.parse(readFileSync(join(DATA, "events.manifest.json"), "utf8")) : ({} as Manifest);
  const current = have ? manifest.releases.at(-1)! : { sha: "", name: "" };
  const to = have ? Date.parse(manifest.to) : 0;
  const last28 = { from: day(to - 27 * DAY), to: manifest.to };

  it("analyzes the last 28 days of the current release: completion per release matches the manifest, findings cover T1–T6", async () => {
    const r = await analyzeRun(runDir(last28, current.sha), { source: fileSource({ dataDir: DATA }), env: {} });
    console.log(`28-day analysis: ${r.sessions} sessions, ${r.events} events in window; read ${r.timings.readMs}ms, total ${r.timings.totalMs}ms`);

    // Per-release segment completion = the generator's own numbers
    const table: string[] = [];
    for (const m of manifest.byRelease) {
      const got = r.history!.byRelease.find((x) => x.sha === m.sha)!;
      expect(got.name).toBe(m.name);
      for (const [seg, want] of Object.entries(m.segments)) {
        const g = got.segments[seg as "mobile"]!;
        expect(g.n, `${m.name} ${seg}`).toBe(want.sessions);
        expect(Math.abs(g.completionRate - want.completionRate), `${m.name} ${seg}`).toBeLessThanOrEqual(0.0005);
        table.push(`${m.name.padEnd(19)} ${seg.padEnd(10)} n=${String(g.n).padStart(4)} ${(g.completionRate * 100).toFixed(1)}% (manifest ${(want.completionRate * 100).toFixed(1)}%)`);
      }
    }
    console.log(table.join("\n"));

    const coverage = trapCoverage(r.findings);
    console.log(coverage.map((c) => `${c.trap} → ${c.finding ?? "-"} since ${c.release ?? "-"} (want ${c.expected})`).join("\n"));
    for (const f of r.findings) console.log(`${f.id} [${f.severity}] ${f.step} ${f.segments.join(",")}: ${f.title}`);
    expect(coverage.filter((c) => c.ok).map((c) => c.trap)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    expect(r.metrics.segments.map((s) => s.n).reduce((a, b) => a + b)).toBe(r.sessions);
    expect(r.metrics.trend!.releases.map((x) => x.name)).toEqual(manifest.releases.map((x) => x.name));
  }, 60_000);

  it("analyzes all six months in reasonable time", async () => {
    const r = await analyzeRun(runDir({ from: manifest.from, to: manifest.to }, ""), { source: fileSource({ dataDir: DATA }), env: {}, write: false });
    console.log(`6-month analysis: ${r.sessions} sessions, ${r.events} events; read ${r.timings.readMs}ms, total ${r.timings.totalMs}ms`);
    expect(r.sessions).toBe(manifest.byRelease.reduce((n, x) => n + Object.values(x.segments).reduce((m, s) => m + s.sessions, 0), 0));
    expect(r.timings.totalMs).toBeLessThan(60_000);
  }, 120_000);
});
