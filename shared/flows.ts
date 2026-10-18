import { SEGMENTS } from "./analytics";
import type { EventMatch, Flow, FlowStep, PersonaId, RunConfig } from "./contracts";

export const PRODUCTION_URL = "https://swarm-ecommerce.netlify.app";

export const previewUrl = (prNumber: number) =>
  `https://deploy-preview-${prNumber}--swarm-ecommerce.netlify.app`;

// Storefront: FrissA/demo-ecommerce. The checkout page keeps shipping and
// payment on /checkout; the storefront sets ?step=payment on the payment step
// so the two are distinguishable. /checkout/account is the T2 sign-up wall.
const CHECKOUT_STEPS: FlowStep[] = [
  { route: "/", name: "Home" },
  { route: "/shop", name: "Browse" },
  { route: "/shop/product/*", name: "Product" },
  { route: "/cart", name: "Cart" },
  { route: "/checkout/account", name: "Account" },
  { route: "/checkout", name: "Shipping" },
  { route: "/checkout?step=payment", name: "Payment" },
  { route: "/checkout/failed", name: "Payment failed" },
  { route: "/checkout/success", name: "Confirmation" },
];

/** A placed order: shipping and payment submitted successfully and order_completed fired. */
const ORDER_PLACED: EventMatch[] = [
  { event: "shipping_submitted", where: { success: true } },
  { event: "payment_submitted", where: { success: true } },
  { event: "order_completed" },
];

const checkout = {
  startUrl: PRODUCTION_URL,
  success: { urlPattern: "/checkout/success", visibleText: "Payment confirmed" },
  steps: CHECKOUT_STEPS,
  required: {
    steps: ["Cart", "Shipping", "Payment", "Confirmation"],
    fields: ["email", "fullName", "address", "city", "postalCode", "country", "cardNumber"],
  },
  doneWhen: "When the order is placed and confirmed, call done.",
} satisfies Omit<Flow, "id" | "goal" | "completion">;

// The id stays buy-tshirt (stored runs use it); the store has two blue polos (12, 14), and
// any placed order counts, as before.
export const buyTshirt: Flow = {
  ...checkout,
  id: "buy-tshirt",
  goal: "Find a blue polo shirt, buy it in size M and check out.",
  completion: ORDER_PLACED,
};

/** The store's jeans: Skinny Fit (2) and Faded Skinny (8). Neither comes in green. */
const JEANS = [2, 8];

/** A broad goal: the agent picks the jeans itself (there are no green ones), so any pair counts.
 * Rosa only: it is her judgment under a vague goal we want to see. Real users count only if they
 * viewed a pair of jeans. */
export const buyJeans: Flow = {
  ...checkout,
  id: "buy-jeans",
  goal: "Buy a pair of jeans as a gift for your grandchild, who loves the color green, and check out.",
  completion: [...ORDER_PLACED, { event: "product_added", where: { product_id: JEANS } }],
  attempt: { event: "product_viewed", where: { product_id: JEANS } },
  personas: ["rosa"],
};

/** Checkout with the WELCOME10 code (T5 lives in the promo box); real users count only if they tried a code. */
export const promoCheckout: Flow = {
  ...checkout,
  id: "promo-checkout",
  goal: "Buy a t-shirt using the promo code WELCOME10 and check out.",
  completion: [...ORDER_PLACED, { event: "promo_applied", where: { success: true } }],
  attempt: { event: "promo_applied" },
};

/** Just the top of the funnel: pick a size and get the item into the cart (T4 lives here). */
export const addToCart: Flow = {
  id: "add-to-cart",
  goal: "Pick a size for a t-shirt and add it to your cart.",
  startUrl: PRODUCTION_URL,
  success: { urlPattern: "/cart", visibleText: "Order Summary" },
  steps: CHECKOUT_STEPS.slice(0, 4),
  required: { steps: ["Product", "Cart"], fields: [] },
  completion: [{ event: "product_added" }],
  doneWhen: "When the item is in your cart and you can see it there, call done.",
};

export const FLOWS: Record<string, Flow> = Object.fromEntries([buyTshirt, buyJeans, promoCheckout, addToCart].map((f) => [f.id, f]));

export const MAX_GOAL_LENGTH = 300;

/** The personas that swarm a flow: its own list, else every segment's persona. */
export const flowPersonas = (flow: Flow): PersonaId[] => flow.personas ?? SEGMENTS.map((s) => s.personaId);

/** The swarm's done instruction for a flow that names none (custom flows drafted before
 * Flow.doneWhen existed): the success rule in words. */
export const defaultDoneWhen = (success: Flow["success"]): string => {
  const at = [success.urlPattern && `the page URL matches ${success.urlPattern}`, success.visibleText && `you can see "${success.visibleText}"`].filter(Boolean);
  return `When ${at.join(" and ") || "the goal is done"}, call done.`;
};

/** A stored flow or run snapshot from before Flow.completion / Flow.doneWhen existed, filled in:
 * no extra completion events (the success step and required steps still count) and a
 * doneWhen derived from the success rule. */
export const withFlowDefaults = (flow: Omit<Flow, "completion" | "doneWhen"> & Partial<Pick<Flow, "completion" | "doneWhen">>): Flow =>
  flow.completion && flow.doneWhen
    ? (flow as Flow)
    : { ...flow, completion: flow.completion ?? [], doneWhen: flow.doneWhen ?? defaultDoneWhen(flow.success) };

/** A run's flow: the snapshot in its config.json, else the built-in one (runs
 * from before snapshots existed; own keys only: "constructor" is not a flow),
 * with the goal the PM typed (if any) in place of the flow's. Steps, success and
 * required stay the flow's: they are what the run is measured against. */
export function flowOf(c: Pick<RunConfig, "flowId"> & Partial<Pick<RunConfig, "flow" | "goal">>): Flow | undefined {
  const flow = c.flow ? withFlowDefaults(c.flow) : Object.hasOwn(FLOWS, c.flowId) ? FLOWS[c.flowId] : undefined;
  return flow && c.goal ? { ...flow, goal: c.goal } : flow;
}

/** Same as flowOf (main's name for it). */
export const runFlow = flowOf;
