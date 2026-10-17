import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buyTshirt, kai, MAX_ACTIONS_PER_AGENT, rosa, typical, type Event, type Flow, type Persona } from "../shared";
import { runAgent, type Brain } from "./agent";
import { describe as describeObs, type Observation } from "./observe";
import { AgentSession, type ToolCall } from "./session";

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
  "/checkout/success": `<h1 style="text-transform:uppercase">Payment confirmed</h1><p>A confirmation was sent to ana@example.com.</p>
    <dl><dt>Paid with</dt><dd>Visa ending in 4242</dd><dt>Shipping to</dt><dd>Ana Pérez, 123 Main St, Springfield 12345, United States</dd></dl>`,
  // Persona fixtures: a faint 11px link (T1), a hover-only size picker (T4), a 30px tap target.
  "/fixture": `<style>.card .sizes{display:none}.card:hover .sizes{display:block}</style>
    <h1>Fixture</h1>
    <a href="/cart" style="color:#ccc;font-size:11px">Continue to payment</a>
    <a href="/cart" style="color:#111;font-size:16px">Big dark link</a>
    <div class="card" style="width:300px;height:80px;background:#eee">T-shirt<div class="sizes"><button>Size M</button></div></div>
    <button style="width:30px;height:30px;padding:0">+</button>
    <button style="width:200px;height:48px">Add to cart</button>`,
  // Confirmation that shows a spinner first.
  "/slow-success": `<h1 id="h">Processing…</h1><script>setTimeout(() => { h.textContent = "Payment confirmed" }, 800)</script>`,
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

async function newPage(persona: Persona = typical): Promise<Page> {
  const page = await browser.newPage({ viewport: persona.viewport, isMobile: persona.viewport.mobile, hasTouch: persona.viewport.mobile });
  await page.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    const key = u.searchParams.get("step") ? `${u.pathname}?step=${u.searchParams.get("step")}` : u.searchParams.has("slow") ? "/slow-success" : u.pathname;
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

  it("enforces the hard action cap even if the persona allows more", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "fs-run-"));
    const generous = { ...typical, actions: { ...typical.actions, maxActions: MAX_ACTIONS_PER_AGENT + 10 } };
    const brain = new ScriptedBrain([() => [{ name: "scroll", input: { direction: "down" } }]]);
    const res = await runAgent({ page: await newPage(), brain, persona: generous, flow, runId: "r3", runDir, seed: 3, settleMs: 50, navWaitMs: 50 });
    expect(res.outcome).toBe("give_up");
    expect(res.events.filter((e) => e.type === "action")).toHaveLength(MAX_ACTIONS_PER_AGENT);
    expect(res.events.at(-1)?.note).toBe(`Ran out of actions (${MAX_ACTIONS_PER_AGENT}).`);
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

const names = (o: Observation) => o.elements.map((e) => e.name);

async function openSession(persona: Persona, path: string) {
  const runDir = mkdtempSync(join(tmpdir(), "fs-run-"));
  const session = new AgentSession({ page: await newPage(persona), persona, flow, runId: "rp", runDir, seed: 1, settleMs: 50, navWaitMs: 50, successWaitMs: 2000 });
  await session.start(`${ORIGIN}${path}`);
  return session;
}

describe("persona constraints", () => {
  it("Rosa cannot perceive faint or tiny text, and gets no DOM text", async () => {
    const s = await openSession(rosa, "/fixture");
    const o = s.observation!;
    expect(names(o)).not.toContain("Continue to payment");
    expect(names(o)).toContain("Big dark link");
    const text = describeObs(o, "screenshot");
    expect(text).not.toContain("Big dark link");
    expect(text).not.toContain("Fixture");
    expect(text).toMatch(/Element ids on screen: e1/);
    // Downscaled to 0.6 of the 1280px viewport.
    expect(o.screenshot.readUInt32BE(16)).toBe(Math.round(1280 * 0.6));
    expect(o.cleanScreenshot.readUInt32BE(16)).toBe(1280);
  }, 30_000);

  it("Typical sees everything at full size", async () => {
    const s = await openSession(typical, "/fixture");
    expect(names(s.observation!)).toContain("Continue to payment");
    expect(s.observation!.screenshot.readUInt32BE(16)).toBe(1280);
  }, 30_000);

  it("hides hover-only elements for Kai even after the pointer was over them", async () => {
    const s = await openSession(kai, "/fixture");
    expect(names(s.observation!)).not.toContain("Size M");
    const t = await openSession(typical, "/fixture");
    await (t as unknown as { o: { page: Page } }).o.page.hover(".card");
    await t.call({ name: "look", input: {} });
    expect(names(t.observation!)).toContain("Size M");
  }, 30_000);

  it("Kai misses a 30px tap target and gives up after 2 tries", async () => {
    const s = await openSession(kai, "/fixture");
    const plus = s.observation!.elements.find((e) => e.name === "+")!.id;
    const first = await s.call({ name: "click", input: { id: plus } });
    expect(first.isError).toBe(true);
    expect(s.outcome).toBeUndefined();
    await s.call({ name: "click", input: { id: s.observation!.elements.find((e) => e.name === "+")!.id } });
    expect(s.outcome).toBe("give_up");
    const actions = s.events.filter((e) => e.type === "action");
    expect(actions.every((e) => e.action?.missed)).toBe(true);
    expect(s.events.at(-1)?.note).toMatch(/2 times/);
  }, 30_000);
});

describe("session endings", () => {
  it("waits for a confirmation that renders late", async () => {
    const s = await openSession(typical, "/checkout/success?slow=1");
    expect(s.outcome).toBe("success");
  }, 30_000);

  it("writes exactly one ending when abandoned mid-call", async () => {
    const s = await openSession(typical, "/fixture");
    const pending = s.call({ name: "scroll", input: { direction: "down" } });
    s.abandon("Stopped without finishing.");
    await pending;
    await s.call({ name: "look", input: {} });
    const endings = s.events.filter((e) => ["success", "give_up", "error"].includes(e.type));
    expect(endings).toHaveLength(1);
    expect(s.events.at(-1)?.type).toBe("give_up");
  }, 30_000);
});
