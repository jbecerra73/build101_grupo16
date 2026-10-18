// The live grid's provisional outcome for a swarm agent, from its PostHog events.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buyTshirt, type PostHogEvent } from "@frictionswarm/shared";
import { invalidReason, visitedSteps } from "./derive";

const FX = join(import.meta.dirname, "..", "..", "..", "packages", "analyzer", "test", "fixtures");
const order = readFileSync(join(FX, "valid-order.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as PostHogEvent);

describe("payment without a $pageview", () => {
  // posthog-js sends no $pageview for /checkout → /checkout?step=payment (same path).
  const real = order.filter((e) => !(e.event === "$pageview" && e.properties.$current_url?.endsWith("?step=payment")));

  it("counts the payment step from the events on it", () => {
    expect(visitedSteps(real, buyTshirt)).toEqual(["Home", "Product", "Cart", "Shipping", "Payment", "Confirmation"]);
    expect(invalidReason(real, buyTshirt)).toBeUndefined();
  });

  it("still flags an order that never reached the payment step", () => {
    const skipped = real.map((e) => ({ ...e, properties: { ...e.properties, $current_url: e.properties.$current_url?.replace("?step=payment", "") } }));
    expect(invalidReason(skipped, buyTshirt)).toBe("Skipped required step(s): Payment");
  });
});
