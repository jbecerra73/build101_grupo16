import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeBody, elementsChain, isCaptureUrl, toPostHogEvent } from "./posthog-recorder";

const SENT = Date.parse("2026-10-18T12:00:00.000Z");
const raw = {
  uuid: "u1",
  event: "product_added",
  timestamp: "2026-10-18T11:59:58.000Z",
  properties: { distinct_id: "swarm:kai-11", token: "phc_x", $session_id: "s1", swarm_run: "r1", swarm_agent: "kai-11", product_id: 2 },
};

describe("isCaptureUrl", () => {
  it("matches posthog-js ingestion endpoints only", () => {
    expect(isCaptureUrl(new URL("https://us.i.posthog.com/e/?ip=0&_=1&ver=1.200.0"))).toBe(true);
    expect(isCaptureUrl(new URL("https://us.i.posthog.com/i/v0/e/?ver=1.200.0"))).toBe(true);
    expect(isCaptureUrl(new URL("https://us.i.posthog.com/batch/"))).toBe(true);
    expect(isCaptureUrl(new URL("https://proxy.shop.test/ingest/e/?ver=1.200.0"))).toBe(true);
    expect(isCaptureUrl(new URL("https://us.i.posthog.com/flags/?v=2"))).toBe(false);
    expect(isCaptureUrl(new URL("https://us.i.posthog.com/s/?ver=1.200.0"))).toBe(false);
    expect(isCaptureUrl(new URL("https://shop.test/e/"))).toBe(false);
  });
});

describe("decodeBody", () => {
  const url = new URL("https://us.i.posthog.com/e/?ver=1");
  it("reads gzip-js, base64 forms and plain JSON", () => {
    const json = JSON.stringify([raw]);
    expect(decodeBody(gzipSync(json), new URL("https://us.i.posthog.com/e/?compression=gzip-js"))).toEqual([raw]);
    const b64 = `data=${encodeURIComponent(Buffer.from(json).toString("base64"))}`;
    expect(decodeBody(Buffer.from(b64), new URL("https://us.i.posthog.com/e/?compression=base64"))).toEqual([raw]);
    expect(decodeBody(Buffer.from(json), url)).toEqual([raw]);
  });
});

describe("toPostHogEvent", () => {
  it("keeps the event as PostHog exports it, without the project token", () => {
    expect(toPostHogEvent(raw, SENT)).toEqual({
      uuid: "u1",
      event: "product_added",
      distinct_id: "swarm:kai-11",
      timestamp: "2026-10-18T11:59:58.000Z",
      properties: { distinct_id: "swarm:kai-11", $session_id: "s1", swarm_run: "r1", swarm_agent: "kai-11", product_id: 2 },
    });
  });

  it("dates batched events by their offset and serializes $elements", () => {
    const { timestamp: _t, ...batched } = raw;
    const e = toPostHogEvent(
      { ...batched, event: "$autocapture", offset: 1500, properties: { ...raw.properties, $elements: [{ tag_name: "button", classes: ["btn", "primary"], $el_text: "Add to cart", nth_child: 2, nth_of_type: 1 }, { tag_name: "div" }] } },
      SENT,
    )!;
    expect(e.timestamp).toBe("2026-10-18T11:59:58.500Z");
    expect(e.properties.$elements_chain).toBe('button.btn.primary:text="Add to cart"nth-child="2"nth-of-type="1";div');
    expect(e.properties).not.toHaveProperty("$elements");
  });

  it("skips anything that isn't an event", () => {
    expect(toPostHogEvent({ foo: 1 }, SENT)).toBeUndefined();
    expect(toPostHogEvent(null, SENT)).toBeUndefined();
  });
});

describe("elementsChain", () => {
  it("is what the analyzer parses", async () => {
    const { describeElement } = await import("../packages/analyzer/src/elements");
    const chain = elementsChain([{ tag_name: "a", classes: ["link"], attr__href: "/cart", $el_text: "Cart" }]);
    expect(describeElement(chain)).toMatchObject({ tag: "a", label: "Cart", selector: 'a.link[href="/cart"]:has-text("Cart")' });
  });
});
