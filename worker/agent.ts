import type { Page } from "playwright";
import { MAX_ACTIONS_PER_AGENT, matchesRoute, type Event, type Flow, type Persona } from "../shared";
import type { Brain, ToolCall, ToolOutcome } from "./brain";
import { EventLog } from "./events";
import { ID_ATTR, observe, type Observation } from "./observe";

export type AgentResult = { outcome: "success" | "give_up" | "error"; actions: number; events: Event[] };

/** Test details each seed fills in; the storefront accepts the 4242 test card. */
const IDENTITIES = [
  { email: "ana@example.com", fullName: "Ana Pérez", address: "123 Main St", city: "Springfield", postalCode: "12345", country: "United States" },
  { email: "li.wei@example.com", fullName: "Li Wei", address: "48 King Street", city: "Toronto", postalCode: "M5H 1A1", country: "Canada" },
  { email: "sam.jones@example.com", fullName: "Sam Jones", address: "9 Baker Road", city: "London", postalCode: "NW1 6XE", country: "United Kingdom" },
];
const CARD = { number: "4242 4242 4242 4242", expiry: "12/30", cvc: "123" };

export function systemPrompt(persona: Persona, flow: Flow, seed: number, maxActions: number) {
  const me = IDENTITIES[seed % IDENTITIES.length];
  return `${persona.prompt}

Your goal: ${flow.goal}

You are using a real web shop. Each turn you get a screenshot of what is on screen (interactive elements are outlined in red with an id label like e7) and a list of those elements. Act only through the tools: click, type, scroll, back. You cannot type URLs.

- Behave like the person described above, not like a test robot. Use think_aloud to voice reactions as you go (confusion, annoyance, relief), in first person, briefly.
- Take one browser action per turn, then look at the result.
- If you would realistically abandon the purchase, call give_up and say why.
- You have at most ${maxActions} actions (click/type/scroll/back). think_aloud is free.
- When the order is placed and confirmed, call done.

If you are asked for details, use these:
Email: ${me.email}
Full name: ${me.fullName}
Address: ${me.address}, ${me.city} ${me.postalCode}, ${me.country}
Card: ${CARD.number}, expiry ${CARD.expiry}, CVC ${CARD.cvc}, name on card ${me.fullName}
If asked to create an account, any password like "Shopper!2026" is fine.`;
}

const BROWSER_ACTIONS = new Set(["click", "type", "scroll", "back"]);

export type AgentOptions = {
  page: Page;
  brain: Brain;
  persona: Persona;
  flow: Flow;
  runId: string;
  runDir: string;
  seed: number;
  /** URL to open first; defaults to the flow's start URL tagged with ?swarm=<runId>. */
  startUrl?: string;
  /** Pause after each action so client-side navigation and rendering finish. */
  settleMs?: number;
};

/** Runs one persona agent end to end and writes its event log into the run folder. */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const { page, brain, persona, flow } = o;
  const agentId = `${persona.id}-${o.seed}`;
  const log = new EventLog(o.runDir, { runId: o.runId, agentId, personaId: persona.id, seed: o.seed }, flow);
  const maxActions = Math.min(persona.actions.maxActions, MAX_ACTIONS_PER_AGENT);
  // Bounds model turns that only think aloud or call nothing.
  const maxTurns = maxActions * 3;

  let actions = 0;
  let lastUrl = "";
  let obs: Observation;

  const settle = async () => {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(o.settleMs ?? 600);
  };

  /** Observe the page; log a page_view when the URL changed. Returns true on success. */
  const look = async (): Promise<boolean> => {
    obs = await observe(page);
    if (obs.url !== lastUrl) {
      lastUrl = obs.url;
      log.emit({ type: "page_view", url: obs.url, screenshot: log.saveScreenshot(obs.cleanScreenshot) });
      return checkSuccess();
    }
    log.saveLatest(obs.cleanScreenshot);
    return false;
  };

  const checkSuccess = async (): Promise<boolean> => {
    const { urlPattern, visibleText } = flow.success;
    if (urlPattern && !matchesRoute(urlPattern, page.url())) return false;
    const body = await page.locator("body").innerText().catch(() => "");
    if (visibleText && !body.includes(visibleText)) return false;
    log.emit({ type: "success", url: page.url(), confirmation: readConfirmation(body) });
    return true;
  };

  const target = (call: ToolCall) => {
    const id = String(call.input.id ?? "");
    const el = obs.elements.find((e) => e.id === id);
    return { el, locator: page.locator(`[${ID_ATTR}="${id}"]`) };
  };

  const run = async (call: ToolCall): Promise<ToolOutcome & { end?: AgentResult["outcome"] }> => {
    const url = page.url();
    switch (call.name) {
      case "think_aloud":
        log.emit({ type: "think_aloud", url, note: String(call.input.note ?? "") });
        return { call, result: "Noted." };
      case "give_up":
        log.emit({ type: "give_up", url, note: String(call.input.reason ?? "") });
        return { call, result: "You left the shop.", end: "give_up" };
      case "done":
        if (await checkSuccess()) return { call, result: "Order confirmed.", end: "success" };
        return { call, result: "The order is not confirmed yet. Keep going or give up.", isError: true };
      case "click": {
        const { el, locator } = target(call);
        if (!el) return { call, result: `No element ${call.input.id} on screen.`, isError: true };
        try {
          await locator.click({ timeout: 5000 });
          log.emit({ type: "action", url, action: { kind: "click", selector: el.selector, text: el.name } });
          return { call, result: `Clicked ${el.id} "${el.name}".` };
        } catch {
          log.emit({ type: "action", url, action: { kind: "click", selector: el.selector, text: el.name, missed: true } });
          return { call, result: `Clicking ${el.id} did nothing.`, isError: true };
        }
      }
      case "type": {
        const { el, locator } = target(call);
        const text = String(call.input.text ?? "");
        if (!el) return { call, result: `No element ${call.input.id} on screen.`, isError: true };
        try {
          await locator.fill(text, { timeout: 5000 });
          if (call.input.submit) await locator.press("Enter");
          log.emit({ type: "action", url, action: { kind: "type", selector: el.selector, text, field: el.field } });
          return { call, result: `Typed into ${el.id} "${el.name}".` };
        } catch {
          log.emit({ type: "action", url, action: { kind: "type", selector: el.selector, text, field: el.field, missed: true } });
          return { call, result: `Could not type into ${el.id}.`, isError: true };
        }
      }
      case "scroll": {
        const dir = call.input.direction === "up" ? -1 : 1;
        await page.mouse.wheel(0, dir * Math.round(persona.viewport.height * 0.8));
        log.emit({ type: "action", url, action: { kind: "scroll", text: dir > 0 ? "down" : "up" } });
        return { call, result: `Scrolled ${dir > 0 ? "down" : "up"}.` };
      }
      case "back":
        await page.goBack({ timeout: 10000 }).catch(() => {});
        log.emit({ type: "action", url, action: { kind: "back" } });
        return { call, result: "Went back." };
      default:
        return { call, result: `Unknown tool ${call.name}.`, isError: true };
    }
  };

  const finish = (outcome: AgentResult["outcome"]): AgentResult => ({ outcome, actions, events: log.events });

  try {
    await page.goto(o.startUrl ?? withSwarmTag(flow.startUrl, o.runId), { waitUntil: "domcontentloaded" });
    await settle();
    if (await look()) return finish("success");

    let outcomes: ToolOutcome[] = [];
    for (let turn = 0; turn < maxTurns; turn++) {
      const calls = await o.brain.decide({ outcomes, observation: obs! });
      outcomes = [];
      let acted = false;
      for (const call of calls) {
        if (BROWSER_ACTIONS.has(call.name)) {
          // One browser action per turn: anything after it targets a stale screen.
          if (acted) {
            outcomes.push({ call, result: "Skipped: the screen may have changed, look again first.", isError: true });
            continue;
          }
          if (actions >= maxActions) break;
          acted = true;
          actions++;
        }
        const out = await run(call);
        outcomes.push(out);
        if (out.end) return finish(out.end);
      }
      if (acted) {
        await settle();
        if (await look()) return finish("success");
      } else {
        obs = await observe(page);
      }
      if (actions >= maxActions) {
        log.emit({ type: "give_up", url: page.url(), note: `Ran out of actions (${maxActions}).` });
        return finish("give_up");
      }
    }
    log.emit({ type: "give_up", url: page.url(), note: `Stalled: no progress after ${maxTurns} turns.` });
    return finish("give_up");
  } catch (err) {
    log.emit({ type: "error", url: page.url(), note: err instanceof Error ? err.message : String(err) });
    return finish("error");
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
