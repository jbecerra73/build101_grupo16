import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionBudget, buyTshirt, kai, typical, type Flow, type Persona } from "../shared";
import { AgentSession, missPoint } from "./session";

// Kai (#8): mobile viewport, 44px tap targets, per-seed action budget, patience.
const ORIGIN = "http://kai.test";
const PAGES: Record<string, string> = {
  // Logs every click the page receives, so a missed tap is visible as a click elsewhere.
  "/tap": `<script>window.clicks = []; document.addEventListener("click", (e) => clicks.push({ x: e.clientX, y: e.clientY, on: e.target.id || e.target.tagName }))</script>
    <h1>Tap</h1><p>Pick a quantity</p>
    <div style="padding:40px"><button id="plus" style="width:30px;height:30px;padding:0" onclick="window.plusTaps = (window.plusTaps || 0) + 1">+</button></div>
    <button id="big" style="width:200px;height:48px">Add to cart</button>`,
  "/a": `<h1>A</h1><a href="/b" style="display:block;padding:16px">Next</a>`,
  "/b": `<h1>B</h1><a href="/c" style="display:block;padding:16px">Next</a>`,
  "/c": `<h1>C</h1><a href="/a" style="display:block;padding:16px">Next</a>`,
  "/modal": `<h1>Shop</h1><button style="padding:16px" onclick="d.showModal()">Sign up for 10% off</button>
    <dialog id="d"><p>Join our newsletter!</p><button style="padding:16px" onclick="d.close()">No thanks</button></dialog>`,
  "/form": `<h1>Shipping</h1><label for="email">Email</label><input id="email" style="height:48px">
    <button style="padding:16px" onclick="email.setAttribute('aria-invalid','true'); err.hidden = false">Continue</button>
    <p id="err" role="alert" hidden>Email is required</p>`,
};
const flow: Flow = { ...buyTshirt, startUrl: ORIGIN };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => browser?.close());

type Captured = { event: string; properties: Record<string, unknown> };
const captured = new WeakMap<Page, Captured[]>();

/** A fixture page with a window.posthog stub that forwards captures to the test. */
async function newPage(persona: Persona): Promise<Page> {
  const page = await browser.newPage({ viewport: persona.viewport, isMobile: persona.viewport.mobile, hasTouch: persona.viewport.mobile });
  const sink: Captured[] = [];
  captured.set(page, sink);
  await page.exposeFunction("__fsCapture", (event: string, properties: Record<string, unknown>) => void sink.push({ event, properties }));
  await page.addInitScript(() => {
    const w = window as unknown as { posthog: unknown; __fsCapture: (...a: unknown[]) => void };
    w.posthog = { capture: (event: string, properties: unknown) => w.__fsCapture(event, properties) };
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const body = PAGES[new URL(route.request().url()).pathname];
    return body
      ? route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>t</title><body>${body}</body>` })
      : route.fulfill({ status: 404, body: "not found" });
  });
  return page;
}

async function open(persona: Persona, path: string, seed = 1) {
  const page = await newPage(persona);
  const runDir = mkdtempSync(join(tmpdir(), "fs-kai-"));
  const s = new AgentSession({ page, persona, flow, runId: "rk", runDir, seed, settleMs: 50, navWaitMs: 300 });
  await s.start(`${ORIGIN}${path}`);
  return { s, page };
}
const id = (s: AgentSession, name: string) => {
  const el = s.observation!.elements.find((e) => e.name === name);
  if (!el) throw new Error(`no "${name}" in ${s.observation!.elements.map((e) => e.name).join(", ")}`);
  return el.id;
};
const tap = (s: AgentSession, name: string) => s.call({ name: "click", input: { id: id(s, name) } });
/** The swarm_give_up events the page's posthog received (after the session hands them over). */
async function giveUps(s: AgentSession, page: Page) {
  await s.close();
  return captured.get(page)!.filter((c) => c.event === "swarm_give_up").map((c) => c.properties.reason);
}
const with_ = (p: Persona, patch: { actions?: Partial<Persona["actions"]>; patience?: Persona["patience"] }): Persona =>
  ({ ...p, actions: { ...p.actions, ...patch.actions }, patience: patch.patience ?? p.patience });

describe("Kai: taps", () => {
  it("tapping a 30px target is a miss that lands as a real click next to it", async () => {
    const { s, page } = await open(kai, "/tap");
    const target = (await page.locator("#plus").boundingBox())!;
    const res = await tap(s, "+");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/missed/);
    expect(await page.evaluate(() => (window as unknown as { plusTaps?: number }).plusTaps)).toBeUndefined();
    const clicks: { x: number; y: number; on: string }[] = await page.evaluate(() => (window as unknown as { clicks: never }).clicks);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].on).not.toBe("plus");
    const inside = clicks[0].x >= target.x && clicks[0].x <= target.x + target.width && clicks[0].y >= target.y && clicks[0].y <= target.y + target.height;
    expect(inside).toBe(false);
    expect(s.events.filter((e) => e.type === "action").at(-1)?.action).toMatchObject({ kind: "click", selector: "#plus", missed: true });
    // Counts toward maxRetriesSameTarget (2 for Kai).
    await tap(s, "+");
    expect(s.outcome).toBe("give_up");
    expect(await giveUps(s, page)).toEqual([expect.stringMatching(/2 times/)]);
  }, 30_000);

  it("a 48px target is hit", async () => {
    const { s, page } = await open(kai, "/tap");
    const res = await tap(s, "Add to cart");
    expect(res.isError).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { clicks: { on: string }[] }).clicks.map((c) => c.on))).toEqual(["big"]);
  }, 30_000);

  it("Typical (no minTapTargetPx) hits the 30px target", async () => {
    const { s, page } = await open(typical, "/tap");
    await tap(s, "+");
    expect(await page.evaluate(() => (window as unknown as { plusTaps?: number }).plusTaps)).toBe(1);
  }, 30_000);

  it("misses land just outside the target, deterministically per seed and attempt", () => {
    const box = { x: 100, y: 100, width: 30, height: 30 };
    for (let seed = 0; seed < 20; seed++)
      for (let attempt = 0; attempt < 3; attempt++) {
        const p = missPoint(box, { width: 375, height: 812 }, seed, attempt);
        expect(p).toEqual(missPoint(box, { width: 375, height: 812 }, seed, attempt));
        expect(p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height).toBe(false);
        expect(Math.max(box.x - p.x, p.x - box.x - box.width, box.y - p.y, p.y - box.y - box.height)).toBeLessThan(16);
      }
    // Near the viewport's top-left corner it still stays on screen.
    const corner = missPoint({ x: 0, y: 0, width: 30, height: 30 }, { width: 375, height: 812 }, 3, 0);
    expect(corner.x).toBeGreaterThanOrEqual(0);
    expect(corner.y).toBeGreaterThanOrEqual(0);
  });
});

describe("Kai: budget", () => {
  it("draws the budget per seed from maxActionsRange", () => {
    const budgets = Array.from({ length: 50 }, (_, seed) => actionBudget(kai, seed));
    expect(budgets.every((b) => b >= 8 && b <= 12)).toBe(true);
    expect(new Set(budgets).size).toBeGreaterThan(1);
    expect(actionBudget(kai, 7)).toBe(actionBudget(kai, 7));
  });

  it("gives up with swarm_give_up when the configured budget runs out", async () => {
    const tight = with_(kai, { actions: { maxActionsRange: [3, 3] } });
    const { s, page } = await open(tight, "/a");
    expect(s.maxActions).toBe(3);
    for (let i = 0; i < 3; i++) await s.call({ name: "scroll", input: { direction: "down" } });
    expect(s.outcome).toBe("give_up");
    expect(await giveUps(s, page)).toEqual(["Ran out of actions (3)."]);
  }, 30_000);
});

describe("Kai: patience", () => {
  it("starts from the persona config", async () => {
    const { s } = await open(kai, "/a");
    expect(s.patience).toBe(kai.patience.start);
  }, 30_000);

  it("drains on page loads at the configured cost and gives up at zero", async () => {
    const p = with_(kai, { patience: { start: 2, costs: { pageLoad: 1, modal: 0, error: 0 } } });
    const { s, page } = await open(p, "/a");
    const first = await tap(s, "Next");
    expect(s.patience).toBe(1);
    expect(first.text).toMatch(/patience 1\/2/);
    await tap(s, "Next");
    expect(s.outcome).toBe("give_up");
    expect(await giveUps(s, page)).toEqual(["Ran out of patience after one page load too many."]);
  }, 30_000);

  it("page loads cost nothing when the config says so", async () => {
    const p = with_(kai, { patience: { start: 1, costs: { pageLoad: 0, modal: 1, error: 1 } } });
    const { s } = await open(p, "/a");
    for (let i = 0; i < 4; i++) await tap(s, "Next");
    expect(s.outcome).toBeUndefined();
    expect(s.patience).toBe(1);
  }, 30_000);

  it("drains on a modal, once per appearance", async () => {
    const p = with_(kai, { patience: { start: 4, costs: { pageLoad: 0, modal: 2, error: 0 } } });
    const { s, page } = await open(p, "/modal");
    await tap(s, "Sign up for 10% off");
    expect(s.patience).toBe(2);
    await s.call({ name: "look", input: {} });
    expect(s.patience).toBe(2);
    await tap(s, "No thanks");
    await tap(s, "Sign up for 10% off");
    expect(s.outcome).toBe("give_up");
    expect(await giveUps(s, page)).toEqual(["Ran out of patience after a pop-up."]);
  }, 30_000);

  it("drains on a visible form error", async () => {
    const p = with_(kai, { patience: { start: 3, costs: { pageLoad: 0, modal: 0, error: 3 } } });
    const { s, page } = await open(p, "/form");
    await tap(s, "Continue");
    expect(s.outcome).toBe("give_up");
    expect(await giveUps(s, page)).toEqual(["Ran out of patience after an error message."]);
  }, 30_000);

  it("drains on a missed tap (an error) before the retry limit", async () => {
    const p = with_(kai, { actions: { maxRetriesSameTarget: 5 }, patience: { start: 4, costs: { pageLoad: 0, modal: 0, error: 2 } } });
    const { s, page } = await open(p, "/tap");
    await tap(s, "+");
    expect(s.patience).toBe(2);
    await tap(s, "+");
    expect(s.outcome).toBe("give_up");
    expect(await giveUps(s, page)).toEqual(["Ran out of patience after missing a tap."]);
  }, 30_000);
});
