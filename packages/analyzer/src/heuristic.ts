import type { Event, Finding, Flow, Severity } from "@frictionswarm/shared";
import { groupByAgent } from "./run";
import type { FrictionSignal } from "./signals";
import { validateCompletion } from "./validity";

/** For each step, the click that took valid completers to the next step (most common one). */
export function exitActions(flow: Flow, events: Event[]): Map<string, { selector: string; text?: string }> {
  const counts = new Map<string, Map<string, { selector: string; text?: string; n: number }>>();
  for (const evs of groupByAgent(events).values()) {
    if (!validateCompletion(flow, evs).valid) continue;
    let lastClick: Event | undefined;
    for (const e of evs) {
      if (e.type === "action" && e.action?.kind === "click" && e.action.selector) lastClick = e;
      if (e.type === "page_view" && lastClick && lastClick.step && e.step !== lastClick.step) {
        const m = counts.get(lastClick.step) ?? new Map();
        const sel = lastClick.action!.selector!;
        m.set(sel, { selector: sel, text: lastClick.action!.text, n: (m.get(sel)?.n ?? 0) + 1 });
        counts.set(lastClick.step, m);
        lastClick = undefined;
      }
    }
  }
  return new Map([...counts].map(([step, m]) => [step, [...m.values()].sort((a, b) => b.n - a.n)[0]]));
}

const uniq = <T>(xs: (T | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== undefined && x !== ""))];

const FIX: Record<string, string> = {
  missed_tap: "Enlarge the tap target to at least 44x44px and space it from neighbours.",
  repeat_click: "Make the control respond visibly on the first click (state change, feedback, or navigation).",
  back_and_forth: "Show on this page the information shoppers keep going back for.",
  error: "Fix the error shown on this step and explain recovery in plain language.",
};

/** Deterministic findings: group signals by (step, page, selector), rank by give-ups then distinct agents. */
export function heuristicFindings(flow: Flow, events: Event[], signals: FrictionSignal[]): Finding[] {
  const exits = exitActions(flow, events);
  const groups = new Map<string, FrictionSignal[]>();
  for (const s of signals) {
    const selector = s.selector ?? exits.get(s.step)?.selector;
    const key = JSON.stringify([s.step, s.page, selector ?? null]);
    groups.set(key, [...(groups.get(key) ?? []), { ...s, selector }]);
  }
  const scored = [...groups.values()].map((g) => {
    const agents = uniq(g.map((s) => s.agentId));
    const giveUps = uniq(g.filter((s) => s.kind === "give_up").map((s) => s.agentId)).length;
    return { g, agents, giveUps, score: giveUps * 10 + agents.length * 3 + g.length };
  });
  scored.sort((a, b) => b.score - a.score);

  return scored.map(({ g, agents, giveUps }, i): Finding => {
    const { step, page, selector } = g[0];
    const personas = uniq(g.map((s) => s.personaId));
    const kinds = new Set(g.map((s) => s.kind));
    const exit = exits.get(step);
    const label = (exit?.selector === selector && exit?.text) || g.find((s) => s.text)?.text;
    const severity: Severity = giveUps ? "high" : agents.length > 1 || kinds.has("back_and_forth") || kinds.has("error") ? "medium" : "low";
    const who = personas.join(", ");
    const title = giveUps
      ? `${who} gave up at ${step}${label ? ` near '${label}'` : ""}`
      : kinds.has("missed_tap")
        ? `Missed taps on ${label ? `'${label}'` : selector} at ${step}`
        : kinds.has("repeat_click")
          ? `Repeated clicks on ${label ? `'${label}'` : selector} at ${step}`
          : kinds.has("back_and_forth")
            ? `Shoppers bounce back and forth around ${step}`
            : `Confusion at ${step}${label ? ` around '${label}'` : ""}`;
    const kind = [...kinds].find((k) => FIX[k]);
    const suggestedFix =
      kinds.has("give_up") || kinds.has("think_aloud") || !kind
        ? label
          ? `Make '${label}' obvious: high-contrast, large, clearly labelled primary action on ${page}.`
          : `Remove the blocker on ${page} so shoppers can continue without extra effort.`
        : FIX[kind];
    return {
      id: `F${i + 1}`,
      severity,
      personas,
      step,
      page,
      ...(selector ? { selector } : {}),
      title,
      evidence: {
        screenshots: uniq(g.map((s) => s.screenshot)).slice(0, 3),
        quotes: uniq([...g.filter((s) => s.kind === "give_up"), ...g.filter((s) => s.kind === "think_aloud")].map((s) => s.note)).slice(0, 3),
        agentCount: agents.length,
      },
      suggestedFix,
    };
  });
}
