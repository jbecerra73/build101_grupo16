import { describe, expect, it } from "vitest";
import { isSwarm, segmentOf } from "../../shared/analytics";
import { buyTshirt } from "../../shared/flows";
import { resolveStep } from "../../shared/steps";
import {
  mulberry32,
  newVisitor,
  PERSONA_PROFILES,
  RELEASES,
  SEGMENT_PROFILES,
  simulateSession,
  SWARM_INTENTS,
  visitorSegment,
  type TrapId,
} from "./sim";

const START = Date.parse("2026-10-01T12:00:00Z");
const ALL = RELEASES.at(-1)!.traps;

function realUsers(n: number, traps: TrapId[], seed = 1) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const visitor = newVisitor(rng, START + i);
    return simulateSession({
      rng, start: START + i * 60_000, visitor, host: "swarm-ecommerce.netlify.app", buildSha: "prod",
      traps, profile: SEGMENT_PROFILES[visitorSegment(visitor)], promoCodes: true,
    });
  });
}

function agents(persona: "rosa" | "kai" | "typical", traps: TrapId[], n = 200, flowId = "buy-tshirt") {
  return Array.from({ length: n }, (_, seed) => {
    const rng = mulberry32(seed + 1);
    return simulateSession({
      rng, start: START, host: "preview", buildSha: "preview", traps, profile: PERSONA_PROFILES[persona], promoCodes: true,
      visitor: { distinctId: "", device: persona === "kai" ? "Mobile" : "Desktop", os: "Linux", browser: "Chrome", viewport: [1280, 800], fontScale: 1, prefersContrast: false },
      swarm: { run: "r1", agent: `${persona}-${seed}`, persona },
      intent: SWARM_INTENTS[flowId],
    });
  });
}

const rate = (rs: { completed: boolean }[]) => rs.filter((r) => r.completed).length / rs.length;

describe("posthog-sim", () => {
  it("is deterministic for a seed", () => {
    expect(realUsers(50, ALL, 7)).toEqual(realUsers(50, ALL, 7));
  });

  it("emits events the analyzer can place in the funnel", () => {
    const events = realUsers(300, ALL).flatMap((r) => r.events);
    for (const e of events.filter((e) => e.event === "$pageview")) {
      expect(resolveStep(buyTshirt, e.properties.$current_url!)).toBeDefined();
    }
    expect(events.some(isSwarm)).toBe(false);
    expect(new Set(events.map((e) => segmentOf(e.properties)))).toEqual(new Set(["mobile", "desktop", "low_vision"]));
    // Completed sessions pass through every required step
    const completed = realUsers(300, ALL).filter((r) => r.completed);
    for (const r of completed) {
      const steps = new Set(r.events.filter((e) => e.event === "$pageview").map((e) => resolveStep(buyTshirt, e.properties.$current_url!)));
      for (const s of buyTshirt.required.steps) expect(steps).toContain(s);
      expect(r.events.some((e) => e.event === "order_completed")).toBe(true);
    }
  });

  it("leaves a trace for each trap", () => {
    const events = realUsers(2000, ALL).flatMap((r) => r.events);
    const chain = (s: string) => events.some((e) => e.event === "$rageclick" && e.properties.$elements_chain!.includes(s));
    expect(chain('text="Size"')).toBe(true); // T4
    expect(chain("justify-end")).toBe(true); // T1: around the invisible link
    expect(events.some((e) => e.event === "add_to_cart_clicked" && e.properties.has_size === false)).toBe(true);
    expect(events.some((e) => e.event === "shipping_submitted" && e.properties.promo_applied === true && (e.properties.error_fields as string[]).length === 5)).toBe(true); // T5
    expect(events.some((e) => e.properties.$pathname === "/checkout/account")).toBe(true); // T2
  });

  it("swarm agents are tagged and narrate their give-ups", () => {
    const rs = agents("rosa", ALL, 20);
    for (const e of rs.flatMap((r) => r.events)) {
      expect(e.distinct_id).toMatch(/^swarm:rosa-/);
      expect(e.properties).toMatchObject({ swarm_run: "r1", swarm_persona: "rosa" });
    }
    const gaveUp = rs.filter((r) => !r.completed);
    for (const r of gaveUp) expect(r.events.some((e) => e.event === "swarm_give_up")).toBe(true);
  });

  it("swarm agents follow their flow: the jeans, a promo code, or stopping at the cart", () => {
    const viewed = (evs: { event: string; properties: Record<string, unknown> }[]) => evs.find((e) => e.event === "product_viewed")?.properties.product_id;
    expect(agents("typical", [], 10, "buy-jeans").every((r) => viewed(r.events) === 2)).toBe(true);
    const promo = agents("kai", [], 10, "promo-checkout");
    expect(promo.every((r) => r.events.some((e) => e.event === "promo_applied" && e.properties.success === true))).toBe(true);
    const cart = agents("typical", ALL, 20, "add-to-cart").filter((r) => r.completed);
    expect(cart.length).toBeGreaterThan(0);
    for (const r of cart) {
      expect(r.exitStep).toBe("Cart");
      expect(r.events.some((e) => e.event === "swarm_done")).toBe(true);
      expect(r.events.some((e) => e.event === "checkout_clicked")).toBe(false);
    }
  });

  it("fixing T1+T2 lifts Rosa and Kai by well over 20 points, Typical holds", () => {
    const fixed = ALL.filter((t) => t !== "T1" && t !== "T2");
    expect(rate(agents("rosa", fixed)) - rate(agents("rosa", ALL))).toBeGreaterThan(0.25);
    expect(rate(agents("kai", fixed)) - rate(agents("kai", ALL))).toBeGreaterThan(0.25);
    expect(rate(agents("typical", fixed))).toBeGreaterThanOrEqual(rate(agents("typical", ALL)) - 0.05);
  });
});
