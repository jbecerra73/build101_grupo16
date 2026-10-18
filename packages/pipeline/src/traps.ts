// Which planted trap a finding describes. The offline swarm runner removes the
// traps a fix targeted, so the simulated preview behaves like the fixed store.
// Matching is by funnel step and selector/title, the same evidence a coding
// agent works from. See the trap table in SPEC.md.
import type { Finding } from "@frictionswarm/shared";
import type { TrapId } from "../../../tools/posthog-sim/sim";

export type { TrapId };

export const TRAP_IDS: TrapId[] = ["T1", "T2", "T3", "T4", "T5", "T6"];

/** Trap a finding points at, or undefined when it matches none. */
export function trapOf(f: Pick<Finding, "step" | "page" | "selector" | "title">): TrapId | undefined {
  const text = `${f.selector ?? ""} ${f.title}`.toLowerCase();
  if (f.step === "Account" || f.page.includes("/checkout/account")) return "T2";
  // T6: a picked filter does nothing until "Apply Filter", below the fold
  if (f.step === "Browse" || /filter|swatch/.test(text)) return "T6";
  if (f.step === "Product" || /size/.test(text)) return "T4";
  if (/promo|coupon|wipe|erase|discount/.test(text)) return "T5";
  if (f.step === "Payment" || /deliver|fee|shipping cost|total/.test(text)) return "T3";
  // T1 is about finding the way on: the invisible "Continue to payment" link
  // and rage clicks on the card footer, not ordinary validation errors.
  if (f.step === "Shipping" && /continue to payment|continue button|footer|justify-end|can'?t find|cannot find|unreadable|contrast|light-gray|tiny|rage/.test(text)) return "T1";
  return undefined;
}

/** Distinct traps behind a set of findings. */
export const trapsOf = (findings: Pick<Finding, "step" | "page" | "selector" | "title">[]): TrapId[] =>
  TRAP_IDS.filter((t) => findings.some((f) => trapOf(f) === t));
