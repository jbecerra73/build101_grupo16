import type { Finding } from "@frictionswarm/shared";
import { rankFindings } from "@/components/run/report";
import { breakingReleases, type ReleaseImpact } from "@/components/run/trend-chart";
import type { AgentState, RunDetail } from "@/lib/types";

/** Everything the scenes read, derived once from the analysis run and its re-test. */
export type PitchData = {
  run: RunDetail;
  retest?: RunDetail;
  /** The analysis (or its re-test) is still running: scene 4 polls instead of replaying. */
  live: boolean;
  impacts: ReleaseImpact[];
  findings: Finding[];
  attempt?: NonNullable<RunDetail["fix"]>["attempts"][number];
};

export function pitchData(run: RunDetail, retest: RunDetail | undefined, live: boolean): PitchData {
  const points = run.metrics?.trend?.points ?? [];
  const releases = run.metrics?.trend?.releases ?? run.releases ?? [];
  return {
    run,
    retest,
    live,
    impacts: points.length ? breakingReleases(points, releases) : [],
    findings: rankFindings(run.findings ?? []),
    attempt: run.fix?.attempts.at(-1),
  };
}

/* ------------------------------------------------------------ planted traps */

export type TrapId = "T1" | "T2" | "T3" | "T4" | "T5";

/** Ground truth of the fake PostHog history (tools/posthog-sim/sim.ts RELEASES): the
 * release that first shipped each planted trap, and what it is (SPEC trap table). */
export const TRAP_TRUTH: { id: TrapId; label: string; sha: string; release: string }[] = [
  { id: "T3", label: "Delivery fee hidden until Payment", sha: "3b1f0c9e2a7d4b6f8c1e5a9d0b2c4e6f8a1b3c5d", release: "Simulated checkout" },
  { id: "T4", label: "Size picker fails on tap", sha: "8e4d2a6c0b9f1e3a5c7d9b2f4a6c8e0d1b3f5a7c", release: "New product page" },
  { id: "T1", label: "Invisible “Continue to payment”", sha: "c7a9e1b3d5f7092a4c6e8b0d2f4a6c8e1b3d5f70", release: "Checkout redesign" },
  { id: "T5", label: "Promo code wipes the address", sha: "5d2f8b4a6c0e1d3f5a7b9c2e4d6f8a0b1c3e5d7f", release: "Promo codes" },
  { id: "T2", label: "Forced sign-up wall", sha: "f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1d3b5f7a9", release: "Accounts" },
];

/** Which planted trap a finding describes; same matching as packages/pipeline/src/traps.ts. */
export function trapOf(f: Pick<Finding, "step" | "page" | "selector" | "title">): TrapId | undefined {
  const text = `${f.selector ?? ""} ${f.title}`.toLowerCase();
  if (f.step === "Account" || f.page.includes("/checkout/account")) return "T2";
  if (f.step === "Product" || /size/.test(text)) return "T4";
  if (/promo|coupon|wipe|erase|discount/.test(text)) return "T5";
  if (f.step === "Payment" || /deliver|fee|shipping cost|total/.test(text)) return "T3";
  if (f.step === "Shipping" && /continue to payment|continue button|footer|justify-end|can'?t find|cannot find|unreadable|contrast|light-gray|tiny|rage/.test(text)) return "T1";
  return undefined;
}

export type TrapCheck = (typeof TRAP_TRUTH)[number] & { finding?: Finding; releaseRight: boolean };

/** For each planted trap: the finding that surfaced it, and whether it names the right release. */
export function trapChecks(findings: Finding[]): TrapCheck[] {
  return TRAP_TRUTH.map((t) => {
    const finding = findings.find((f) => trapOf(f) === t.id);
    return { ...t, finding, releaseRight: !!finding && finding.evidence.sinceRelease?.sha === t.sha };
  });
}

/* ------------------------------------------------------------ captures */

const STEP_PREF = ["Product", "Cart", "Shipping", "Payment", "Account", "Browse", "Home", "Confirmation"];

/** A real storefront capture from the re-test: the given persona's, preferring a product page. */
export function pickCapture(agents: AgentState[], personaId: string): AgentState | undefined {
  const mine = agents.filter((a) => a.personaId === personaId && a.latestScreenshot);
  const rank = (a: AgentState) => {
    const i = STEP_PREF.indexOf(a.step ?? "");
    return i < 0 ? STEP_PREF.length : i;
  };
  return mine.toSorted((a, b) => rank(a) - rank(b) || a.seed - b.seed)[0];
}

/** "1–10" for a contiguous run of seeds, else "1, 4, 9". */
export function seedLabel(seeds: number[]): string {
  if (!seeds.length) return "—";
  const s = seeds.toSorted((a, b) => a - b);
  const contiguous = s.every((v, i) => i === 0 || v === s[i - 1] + 1);
  return contiguous && s.length > 2 ? `${s[0]}–${s.at(-1)}` : s.join(", ");
}

/** The rehearsal fix loop (FIX_LOOP=fake) opens no PR and prefixes its summary. */
export const isRehearsal = (a?: { prNumber?: number; prUrl?: string; summary?: string }) =>
  !!a && (a.prNumber === 0 || /rehearsal/i.test(a.summary ?? "") || /rehearsal/.test(a.prUrl ?? ""));

export const cleanSummary = (s?: string) => s?.replace(/^\[rehearsal[^\]]*\]\s*/i, "").trim();
