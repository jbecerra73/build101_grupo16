import type { EventMatch, Flow, FlowStep } from "./contracts";

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

export const buyTshirt: Flow = {
  ...checkout,
  id: "buy-tshirt",
  goal: "Buy a size M blue t-shirt and check out.",
  completion: ORDER_PLACED,
};

/** The same checkout for one other product; real users count only if they viewed it. */
export const buyJeans: Flow = {
  ...checkout,
  id: "buy-jeans",
  goal: "Buy the Skinny Fit Jeans in size Large and check out.",
  completion: [...ORDER_PLACED, { event: "product_added", where: { product_id: 2 } }],
  attempt: { event: "product_viewed", where: { product_id: 2 } },
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

/** A run's flow with the goal the PM typed (if any) in place of the preset's. Steps, success and
 * required stay the preset's: they are what the run is measured against. */
export function runFlow(c: { flowId: string; goal?: string }): Flow | undefined {
  const flow = FLOWS[c.flowId];
  return flow && c.goal ? { ...flow, goal: c.goal } : flow;
}
