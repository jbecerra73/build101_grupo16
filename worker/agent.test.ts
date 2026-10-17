import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buyTshirt, typical, type Event, type Flow } from "../shared";
import { runAgent, type Brain } from "./agent";
import type { Observation } from "./observe";
import type { ToolCall } from "./session";

// A tiny store at http://store.test that walks Home → Cart → Shipping → Payment → Confirmation.
const PAGES: Record<string, string> = {
  "/": `<h1>Shop</h1><a href="/cart">Go to cart</a>`,
  "/cart": `<h1>Cart</h1><p>Blue t-shirt, M</p><a href="/checkout">Checkout</a>`,
  "/checkout": `<h1>Shipping</h1>
    <form onsubmit="event.preventDefault(); location.href='/checkout?step=payment'">
      <label for="email">Email</label><input id="email">
      <button type="submit">Continue to payment</button></form>`,
  "/checkout?step=payment": `<h1>Payment</h1>
    <label for="cardNumber">Card number</label><input id="cardNumber">
    <button onclick="location.href='/checkout/success'">Pay $120</button>`,
  "/checkout/success": `<h1>Payment confirmed</h1><p>A confirmation was sent to ana@example.com.</p>
    <dl><dt>Paid with</dt><dd>Visa ending in 4242</dd><dt>Shipping to</dt><dd>Ana Pérez, 123 Main St, Springfield 12345, United States</dd></dl>`,
};
const ORIGIN = "http://store.test";
const flow: Flow = { ...buyTshirt, startUrl: ORIGIN };

/** Plays a fixed list of moves, finding elements by their visible name. */
class ScriptedBrain implements Brain {
  private n = 0;
  constructor(private readonly moves: ((o: Observation) => ToolCall[])[]) {}
  async decide({ observation }: { observation: Observation }) {
    return this.moves[Math.min(this.n++, this.moves.length - 1)](observation);
  }
}
const byName = (o: Observation, name: string) => {
  const el = o.elements.find((e) => e.name === name);
  if (!el) throw new Error(`no "${name}" in ${o.elements.map((e) => e.name).join(", ")}`);
  return el.id;
};
const click = (name: string) => (o: Observation) => [{ name: "click" as const, input: { id: byName(o, name) } }];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => browser?.close());

async function newPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: typical.viewport });
  await page.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    const key = u.searchParams.get("step") ? `${u.pathname}?step=${u.searchParams.get("step")}` : u.pathname;
    const body = PAGES[key];
    return body
      ? route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>${key}</title><body>${body}</body>` })
      : route.fulfill({ status: 404, body: "not found" });
  });
  return page;
}

const readLog = (dir: string, agentId: string): Event[] =>
  readFileSync(join(dir, "events", `${agentId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("runAgent", () => {
  it("completes the flow and writes a run folder in the shared format", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "fs-run-"));
    const brain = new ScriptedBrain([
      (o) => [{ name: "think_aloud", input: { note: "Let's find the cart." } }, ...click("Go to cart")(o)],
      click("Checkout"),
      (o) => [{ name: "type", input: { id: byName(o, "Email"), text: "ana@example.com" } }],
      click("Continue to payment"),
      (o) => [{ name: "type", input: { id: byName(o, "Card number"), text: "4242 4242 4242 4242" } }],
      click("Pay $120"),
    ]);
    const res = await runAgent({ page: await newPage(), brain, persona: typical, flow, runId: "r1", runDir, seed: 1, settleMs: 50, navWaitMs: 50 });

    expect(res.outcome).toBe("success");
    const events = readLog(runDir, "typical-1");
    expect(events).toEqual(res.events);
    expect(events.filter((e) => e.type === "page_view").map((e) => e.step)).toEqual([
      "Home", "Cart", "Shipping", "Payment", "Confirmation",
    ]);
    expect(events[0].url).toContain("swarm=r1");
    expect(events.find((e) => e.type === "think_aloud")?.note).toBe("Let's find the cart.");
    expect(events.find((e) => e.action?.kind === "type")?.action).toMatchObject({ field: "email", selector: "#email" });
    expect(events.at(-1)).toMatchObject({
      type: "success",
      step: "Confirmation",
      confirmation: { email: "ana@example.com", cardLast4: "4242", address: "Ana Pérez, 123 Main St, Springfield 12345, United States" },
    });
    for (const e of events) {
      expect(e).toMatchObject({ runId: "r1", agentId: "typical-1", personaId: "typical", seed: 1 });
      if (e.screenshot) expect(existsSync(join(runDir, e.screenshot))).toBe(true);
    }
    expect(existsSync(join(runDir, "screenshots", "typical-1-latest.png"))).toBe(true);
  }, 30_000);

  it("gives up with a reason when the agent does", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "fs-run-"));
    const brain = new ScriptedBrain([() => [{ name: "give_up", input: { reason: "Too confusing." } }]]);
    const res = await runAgent({ page: await newPage(), brain, persona: typical, flow, runId: "r2", runDir, seed: 2, settleMs: 50, navWaitMs: 50 });
    expect(res.outcome).toBe("give_up");
    expect(res.events.at(-1)).toMatchObject({ type: "give_up", step: "Home", note: "Too confusing." });
  }, 30_000);

  it("enforces the 25-action hard cap even if the persona allows more", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "fs-run-"));
    const generous = { ...typical, actions: { ...typical.actions, maxActions: 100 } };
    const brain = new ScriptedBrain([() => [{ name: "scroll", input: { direction: "down" } }]]);
    const res = await runAgent({ page: await newPage(), brain, persona: generous, flow, runId: "r3", runDir, seed: 3, settleMs: 50, navWaitMs: 50 });
    expect(res.outcome).toBe("give_up");
    expect(res.events.filter((e) => e.type === "action")).toHaveLength(25);
    expect(res.events.at(-1)?.note).toMatch(/Ran out of actions \(25\)/);
  }, 30_000);

  it("lets only one browser action through per turn", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "fs-run-"));
    const brain = new ScriptedBrain([
      (o) => [...click("Go to cart")(o), ...click("Go to cart")(o)],
      () => [{ name: "give_up", input: { reason: "done testing" } }],
    ]);
    const res = await runAgent({ page: await newPage(), brain, persona: typical, flow, runId: "r4", runDir, seed: 4, settleMs: 50, navWaitMs: 50 });
    expect(res.actions).toBe(1);
  }, 30_000);
});
