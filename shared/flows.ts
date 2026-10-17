import type { Flow, RunConfig } from "./contracts";

export const PRODUCTION_URL = "https://swarm-ecommerce.netlify.app";

export const previewUrl = (prNumber: number) =>
  `https://deploy-preview-${prNumber}--swarm-ecommerce.netlify.app`;

// Storefront: FrissA/demo-ecommerce. The checkout page keeps shipping and
// payment on /checkout; the storefront sets ?step=payment on the payment step
// so the two are distinguishable. /checkout/account is the T2 sign-up wall.
export const buyTshirt: Flow = {
  id: "buy-tshirt",
  goal: "Buy a size M blue t-shirt and check out.",
  startUrl: PRODUCTION_URL,
  success: { urlPattern: "/checkout/success", visibleText: "Payment confirmed" },
  steps: [
    { route: "/", name: "Home" },
    { route: "/shop", name: "Browse" },
    { route: "/shop/product/*", name: "Product" },
    { route: "/cart", name: "Cart" },
    { route: "/checkout/account", name: "Account" },
    { route: "/checkout", name: "Shipping" },
    { route: "/checkout?step=payment", name: "Payment" },
    { route: "/checkout/failed", name: "Payment failed" },
    { route: "/checkout/success", name: "Confirmation" },
  ],
  required: {
    steps: ["Cart", "Shipping", "Payment", "Confirmation"],
    fields: ["email", "fullName", "address", "city", "postalCode", "country", "cardNumber"],
  },
};

export const FLOWS: Record<string, Flow> = { [buyTshirt.id]: buyTshirt };

/** A run's flow: the snapshot in its config.json, else the built-in one (runs
 * from before snapshots existed). Own keys only: "constructor" is not a flow. */
export const flowOf = (config: Pick<RunConfig, "flow" | "flowId">): Flow | undefined =>
  config.flow ?? (Object.hasOwn(FLOWS, config.flowId) ? FLOWS[config.flowId] : undefined);
