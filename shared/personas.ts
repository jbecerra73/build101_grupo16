import type { Persona } from "./contracts";

// The constraints, not the prompt, are the validity argument: Rosa cannot see
// low-contrast or tiny text, Kai cannot hit small targets and runs out of
// patience, Typical is the control that must not regress.

export const rosa: Persona = {
  id: "rosa",
  name: "Rosa, 67, low vision",
  prompt:
    "You are Rosa, 67, retired. Your eyesight is poor and you read slowly. " +
    "You are wary of jargon and of anything that looks like a trick. " +
    "If you cannot find something after a couple of tries you give up and say why.",
  viewport: { width: 1280, height: 800, mobile: false },
  perception: {
    mode: "screenshot",
    blur: 1.5,
    downscale: 0.6,
    minContrast: 4.5,
    minFontPx: 14,
    hideHoverOnly: true,
  },
  actions: { maxActions: 40, maxRetriesSameTarget: 2 },
  patience: { start: 10, costs: { pageLoad: 0, modal: 2, error: 3 } },
};

export const kai: Persona = {
  id: "kai",
  name: "Kai, 19, impatient, mobile",
  prompt:
    "You are Kai, 19, shopping on your phone between classes. You skim, tap fast " +
    "and hate forms, sign-ups and pop-ups. If it takes too long you leave.",
  viewport: { width: 375, height: 812, mobile: true },
  perception: { mode: "screenshot+a11y", hideHoverOnly: true },
  actions: { maxActions: 22, maxActionsRange: [16, 22], minTapTargetPx: 44, maxRetriesSameTarget: 2 },
  patience: { start: 6, costs: { pageLoad: 1, modal: 2, error: 2 } },
};

export const typical: Persona = {
  id: "typical",
  name: "Typical shopper",
  prompt:
    "You are an ordinary online shopper on a laptop. You read the page normally " +
    "and complete the purchase if it is reasonably possible. You have the promo " +
    "code WELCOME10 and always apply it at checkout.",
  control: true,
  viewport: { width: 1280, height: 800, mobile: false },
  perception: { mode: "screenshot+a11y" },
  actions: { maxActions: 40, maxRetriesSameTarget: 4 },
  patience: { start: 20, costs: { pageLoad: 0, modal: 1, error: 1 } },
};

export const PERSONAS: Record<string, Persona> = { rosa, kai, typical };

/** Hard cap regardless of persona (SPEC: 40 actions per agent; a full checkout with the T2 sign-up wall takes ~30). */
export const MAX_ACTIONS_PER_AGENT = 40;

/** An agent's action budget: drawn from maxActionsRange by seed (deterministic,
 * so a seed always gets the same budget), capped at MAX_ACTIONS_PER_AGENT. */
export function actionBudget(persona: Persona, seed: number): number {
  const range = persona.actions.maxActionsRange;
  if (!range) return Math.min(persona.actions.maxActions, MAX_ACTIONS_PER_AGENT);
  const [min, max] = range;
  const h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return Math.min(min + (h % (max - min + 1)), MAX_ACTIONS_PER_AGENT);
}
