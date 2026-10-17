import type { Page } from "playwright";
import { actionBudget, matchesRoute, type Flow, type Persona, type SwarmAgentResult } from "../shared";
import { AgentTrace, type TraceEntry } from "./trace";
import { ID_ATTR, observe, type Observation } from "./observe";

export type ToolName = "look" | "click" | "type" | "scroll" | "back" | "think_aloud" | "give_up" | "done";
export type ToolCall = { name: ToolName; input: Record<string, unknown> };
export type Outcome = "success" | "give_up" | "error";

/** What a tool call returns to the model. `observation` is set after anything that may change the screen. */
export type StepResult = { text: string; isError?: boolean; observation?: Observation; ended?: Outcome };

export const BROWSER_ACTIONS = new Set<ToolName>(["click", "type", "scroll", "back"]);

/** Test details each seed fills in; the storefront accepts the 4242 test card. */
const IDENTITIES = [
  { email: "ana@example.com", fullName: "Ana Pérez", address: "123 Main St", city: "Springfield", postalCode: "12345", country: "United States" },
  { email: "li.wei@example.com", fullName: "Li Wei", address: "48 King Street", city: "Toronto", postalCode: "M5H 1A1", country: "Canada" },
  { email: "sam.jones@example.com", fullName: "Sam Jones", address: "9 Baker Road", city: "London", postalCode: "NW1 6XE", country: "United Kingdom" },
];
const CARD = { number: "4242 4242 4242 4242", expiry: "12/30", cvc: "123" };


export function systemPrompt(persona: Persona, flow: Flow, seed: number) {
  const me = IDENTITIES[seed % IDENTITIES.length];
  return `${persona.prompt}

Your goal: ${flow.goal}

You are using a real web shop through tools. Start by calling look. Every action returns a screenshot of the screen (interactive elements are outlined in red with an id label like e7)${persona.perception.mode === "screenshot" ? "" : " and a list of those elements"}. Act only through click, type, scroll and back, one at a time, and look at the result before the next one. You cannot type URLs.

- Behave like the person described above, not like a test robot. Use think_aloud to voice reactions as you go (confusion, annoyance, relief), in first person, briefly.
- If you would realistically abandon the purchase, call give_up and say why.
- You have at most ${actionBudget(persona, seed)} actions (click/type/scroll/back). look and think_aloud are free.
- When the order is placed and confirmed, call done.
- Once the session is over, stop and reply with one short sentence.

If you are asked for details, use these:
Email: ${me.email}
Full name: ${me.fullName}
Address: ${me.address}, ${me.city} ${me.postalCode}, ${me.country}
Card: ${CARD.number}, expiry ${CARD.expiry}, CVC ${CARD.cvc}, name on card ${me.fullName}
If asked to create an account, any password like "Shopper!2026" is fine.`;
}

export type SessionOptions = {
  page: Page;
  persona: Persona;
  flow: Flow;
  runId: string;
  runDir: string;
  seed: number;
  /** Pause after each action so client-side navigation and rendering finish. */
  settleMs?: number;
  /** How long to wait for a click/back to change the URL before observing. */
  navWaitMs?: number;
  /** How long to wait for the confirmation text once on the success URL. */
  successWaitMs?: number;
};

/** One persona agent in one browser page: runs tool calls, enforces limits, reports to PostHog (see AgentTrace).
 * Whoever drives it (Claude Code over MCP, or a scripted brain in tests) only sees StepResults. */
export class AgentSession {
  readonly agentId: string;
  readonly maxActions: number;
  /** Bounds calls that never act (looking, thinking aloud, unknown ids). */
  readonly maxCalls: number;
  actions = 0;
  calls = 0;
  outcome?: Outcome;
  private readonly log: AgentTrace;
  private obs?: Observation;
  private lastUrl = "";
  private queue: Promise<unknown> = Promise.resolve();
  /** Failed attempts per target selector, for persona.actions.maxRetriesSameTarget. */
  private misses = new Map<string, number>();
  /** persona.patience: drains on page loads, modals and errors; give_up at zero. */
  patience: number;
  /** What last cost patience, for the give_up reason. */
  private drainedBy = "";
  private modalOpen = false;
  private formErrors = 0;

  constructor(private readonly o: SessionOptions) {
    this.agentId = `${o.persona.id}-${o.seed}`;
    this.maxActions = actionBudget(o.persona, o.seed);
    this.maxCalls = this.maxActions * 4;
    this.patience = o.persona.patience.start;
    const base = { runId: o.runId, agentId: this.agentId, personaId: o.persona.id, seed: o.seed };
    this.log = new AgentTrace(o.page, o.runDir, base, o.flow, () => this.actions);
  }

  /** In-memory trace of what the agent did (not persisted; PostHog has the real tracks). */
  get events(): TraceEntry[] {
    return this.log.events;
  }

  /** Whether the store exposed window.posthog when the last swarm event was sent. */
  get posthog(): boolean | undefined {
    return this.log.posthog;
  }

  /** Hands pending swarm events to the page, then leaves it so posthog-js flushes its queue
   * (it sends on page hide). Call before closing the browser. */
  async close() {
    await this.serial(async () => {
      await this.log.flush();
      await this.o.page.goto("about:blank", { timeout: 5000 }).catch(() => {});
    });
  }

  get observation(): Observation | undefined {
    return this.obs;
  }

  async start(url: string): Promise<StepResult> {
    return this.serial(async () => {
      try {
        await this.o.page.goto(url, { waitUntil: "domcontentloaded" });
        await this.settle();
        if (await this.look()) return { text: "Order confirmed. The session is over.", ended: "success", observation: this.obs };
        return this.exhausted() ?? this.result("You opened the shop.");
      } catch (err) {
        return this.fail(err);
      }
    });
  }

  /** Runs one tool call. Calls are serialized: the page is a single shared resource. */
  call(c: ToolCall): Promise<StepResult> {
    return this.serial(() => this.run(c));
  }

  /** Ends the session if the driver stopped without finishing. Runs at once, not behind the
   * queue; a call still in flight then finds the session over and its events are dropped. */
  abandon(note: string) {
    if (this.outcome) return;
    this.log.emit({ type: "give_up", url: this.o.page.url(), note });
    this.outcome = "give_up";
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(c: ToolCall): Promise<StepResult> {
    if (this.outcome) return { text: "The session is over. Stop now.", ended: this.outcome };
    if (++this.calls > this.maxCalls) return this.end("give_up", `Stalled: ${this.maxCalls} tool calls without finishing.`);
    try {
      if (BROWSER_ACTIONS.has(c.name)) return await this.act(c);
      return await this.free(c);
    } catch (err) {
      return this.fail(err);
    }
  }

  private async free(c: ToolCall): Promise<StepResult> {
    const url = this.o.page.url();
    switch (c.name) {
      case "look": {
        const before = this.patience;
        if (await this.look()) return { text: "Order confirmed. The session is over.", ended: "success", observation: this.obs };
        return this.exhausted() ?? this.result(`This is the screen now.${this.patienceNote(before)}`);
      }
      case "think_aloud":
        this.log.emit({ type: "think_aloud", url, note: String(c.input.note ?? "") });
        return { text: "Noted." };
      case "give_up":
        return this.end("give_up", String(c.input.reason ?? ""));
      case "done":
        if (await this.checkSuccess()) return { text: "Order confirmed. The session is over.", ended: "success" };
        return { text: "The order is not confirmed yet. Keep going or give up.", isError: true };
      default:
        return { text: `Unknown tool ${c.name}.`, isError: true };
    }
  }

  private async act(c: ToolCall): Promise<StepResult> {
    if (this.actions >= this.maxActions) return this.end("give_up", `Ran out of actions (${this.maxActions}).`);
    const { page, persona } = this.o;
    const url = page.url();
    const before = this.patience;
    let text: string;
    let isError = false;

    if (c.name === "scroll") {
      const dir = c.input.direction === "up" ? -1 : 1;
      await page.mouse.wheel(0, dir * Math.round(persona.viewport.height * 0.8));
      this.log.emit({ type: "action", url, action: { kind: "scroll", text: dir > 0 ? "down" : "up" } });
      text = `Scrolled ${dir > 0 ? "down" : "up"}.`;
    } else if (c.name === "back") {
      await page.goBack({ timeout: 10000 }).catch(() => {});
      this.log.emit({ type: "action", url, action: { kind: "back" } });
      text = "Went back.";
    } else {
      const id = String(c.input.id ?? "");
      const el = this.obs?.elements.find((e) => e.id === id);
      if (!el) return this.result(`No element ${id} on screen.`, true);
      const locator = page.locator(`[${ID_ATTR}="${id}"]`);
      const typed = c.name === "type" ? String(c.input.text ?? "") : undefined;
      // A screenshot-only persona never sees DOM text, so don't echo element names back.
      const named = persona.perception.mode === "screenshot" ? id : `${id} "${el.name}"`;
      const minTap = persona.actions.minTapTargetPx;
      const tooSmall = typed === undefined && minTap && (el.rect.width < minTap || el.rect.height < minTap);
      try {
        if (tooSmall) {
          // The fat-finger tap still happens, next to the target, so the store's PostHog
          // records a real click on whatever is there.
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          const box = (await locator.boundingBox({ timeout: 5000 }).catch(() => null)) ?? el.rect;
          const at = missPoint(box, persona.viewport, this.o.seed, this.misses.get(el.selector) ?? 0);
          await page.mouse.click(at.x, at.y);
          isError = true;
          text = `Your tap missed ${named}: it is too small for your thumb and you hit next to it.`;
        } else {
          if (typed === undefined) await locator.click({ timeout: 5000 });
          else {
            await locator.fill(typed, { timeout: 5000 });
            if (c.input.submit) await locator.press("Enter");
          }
          text = typed === undefined ? `Clicked ${named}.` : `Typed into ${named}.`;
        }
      } catch {
        isError = true;
        text = typed === undefined ? `Clicking ${id} did nothing.` : `Could not type into ${id}.`;
      }
      this.log.emit({
        type: "action",
        url,
        action:
          typed === undefined
            ? { kind: "click", selector: el.selector, text: el.name, ...(isError ? { missed: true } : {}) }
            : { kind: "type", selector: el.selector, text: typed, field: el.field, ...(isError ? { missed: true } : {}) },
      });
      if (isError) {
        this.drain("error", tooSmall ? "missing a tap" : "an action that did nothing");
        const tries = (this.misses.get(el.selector) ?? 0) + 1;
        this.misses.set(el.selector, tries);
        const max = persona.actions.maxRetriesSameTarget;
        if (max && tries >= max) {
          this.actions++;
          return this.end("give_up", `Tried ${persona.perception.mode === "screenshot" ? "the same thing" : `"${el.name}"`} ${tries} times and it never worked.`);
        }
      }
    }

    this.actions++;
    // Client-side navigation can land after the click resolves; give it a moment to start.
    if (c.name !== "scroll") await page.waitForURL((u) => u.toString() !== url, { timeout: this.o.navWaitMs ?? 1500 }).catch(() => {});
    await this.settle();
    if (await this.look()) return { text: `${text} Order confirmed. The session is over.`, ended: "success", observation: this.obs };
    const out = this.exhausted();
    if (out) return out;
    if (this.actions >= this.maxActions) return this.end("give_up", `Ran out of actions (${this.maxActions}).`);
    return this.result(`${text} (${this.maxActions - this.actions} actions left)${this.patienceNote(before)}`, isError);
  }

  private async settle() {
    await this.o.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.o.page.waitForTimeout(this.o.settleMs ?? 600);
  }

  /** Observe the page; log a page_view when the URL changed and charge patience for what
   * appeared (page load, modal, form error). Returns true on success. */
  private async look(): Promise<boolean> {
    const { page, persona } = this.o;
    // Park the pointer off the page so menus that only open on hover stay closed.
    if (persona.perception.hideHoverOnly) await page.mouse.move(-1, -1).catch(() => {});
    this.obs = await this.observeStable();
    this.log.saveLatest(this.obs.cleanScreenshot);
    if (this.obs.url !== this.lastUrl) {
      // The landing page is free; every later one costs.
      if (this.lastUrl) this.drain("pageLoad", "one page load too many");
      this.lastUrl = this.obs.url;
      this.formErrors = 0;
      this.log.emit({ type: "page_view", url: this.obs.url });
    }
    const f = await page.evaluate(friction).catch(() => ({ modal: false, errors: 0 }));
    if (f.modal && !this.modalOpen) this.drain("modal", "a pop-up");
    if (f.errors > this.formErrors) this.drain("error", "an error message");
    this.modalOpen = f.modal;
    this.formErrors = f.errors;
    return this.checkSuccess();
  }

  private drain(cost: keyof Persona["patience"]["costs"], why: string) {
    const c = this.o.persona.patience.costs[cost];
    if (!c) return;
    this.patience -= c;
    this.drainedBy = why;
  }

  /** The give_up once patience hits zero (checked after success, so finishing always wins). */
  private exhausted(): StepResult | undefined {
    if (this.patience > 0 || this.outcome) return undefined;
    return this.end("give_up", `Ran out of patience after ${this.drainedBy}.`);
  }

  private patienceNote(before: number) {
    return this.patience < before ? ` That was annoying (patience ${this.patience}/${this.o.persona.patience.start}).` : "";
  }

  /** A navigation that lands mid-observe destroys the page context; settle and observe again. */
  private async observeStable(): Promise<Observation> {
    const { page, persona } = this.o;
    for (let attempt = 1; ; attempt++) {
      try {
        const obs = await observe(page, persona.perception);
        if (obs.url === page.url() || attempt >= 3) return obs;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= 3 || !/context was destroyed|navigat/i.test(msg)) throw err;
      }
      await this.settle();
    }
  }

  /** On the success URL, waits up to successWaitMs for the confirmation text (it may render late). */
  private async checkSuccess(): Promise<boolean> {
    if (this.outcome) return this.outcome === "success";
    const { page, flow } = this.o;
    const { urlPattern, visibleText } = flow.success;
    if (urlPattern && !matchesRoute(urlPattern, page.url())) return false;
    const deadline = Date.now() + (urlPattern ? (this.o.successWaitMs ?? 3000) : 0);
    for (;;) {
      const body = await page.locator("body").innerText().catch(() => "");
      // innerText applies CSS text-transform, so compare case-insensitively.
      if (!visibleText || body.toLowerCase().includes(visibleText.toLowerCase())) {
        this.log.emit({ type: "success", url: page.url(), confirmation: readConfirmation(body) });
        this.outcome = "success";
        return true;
      }
      if (Date.now() >= deadline) return false;
      await page.waitForTimeout(250);
    }
  }

  private result(text: string, isError = false): StepResult {
    return { text, isError, observation: this.obs };
  }

  private end(outcome: "give_up", note: string): StepResult {
    if (this.outcome) return { text: "The session is over. Stop now.", ended: this.outcome };
    this.log.emit({ type: "give_up", url: this.o.page.url(), note });
    this.outcome = outcome;
    return { text: `You left the shop (${note}). The session is over.`, ended: outcome };
  }

  private fail(err: unknown): StepResult {
    // The session was ended underneath this call (abandon() closed the browser).
    if (this.outcome) return { text: "The session is over. Stop now.", ended: this.outcome };
    const note = err instanceof Error ? err.message : String(err);
    this.log.emit({ type: "error", url: this.o.page.url(), note });
    this.outcome = "error";
    return { text: `Something broke: ${note}. The session is over.`, isError: true, ended: "error" };
  }
}

/** Runs in the page: whether a modal is showing and how many form errors are visible. No named
 * inner functions (tsx would wrap them in __name). Boxes of 1px or less are screen-reader-only
 * (e.g. Next's route announcer is a role=alert), not something the shopper sees. */
const friction = () => {
  let modal = false;
  let errors = 0;
  for (const el of document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true],[role=alert],[aria-invalid=true]")) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width <= 1 || r.height <= 1 || st.visibility === "hidden" || st.display === "none") continue;
    if (el.matches("dialog,[role=dialog],[role=alertdialog],[aria-modal=true]")) modal = true;
    else if (el.matches("[aria-invalid=true]") || (el.textContent ?? "").trim()) errors++;
  }
  return { modal, errors };
};

/** Where a fat-finger tap on a too-small target lands: a few px past one of its edges, side and
 * gap picked by seed and attempt (deterministic), kept inside the viewport. */
export function missPoint(box: { x: number; y: number; width: number; height: number }, vp: { width: number; height: number }, seed: number, attempt: number) {
  const h = Math.imul((seed * 31 + attempt) ^ 0x2545f491, 0x9e3779b1) >>> 0;
  const gap = 6 + ((h >>> 8) % 8);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const sides = [[cx, box.y - gap], [box.x + box.width + gap, cy], [cx, box.y + box.height + gap], [box.x - gap, cy]];
  for (let i = 0; i < 4; i++) {
    const [x, y] = sides[(h + i) % 4];
    if (x >= 0 && y >= 0 && x < vp.width && y < vp.height) return { x, y };
  }
  return { x: Math.min(Math.max(cx, 0), vp.width - 1), y: Math.min(Math.max(cy, 0), vp.height - 1) };
}

/** The storefront reads these on the first URL and tags every PostHog event of the session. */
export function withSwarmTag(url: string, tag: { runId: string; agentId: string; personaId: string }) {
  const u = new URL(url);
  u.searchParams.set("swarm", tag.runId);
  u.searchParams.set("agent", tag.agentId);
  u.searchParams.set("persona", tag.personaId);
  return u.toString();
}

/** Pull what the confirmation page echoed back (see storefront /checkout/success). */
export function readConfirmation(body: string): SwarmAgentResult["confirmation"] {
  const email = body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  const cardLast4 = body.match(/ending in\s+(\d{4})/i)?.[1];
  const address = body.match(/Shipping to\s*\n?\s*([^\n]+)/i)?.[1]?.trim();
  return { email, address, cardLast4 };
}
