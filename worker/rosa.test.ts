import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buyTshirt, rosa, typical, type Flow, type Persona, type SwarmAgentResult } from "../shared";
import { describe as describeObs, type Observation } from "./observe";
import { AgentSession } from "./session";

// Rosa (low_vision stand-in): perception filters come from persona config, and repeated
// failure on one target ends the session with a swarm_give_up event.
const ORIGIN = "http://store.test";
const PAGE = `<style>.card .sizes{display:none}.card:hover .sizes{display:block}</style>
  <h1>Rosa fixture</h1>
  <a href="/cart" style="color:#ccc;font-size:11px">Continue to payment</a>
  <a href="/cart" style="color:#aaa;font-size:18px">Faint large link</a>
  <a href="/cart" style="color:#111;font-size:11px">Tiny dark link</a>
  <a href="/cart" style="color:#111;font-size:16px">Big dark link</a>
  <div class="card" style="width:300px;height:80px;background:#eee">T-shirt<div class="sizes"><button>Size M</button></div></div>
  <button style="font-size:18px" onclick="saved.textContent='Saved'">Save</button><p id="saved" style="font-size:18px;height:24px"></p>
  <button style="font-size:18px" onclick="code.textContent='Code applied'">Apply code</button><p id="code" style="color:#ccc;font-size:12px;height:24px"></p>
  <button style="font-size:18px">Apply coupon</button>`;
const flow: Flow = { ...buyTshirt, startUrl: ORIGIN };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => browser?.close());

type Captured = { event: string; properties: Record<string, unknown> };

/** A session on the fixture page; the page's window.posthog stub forwards captures to `sink`. */
async function open(persona: Persona) {
  const page: Page = await browser.newPage({ viewport: persona.viewport });
  const sink: Captured[] = [];
  await page.exposeFunction("__fsCapture", (event: string, properties: Record<string, unknown>) => sink.push({ event, properties }));
  await page.addInitScript(() => {
    const w = window as unknown as { posthog: unknown; __fsCapture: (...a: unknown[]) => void };
    w.posthog = { capture: (event: string, properties: unknown) => w.__fsCapture(event, properties) };
  });
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>fixture</title><body>${PAGE}</body>` }),
  );
  const runDir = mkdtempSync(join(tmpdir(), "fs-rosa-"));
  const session = new AgentSession({ page, persona, flow, runId: "rr", runDir, seed: 1, settleMs: 50, navWaitMs: 50 });
  await session.start(`${ORIGIN}/`); // the fixture is served on every path; / maps to step Home
  return { session, sink, runDir };
}

const names = (o: Observation) => o.elements.map((e) => e.name);
const idOf = (s: AgentSession, name: string) => s.observation!.elements.find((e) => e.name === name)!.id;
const withPerception = (p: Persona, perception: Partial<Persona["perception"]>): Persona => ({ ...p, perception: { ...p.perception, ...perception } });

describe("Rosa perception", () => {
  it("cannot perceive a low-contrast small link that Typical can", async () => {
    const r = (await open(rosa)).session.observation!;
    const t = (await open(typical)).session.observation!;
    expect(names(r)).not.toContain("Continue to payment");
    expect(names(t)).toContain("Continue to payment");
    // Each threshold applies on its own: faint-but-large and dark-but-tiny are both lost.
    expect(names(r)).not.toContain("Faint large link");
    expect(names(r)).not.toContain("Tiny dark link");
    expect(names(r)).toContain("Big dark link");
    expect(names(t)).toEqual(expect.arrayContaining(["Faint large link", "Tiny dark link", "Big dark link"]));
    // Screenshot only: no DOM text reaches the model.
    expect(describeObs(r, rosa.perception.mode)).not.toMatch(/Big dark link|Rosa fixture/);
  }, 30_000);

  it("hides hover-only elements", async () => {
    const { session } = await open(rosa);
    await session.call({ name: "look", input: {} });
    expect(names(session.observation!)).not.toContain("Size M");
  }, 30_000);

  it("is driven by the persona config, not hard-coded thresholds", async () => {
    // Relaxed thresholds: Rosa now perceives what she could not.
    const relaxed = withPerception(rosa, { minContrast: 1, minFontPx: 10, blur: 0, downscale: 0.5 });
    const r = (await open(relaxed)).session.observation!;
    expect(names(r)).toEqual(expect.arrayContaining(["Continue to payment", "Faint large link", "Tiny dark link"]));
    expect(r.screenshot.readUInt32BE(16)).toBe(Math.round(rosa.viewport.width * 0.5));
    // Typical with Rosa's thresholds loses the same elements.
    const strict = withPerception(typical, { minContrast: rosa.perception.minContrast, minFontPx: rosa.perception.minFontPx });
    const t = (await open(strict)).session.observation!;
    expect(names(t)).not.toContain("Continue to payment");
    expect(names(t)).not.toContain("Tiny dark link");
    expect(names(t)).toContain("Big dark link");
  }, 30_000);
});

describe("Rosa gives up", () => {
  it("after 2 clicks on the same target that change nothing she can see, as a swarm_give_up event", async () => {
    const { session: s, sink, runDir } = await open(rosa);
    // A click with a visible effect is not a failure.
    const saved = await s.call({ name: "click", input: { id: idOf(s, "Save") } });
    expect(saved.text).not.toMatch(/Nothing seemed to change/);
    // The effect is faint text Rosa cannot perceive: to her, nothing happened.
    const first = await s.call({ name: "click", input: { id: idOf(s, "Apply code") } });
    expect(first.text).toMatch(/Nothing seemed to change/);
    expect(s.outcome).toBeUndefined();
    await s.call({ name: "click", input: { id: idOf(s, "Apply code") } });
    expect(s.outcome).toBe("give_up");
    await s.close();

    const reason = "Tried the same thing 2 times and it never worked.";
    expect(sink).toEqual([{ event: "swarm_give_up", properties: { reason, step: "Home" } }]);
    const result: SwarmAgentResult = JSON.parse(readFileSync(join(runDir, "agents", "rosa-1.json"), "utf8"));
    expect(result).toMatchObject({ outcome: "give_up", reason, actions: 3 });
  }, 30_000);

  it("counts failures per target, not in total", async () => {
    const { session: s } = await open(rosa);
    await s.call({ name: "click", input: { id: idOf(s, "Apply code") } });
    await s.call({ name: "click", input: { id: idOf(s, "Apply coupon") } });
    expect(s.outcome).toBeUndefined();
    await s.call({ name: "click", input: { id: idOf(s, "Apply coupon") } });
    expect(s.outcome).toBe("give_up");
  }, 30_000);

  it("Typical keeps trying where Rosa would have given up", async () => {
    const { session: s } = await open(typical);
    for (let i = 0; i < typical.actions.maxRetriesSameTarget! - 1; i++)
      await s.call({ name: "click", input: { id: idOf(s, "Apply coupon") } });
    expect(s.outcome).toBeUndefined();
  }, 30_000);
});
