import type { Event, Flow } from "@frictionswarm/shared";
import { groupByAgent } from "./run";

export type SignalKind = "give_up" | "think_aloud" | "error" | "missed_tap" | "repeat_click" | "back_and_forth";

export type FrictionSignal = {
  kind: SignalKind;
  agentId: string;
  personaId: string;
  step: string;
  /** Flow route of the step (e.g. "/shop/product/*"), else the URL pathname. */
  page: string;
  selector?: string;
  /** Visible text of the element, when known. */
  text?: string;
  note?: string;
  screenshot?: string;
  count?: number;
  ts: number;
};

export function pageOf(flow: Flow, e: Event): string {
  const route = flow.steps.find((s) => s.name === e.step)?.route;
  if (route) return route;
  try {
    return new URL(e.url ?? "/", "http://x").pathname;
  } catch {
    return e.url ?? "?";
  }
}

/** Screenshot at or before index i in the agent's log, else the next one after. */
export function nearestScreenshot(evs: Event[], i: number): string | undefined {
  for (let j = i; j >= 0; j--) if (evs[j].screenshot) return evs[j].screenshot;
  return evs.slice(i + 1).find((e) => e.screenshot)?.screenshot;
}

export function frictionSignals(flow: Flow, events: Event[]): FrictionSignal[] {
  const out: FrictionSignal[] = [];
  for (const evs of groupByAgent(events).values()) {
    const base = (e: Event, i: number) => ({
      agentId: e.agentId,
      personaId: e.personaId,
      step: e.step ?? "?",
      page: pageOf(flow, e),
      screenshot: nearestScreenshot(evs, i),
      ts: e.ts,
    });
    const clicks = new Map<string, { i: number; count: number }>();
    evs.forEach((e, i) => {
      if (e.type === "give_up" || e.type === "think_aloud" || e.type === "error")
        out.push({ kind: e.type, ...base(e, i), note: e.note });
      if (e.type === "action" && e.action?.missed)
        out.push({ kind: "missed_tap", ...base(e, i), selector: e.action.selector, text: e.action.text });
      if (e.type === "action" && e.action?.kind === "click" && e.action.selector) {
        const k = `${e.step}\u0000${e.action.selector}`;
        const c = clicks.get(k) ?? { i, count: 0 };
        clicks.set(k, { ...c, count: c.count + 1 });
      }
    });
    for (const [k, { i, count }] of clicks)
      if (count >= 3) out.push({ kind: "repeat_click", ...base(evs[i], i), selector: k.split("\u0000")[1], text: evs[i].action?.text, count });

    const views = evs.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "page_view" && e.step);
    const seq = views.filter((v, j) => j === 0 || v.e.step !== views[j - 1].e.step);
    for (let j = 1; j + 1 < seq.length; j++)
      if (seq[j - 1].e.step === seq[j + 1].e.step) {
        const { e, i } = seq[j];
        out.push({ kind: "back_and_forth", ...base(e, i), note: `${seq[j - 1].e.step} → ${e.step} → ${seq[j + 1].e.step}` });
      }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
