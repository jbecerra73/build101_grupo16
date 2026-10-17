import type { Page } from "playwright";
import { MAX_ACTIONS_PER_AGENT, matchesRoute, type Event, type Flow, type Persona } from "../shared";
import { EventLog } from "./events";
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

export const maxActionsFor = (persona: Persona) => Math.min(persona.actions.maxActions, MAX_ACTIONS_PER_AGENT);

export function systemPrompt(persona: Persona, flow: Flow, seed: number) {
  const me = IDENTITIES[seed % IDENTITIES.length];
  return `${persona.prompt}

Your goal: ${flow.goal}

You are using a real web shop through tools. Start by calling look. Every action returns a screenshot of the screen (interactive elements are outlined in red with an id label like e7) and a list of those elements. Act only through click, type, scroll and back, one at a time, and look at the result before the next one. You cannot type URLs.

- Behave like the person described above, not like a test robot. Use think_aloud to voice reactions as you go (confusion, annoyance, relief), in first person, briefly.
- If you would realistically abandon the purchase, call give_up and say why.
- You have at most ${maxActionsFor(persona)} actions (click/type/scroll/back). look and think_aloud are free.
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
};

/** One persona agent in one browser page: runs tool calls, enforces limits, writes the event log.
 * Whoever drives it (Claude Code over MCP, or a scripted brain in tests) only sees StepResults. */
export class AgentSession {
  readonly agentId: string;
  readonly maxActions: number;
  /** Bounds calls that never act (looking, thinking aloud, unknown ids). */
  readonly maxCalls: number;
  actions = 0;
  calls = 0;
  outcome?: Outcome;
  private readonly log: EventLog;
  private obs?: Observation;
  private lastUrl = "";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SessionOptions) {
    this.agentId = `${o.persona.id}-${o.seed}`;
    this.maxActions = maxActionsFor(o.persona);
    this.maxCalls = this.maxActions * 4;
    this.log = new EventLog(o.runDir, { runId: o.runId, agentId: this.agentId, personaId: o.persona.id, seed: o.seed }, o.flow);
  }

  get events(): Event[] {
    return this.log.events;
  }

  get observation(): Observation | undefined {
    return this.obs;
  }

  async start(url: string): Promise<StepResult> {
    return this.serial(async () => {
      try {
        await this.o.page.goto(url, { waitUntil: "domcontentloaded" });
        await this.settle();
        await this.look();
        return this.result("You opened the shop.");
      } catch (err) {
        return this.fail(err);
      }
    });
  }

  /** Runs one tool call. Calls are serialized: the page is a single shared resource. */
  call(c: ToolCall): Promise<StepResult> {
    return this.serial(() => this.run(c));
  }

  /** Ends the session if the driver stopped without finishing. */
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
      case "look":
        await this.look();
        return this.result("This is the screen now.");
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
      try {
        if (typed === undefined) await locator.click({ timeout: 5000 });
        else {
          await locator.fill(typed, { timeout: 5000 });
          if (c.input.submit) await locator.press("Enter");
        }
        text = typed === undefined ? `Clicked ${id} "${el.name}".` : `Typed into ${id} "${el.name}".`;
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
    }

    this.actions++;
    // Client-side navigation can land after the click resolves; give it a moment to start.
    if (c.name !== "scroll") await page.waitForURL((u) => u.toString() !== url, { timeout: this.o.navWaitMs ?? 1500 }).catch(() => {});
    await this.settle();
    if (await this.look()) return { text: `${text} Order confirmed. The session is over.`, ended: "success", observation: this.obs };
    if (this.actions >= this.maxActions) return this.end("give_up", `Ran out of actions (${this.maxActions}).`);
    return this.result(`${text} (${this.maxActions - this.actions} actions left)`, isError);
  }

  private async settle() {
    await this.o.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.o.page.waitForTimeout(this.o.settleMs ?? 600);
  }

  /** Observe the page; log a page_view when the URL changed. Returns true on success. */
  private async look(): Promise<boolean> {
    this.obs = await observe(this.o.page);
    if (this.obs.url === this.lastUrl) {
      this.log.saveLatest(this.obs.cleanScreenshot);
      return false;
    }
    this.lastUrl = this.obs.url;
    this.log.emit({ type: "page_view", url: this.obs.url, screenshot: this.log.saveScreenshot(this.obs.cleanScreenshot) });
    return this.checkSuccess();
  }

  private async checkSuccess(): Promise<boolean> {
    if (this.outcome === "success") return true;
    const { page, flow } = this.o;
    const { urlPattern, visibleText } = flow.success;
    if (urlPattern && !matchesRoute(urlPattern, page.url())) return false;
    const body = await page.locator("body").innerText().catch(() => "");
    if (visibleText && !body.includes(visibleText)) return false;
    this.log.emit({ type: "success", url: page.url(), confirmation: readConfirmation(body) });
    this.outcome = "success";
    return true;
  }

  private result(text: string, isError = false): StepResult {
    return { text, isError, observation: this.obs };
  }

  private end(outcome: "give_up", note: string): StepResult {
    this.log.emit({ type: "give_up", url: this.o.page.url(), note });
    this.outcome = outcome;
    return { text: `You left the shop (${note}). The session is over.`, ended: outcome };
  }

  private fail(err: unknown): StepResult {
    const note = err instanceof Error ? err.message : String(err);
    this.log.emit({ type: "error", url: this.o.page.url(), note });
    this.outcome = "error";
    return { text: `Something broke: ${note}. The session is over.`, isError: true, ended: "error" };
  }
}

export function withSwarmTag(url: string, runId: string) {
  const u = new URL(url);
  u.searchParams.set("swarm", runId);
  return u.toString();
}

/** Pull what the confirmation page echoed back (see storefront /checkout/success). */
export function readConfirmation(body: string): Event["confirmation"] {
  const email = body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  const cardLast4 = body.match(/ending in\s+(\d{4})/i)?.[1];
  const address = body.match(/Shipping to\s*\n?\s*([^\n]+)/i)?.[1]?.trim();
  return { email, address, cardLast4 };
}
