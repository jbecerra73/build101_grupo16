// Simulates storefront sessions as the PostHog events the real trackers send
// (see shared/analytics.ts). Used for two things:
//   - months of fake real-user history on production (the analyzer's "before")
//   - swarm agents' tracks on a deploy preview (the re-test's "after")
// Deterministic: same seed, same events.

import type { PersonaId } from "../../shared/contracts";
import {
  segmentOf,
  type PostHogEvent,
  type SegmentId,
  type StoreEvent,
  type StoreEventProperties,
  type SwarmEvent,
  type SwarmEventProperties,
} from "../../shared/analytics";

export type TrapId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6";

/** Production history. Each release ships with the traps live at that point;
 * the last one is the store as it is now (all six traps). */
export type Release = { sha: string; date: string; name: string; traps: TrapId[] };

export const RELEASES: Release[] = [
  { sha: "3b1f0c9e2a7d4b6f8c1e5a9d0b2c4e6f8a1b3c5d", date: "2026-04-01", name: "Simulated checkout", traps: ["T3"] },
  { sha: "8e4d2a6c0b9f1e3a5c7d9b2f4a6c8e0d1b3f5a7c", date: "2026-05-20", name: "New product page", traps: ["T3", "T4"] },
  { sha: "c7a9e1b3d5f7092a4c6e8b0d2f4a6c8e1b3d5f70", date: "2026-06-24", name: "Checkout redesign", traps: ["T1", "T3", "T4"] },
  { sha: "5d2f8b4a6c0e1d3f5a7b9c2e4d6f8a0b1c3e5d7f", date: "2026-08-05", name: "Promo codes", traps: ["T1", "T3", "T4", "T5"] },
  { sha: "f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1d3b5f7a9", date: "2026-09-09", name: "Accounts", traps: ["T1", "T2", "T3", "T4", "T5"] },
  { sha: "a9c1e3b5d7f0294b6d8f1a3c5e7b9d0f2a4c6e81", date: "2026-09-23", name: "Shop filters", traps: ["T1", "T2", "T3", "T4", "T5", "T6"] },
];

export const releaseAt = (ts: number): Release =>
  RELEASES.filter((r) => Date.parse(r.date) <= ts).at(-1) ?? RELEASES[0];

export const PRODUCTION_HOST = "swarm-ecommerce.netlify.app";

// ---------------------------------------------------------------------------
// Randomness

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const weighted = <T>(rng: Rng, xs: readonly (readonly [T, number])[]): T => {
  let r = rng() * xs.reduce((s, [, w]) => s + w, 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[xs.length - 1][0];
};
const between = (rng: Rng, min: number, max: number) => min + rng() * (max - min);
/** Dwell time in ms, skewed right like real dwell times. */
const dwell = (rng: Rng, medianS: number) => Math.round(medianS * 1000 * Math.exp((rng() - 0.5) * 1.4));

const hex = (rng: Rng, n: number) =>
  Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");

/** UUIDv7-shaped (time-ordered, like PostHog's own ids). */
export const uuid7 = (rng: Rng, ts: number) => {
  const t = ts.toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8)}-7${hex(rng, 3)}-${pick(rng, ["8", "9", "a", "b"])}${hex(rng, 3)}-${hex(rng, 12)}`;
};

// ---------------------------------------------------------------------------
// Store model

export const PRODUCTS = [
  { id: 1, name: "T-shirt with Tape Details", price: 120 },
  { id: 2, name: "Skinny Fit Jeans", price: 208 },
  { id: 3, name: "Chechered Shirt", price: 180 },
  { id: 4, name: "Sleeve Striped T-shirt", price: 112 },
  { id: 5, name: "Vertical Striped Shirt", price: 186 },
  { id: 6, name: "Courage Graphic T-shirt", price: 145 },
  { id: 7, name: "Loose Fit Bermuda Shorts", price: 80 },
  { id: 8, name: "Faded Skinny Jeans", price: 210 },
  { id: 12, name: "Polo with Contrast Trims", price: 194 },
  { id: 13, name: "Gradient Graphic T-shirt", price: 145 },
] as const;
type Product = (typeof PRODUCTS)[number];

const productPath = (p: Product) => `/shop/product/${p.id}/${p.name.split(" ").join("-")}`;
const SIZES = ["Small", "Medium", "Large", "X-Large"];
const COLORS = ["Brown", "Green", "Blue", "Black"];
const SWATCHES: Record<string, string> = { Brown: "bg-[#4F4631]", Green: "bg-[#314F4A]", Blue: "bg-[#31344F]", Red: "bg-[#9B2C2C]", Black: "bg-black", White: "bg-white" };
const DELIVERY_FEE = 15;
const SHIPPING_FIELDS = ["email", "fullName", "address", "city", "postalCode"];
const ACCOUNT_FIELDS = ["username", "password", "confirmPassword", "phone", "birthDate", "acceptTerms"];
const FAILURES = ["card_declined", "insufficient_funds", "expired_card", "processing_error"];

// PostHog element chains (`tag.classes:attr__x="…"nth-child="…"text="…"`,
// ancestors after `;`) for the elements the traps live on.
export const ELEMENTS = {
  sizePill: 'div.flex.items-center.gap-3.bg-[#F0F0F0].px-5.py-2.5.rounded-full.text-sm.cursor-default:nth-child="1"nth-of-type="1"text="Size";div.group.relative.w-fit:nth-child="2"nth-of-type="2"',
  sizeButton: (size: string) => `button.bg-[#F0F0F0].px-4.py-2.text-sm.rounded-full:attr__type="button"nth-child="1"nth-of-type="1"text="${size}";div.flex.gap-2.rounded-2xl`,
  addToCart: 'button.bg-black.w-full.rounded-full.h-11:attr__type="button"nth-child="2"nth-of-type="1"text="Add to Cart";div.relative.w-full',
  goToCheckout: 'a.bg-black.rounded-full.w-full.py-4:attr__href="/checkout/account"nth-child="3"nth-of-type="1"text="Go to Checkout"',
  cartIcon: 'a.relative.mr-[14px].p-1:attr__href="/cart"nth-child="1"nth-of-type="1"',
  productCard: (p: Product) => `a.flex.flex-col.items-start:attr__href="${productPath(p)}"nth-child="1"nth-of-type="1"text="${p.name}"`,
  shopNow: 'a.w-full.md:w-52.mb-5.bg-black.text-white:attr__href="/shop"nth-child="3"nth-of-type="1"text="Shop Now"',
  createAccount: 'button.text-sm.md:text-base.font-medium.rounded-full.w-full:attr__type="submit"nth-child="1"nth-of-type="1"text="Create account"',
  continueToPayment: 'button.text-[11px].text-[#c4c4c4].underline-offset-2:attr__type="submit"nth-child="1"nth-of-type="1"text="Continue to payment";div.flex.items-center.p-6.pt-0.justify-end',
  shippingFooter: 'div.flex.items-center.p-6.pt-0.justify-end:nth-child="3"nth-of-type="3";form;div.rounded-[20px].border-black/10',
  shippingTitle: 'div.text-xl.md:text-2xl.font-bold:nth-child="1"nth-of-type="1"text="Contact & Shipping"',
  promoApply: 'button.h-11.w-28.rounded-full:attr__type="button"nth-child="2"nth-of-type="1"text="Apply"',
  pay: 'button.text-sm.md:text-base.font-medium.rounded-full.w-full:attr__type="submit"nth-child="1"nth-of-type="1"text="Pay now"',
  colorSwatch: (color: string) => `button.${SWATCHES[color]}.rounded-full.w-9.sm:w-10.h-9.sm:h-10.flex.items-center.justify-center:attr__aria-label="${color}"attr__type="button"nth-child="${Object.keys(SWATCHES).indexOf(color) + 1}"nth-of-type="${Object.keys(SWATCHES).indexOf(color) + 1}";div.flex.space-2.5.flex-wrap.md:grid.grid-cols-5`,
  applyFilter: 'button.bg-black.w-full.rounded-full.text-sm.font-medium.py-4.h-12:attr__type="button"nth-child="12"nth-of-type="2"text="Apply Filter"',
  tryAgain: 'a.text-sm.md:text-base.font-medium.rounded-full:attr__href="/checkout?step=payment"nth-child="1"nth-of-type="1"text="Try Again"',
} as const;

/** How likely each trap is to stop someone, by who they are. Probabilities
 * apply only while the trap is live; `base` is ordinary friction without it. */
export type Profile = {
  /** T4: can't open the hover-only size picker. */
  failSize: number;
  /** T2: leaves at the forced sign-up. */
  failAccount: number;
  /** T1: can't find the "Continue to payment" link. */
  failContinue: number;
  /** T3: leaves when the delivery fee appears on the payment step. */
  feeShock: number;
  /** T5: leaves after the promo code wipes the shipping form. */
  wipeQuit: number;
  /** T6: leaves when a picked filter seems to do nothing (Apply is below the fold). */
  failFilter: number;
  base: { failSize: number; failContinue: number; feeShock: number };
};

export const SEGMENT_PROFILES: Record<SegmentId, Profile> = {
  desktop: {
    failSize: 0.08, failAccount: 0.27, failContinue: 0.09, feeShock: 0.13, wipeQuit: 0.35, failFilter: 0.12,
    base: { failSize: 0.02, failContinue: 0.02, feeShock: 0.04 },
  },
  mobile: {
    failSize: 0.48, failAccount: 0.58, failContinue: 0.2, feeShock: 0.2, wipeQuit: 0.5, failFilter: 0.42,
    base: { failSize: 0.03, failContinue: 0.03, feeShock: 0.06 },
  },
  low_vision: {
    failSize: 0.38, failAccount: 0.4, failContinue: 0.64, feeShock: 0.15, wipeQuit: 0.45, failFilter: 0.4,
    base: { failSize: 0.04, failContinue: 0.05, feeShock: 0.05 },
  },
};

/** Swarm agents are goal-directed, so their odds follow the persona's
 * enforced constraints rather than shopping intent. */
export const PERSONA_PROFILES: Record<PersonaId, Profile> = {
  rosa: {
    failSize: 0.3, failAccount: 0.2, failContinue: 0.92, feeShock: 0.1, wipeQuit: 0.3, failFilter: 0.3,
    base: { failSize: 0.04, failContinue: 0.04, feeShock: 0.03 },
  },
  kai: {
    failSize: 0.3, failAccount: 0.88, failContinue: 0.25, feeShock: 0.2, wipeQuit: 0.6, failFilter: 0.35,
    base: { failSize: 0.03, failContinue: 0.03, feeShock: 0.05 },
  },
  typical: {
    failSize: 0.04, failAccount: 0.05, failContinue: 0.04, feeShock: 0.04, wipeQuit: 0.12, failFilter: 0.08,
    base: { failSize: 0.01, failContinue: 0.01, feeShock: 0.02 },
  },
};

// ---------------------------------------------------------------------------
// Visitors

export type Visitor = {
  distinctId: string;
  device: "Desktop" | "Mobile" | "Tablet";
  os: string;
  browser: string;
  viewport: [number, number];
  fontScale: number;
  prefersContrast: boolean;
};

export function newVisitor(rng: Rng, ts: number): Visitor {
  const device = weighted(rng, [["Mobile", 58], ["Desktop", 37], ["Tablet", 5]] as const);
  const [os, browser] =
    device === "Desktop"
      ? weighted(rng, [[["Windows", "Chrome"], 40], [["Mac OS X", "Chrome"], 22], [["Mac OS X", "Safari"], 18], [["Windows", "Edge"], 12], [["Windows", "Firefox"], 8]] as const)
      : weighted(rng, [[["iOS", "Mobile Safari"], 52], [["Android", "Chrome"], 42], [["Android", "Samsung Internet"], 6]] as const);
  const viewport: [number, number] =
    device === "Mobile" ? pick(rng, [[390, 844], [375, 812], [414, 896], [360, 800], [430, 932]] as [number, number][])
    : device === "Tablet" ? pick(rng, [[768, 1024], [820, 1180], [1024, 1366]] as [number, number][])
    : pick(rng, [[1280, 800], [1440, 900], [1536, 864], [1920, 1080], [1366, 768]] as [number, number][]);
  // Raised default text size or high contrast: ~7% desktop, ~4% mobile.
  const largeText = rng() < (device === "Desktop" ? 0.065 : 0.035);
  return {
    distinctId: uuid7(rng, ts),
    device,
    os,
    browser,
    viewport,
    fontScale: largeText ? pick(rng, [1.25, 1.5, 1.75, 2]) : 1,
    prefersContrast: rng() < 0.012,
  };
}

// ---------------------------------------------------------------------------
// Sessions

export type SwarmTag = { run: string; agent: string; persona: PersonaId };

export type SessionOptions = {
  rng: Rng;
  start: number;
  visitor: Visitor;
  host: string;
  buildSha: string;
  traps: TrapId[];
  profile: Profile;
  /** Swarm agents: goal-directed, tagged, and narrate via swarm_* events. */
  swarm?: SwarmTag;
  referrer?: { url: string; domain: string; utm_campaign?: string };
  /** Visitor created an account in an earlier session (skips T2). */
  hasAccount?: boolean;
  /** The promo code box exists (shipped with the "Promo codes" release). */
  promoCodes: boolean;
};

export type SessionResult = {
  events: PostHogEvent[];
  completed: boolean;
  /** Where the session ended, as a funnel step name. */
  exitStep: string;
  createdAccount: boolean;
};

const QUOTES: Record<string, string[]> = {
  size: [
    "I tapped the size box but nothing opens. I can't pick a size.",
    "There's a 'Size' label but no sizes I can choose.",
    "It keeps saying select a size but I don't see any sizes.",
  ],
  account: [
    "Nine fields just to buy a t-shirt? Not doing that on my phone.",
    "Forced to create an account with a password and birth date. I'm out.",
    "Why do they need my date of birth to sell me a shirt?",
  ],
  continue: [
    "I filled everything in but I can't find a button to continue.",
    "There is nothing at the bottom I can read. I don't see how to continue to payment.",
    "Where is the next button? I give up.",
  ],
  fee: [
    "A $15 delivery fee only now, on the last step? No thanks.",
    "The total jumped at payment. I wasn't told about shipping before.",
  ],
  filter: [
    "I picked Blue but the list didn't change. The filters don't work.",
    "I tapped the color and nothing happened. I can't narrow this down.",
    "The filters do nothing. I'm not scrolling through everything.",
  ],
  wipe: [
    "Applying the promo code erased my whole address. I'm not typing it again.",
    "The form went blank after I added the discount code.",
  ],
};

const NOTES: Record<string, string[]> = {
  Home: ["Okay, I'm on the home page. Looking for t-shirts.", "Let me find the shop."],
  Browse: ["I see a list of products. Looking for a blue t-shirt.", "There's the t-shirt."],
  Product: ["Product page. I need size Medium.", "I'll pick a size and add it to the cart."],
  Cart: ["The shirt is in my cart. Going to checkout."],
  Account: ["It wants me to create an account first."],
  Shipping: ["Now the shipping form. Filling in my address."],
  Payment: ["Payment page. Entering the test card."],
  Confirmation: ["Done, it says payment confirmed."],
};

export function simulateSession(o: SessionOptions): SessionResult {
  const { rng, visitor: v, profile } = o;
  const traps = new Set(o.traps);
  const events: PostHogEvent[] = [];
  const sessionId = uuid7(rng, o.start);
  const windowId = uuid7(rng, o.start);
  const swarm = !!o.swarm;
  const distinctId = o.swarm ? `swarm:${o.swarm.agent}` : v.distinctId;
  let t = o.start;
  let path = "/";
  let first = true;
  let actions = 0;
  let createdAccount = false;

  const base = () => ({
    $session_id: sessionId,
    $window_id: windowId,
    $device_type: v.device,
    $os: v.os,
    $browser: v.browser,
    $viewport_width: v.viewport[0],
    $viewport_height: v.viewport[1],
    $screen_width: v.viewport[0],
    $screen_height: v.viewport[1],
    $lib: "web",
    $lib_version: "1.435.8",
    $host: o.host,
    $current_url: `https://${o.host}${path}`,
    $pathname: path.split("?")[0],
    build_sha: o.buildSha,
    font_scale: v.fontScale,
    prefers_contrast: v.prefersContrast,
    ...(o.swarm && { swarm_run: o.swarm.run, swarm_agent: o.swarm.agent, swarm_persona: o.swarm.persona }),
  });

  const emit = (event: string, props: Record<string, unknown> = {}) => {
    events.push({
      uuid: uuid7(rng, t),
      event,
      distinct_id: distinctId,
      timestamp: new Date(t).toISOString(),
      properties: { ...base(), ...props },
    });
    t += Math.round(between(rng, 5, 60));
  };
  const track = <E extends StoreEvent>(event: E, props: StoreEventProperties[E]) => emit(event, props);
  const narrate = <E extends SwarmEvent>(event: E, props: SwarmEventProperties[E]) => {
    if (swarm) emit(event, props);
  };
  const wait = (medianS: number) => {
    t += swarm ? dwell(rng, Math.min(medianS, 6)) : dwell(rng, medianS);
  };
  const click = (chain: string, text?: string, eventType = "click") => {
    actions++;
    emit("$autocapture", { $event_type: eventType, $elements_chain: chain, ...(text && { $el_text: text }) });
  };
  const rage = (chain: string, text?: string) => {
    for (let i = 0; i < 3 + Math.floor(rng() * 3); i++) click(chain, text);
    emit("$rageclick", { $elements_chain: chain, ...(text && { $el_text: text }) });
  };
  const view = (next: string, step: string) => {
    if (!first) emit("$pageleave");
    path = next;
    const extra = first && o.referrer
      ? { $referrer: o.referrer.url, $referring_domain: o.referrer.domain, ...(o.referrer.utm_campaign && { utm_campaign: o.referrer.utm_campaign, utm_source: "newsletter" }) }
      : first ? { $referrer: "$direct", $referring_domain: "$direct" } : {};
    first = false;
    emit("$pageview", extra);
    if (swarm && rng() < 0.6) narrate("swarm_think_aloud", { note: pick(rng, NOTES[step] ?? ["Looking around."]), step });
  };
  const leave = (step: string, quoteKey?: string): SessionResult => {
    if (quoteKey) narrate("swarm_give_up", { reason: pick(rng, QUOTES[quoteKey]), step });
    else if (swarm) narrate("swarm_give_up", { reason: "This is taking too long.", step });
    wait(4);
    emit("$pageleave");
    return { events, completed: false, exitStep: step, createdAccount };
  };
  const chance = (p: number) => rng() < p;
  const live = (trap: TrapId) => traps.has(trap);
  const mobile = v.device === "Mobile";

  // --- Landing and browsing (real users wander; agents head for the shirt)
  const product: Product = swarm ? PRODUCTS[0] : pick(rng, PRODUCTS);
  const entry = swarm ? "home" : weighted(rng, [["home", 45], ["shop", 20], ["product", 35]] as const);
  if (entry === "home") {
    view("/", "Home");
    wait(9);
    if (!swarm && chance(0.22)) return leave("Home");
    if (swarm || chance(0.7)) {
      click(ELEMENTS.shopNow, "Shop Now");
      view("/shop", "Browse");
      wait(14);
    }
  } else if (entry === "shop") {
    view("/shop", "Browse");
    wait(14);
  }
  if (entry !== "product" && path === "/shop" && chance(swarm ? 0.3 : 0.35)) {
    // Filter by color (T6: nothing happens until "Apply Filter", below the fold
    // on desktop and at the bottom of the drawer on mobile)
    const color = swarm ? "Blue" : pick(rng, COLORS);
    click(ELEMENTS.colorSwatch(color));
    if (live("T6")) {
      wait(4);
      if (chance(0.5)) rage(ELEMENTS.colorSwatch(color));
      if (chance(profile.failFilter)) return leave("Browse", "filter");
      wait(10);
      click(ELEMENTS.applyFilter, "Apply Filter");
    }
    view(`/shop?color=${color}`, "Browse");
    wait(8);
  }
  if (entry !== "product") {
    if (!swarm && chance(0.3)) return leave(path === "/" ? "Home" : "Browse");
    click(ELEMENTS.productCard(product), product.name);
  }
  view(productPath(product), "Product");
  track("product_viewed", { product_id: product.id, product_name: product.name, price: product.price });
  wait(25);

  // Browsers who never meant to buy
  if (!swarm && chance(mobile ? 0.5 : 0.42)) return leave("Product");

  // --- Size (T4: hover-only picker)
  const sizeFails = chance(live("T4") ? profile.failSize : profile.base.failSize);
  if (sizeFails) {
    if (live("T4")) rage(ELEMENTS.sizePill, "Size");
    for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) {
      click(ELEMENTS.addToCart, "Add to Cart");
      track("add_to_cart_clicked", { product_id: product.id, has_size: false });
      wait(3);
    }
    // Some find the trick (hover on desktop, long-press on mobile) eventually
    if (chance(swarm ? 0.1 : 0.3)) {
      wait(8);
    } else return leave("Product", "size");
  }
  const size = swarm ? "Medium" : pick(rng, SIZES);
  click(ELEMENTS.sizeButton(size), size);
  track("size_selected", { product_id: product.id, size });
  wait(4);
  click(ELEMENTS.addToCart, "Add to Cart");
  track("add_to_cart_clicked", { product_id: product.id, has_size: true });
  const quantity = swarm ? 1 : weighted(rng, [[1, 85], [2, 12], [3, 3]] as const);
  track("product_added", { product_id: product.id, size, color: swarm ? "Blue" : pick(rng, COLORS), quantity, price: product.price });
  const cartValue = product.price * quantity;

  // --- Cart
  if (!swarm && chance(0.18)) return leave("Product");
  wait(3);
  click(ELEMENTS.cartIcon);
  view("/cart", "Cart");
  wait(12);
  if (!swarm && chance(0.24)) return leave("Cart");
  click(ELEMENTS.goToCheckout, "Go to Checkout");
  track("checkout_clicked", { cart_value: cartValue, items: quantity });

  // --- Account wall (T2)
  if (live("T2") && !o.hasAccount) {
    view("/checkout/account", "Account");
    wait(20);
    if (chance(profile.failAccount)) return leave("Account", "account");
    // Password and phone rules trip most people once
    if (chance(0.45)) {
      click(ELEMENTS.createAccount, "Create account", "submit");
      const errors = ["password", ...ACCOUNT_FIELDS.filter((f) => f !== "password" && chance(0.3))];
      track("account_submitted", { success: false, error_fields: errors });
      wait(15);
      if (chance(0.25)) return leave("Account", "account");
    }
    click(ELEMENTS.createAccount, "Create account", "submit");
    track("account_submitted", { success: true, error_fields: [] });
    createdAccount = true;
  }

  // --- Shipping (T5 promo wipe, T1 invisible continue)
  view("/checkout", "Shipping");
  wait(35);
  const appliesPromo = o.promoCodes && (o.swarm?.persona === "typical" || chance(o.referrer?.utm_campaign ? 0.7 : 0.18));
  let promo = false;
  if (appliesPromo) {
    const typo = !swarm && chance(0.1);
    click(ELEMENTS.promoApply, "Apply");
    track("promo_applied", { code: typo ? "WELCOM10" : "WELCOME10", success: !typo });
    promo = !typo;
    // Agents and most people fill the form before reaching the promo box
    if (promo && live("T5") && (swarm || chance(0.6))) {
      // Fields typed before applying are gone; the next submit fails on all of them
      click(ELEMENTS.continueToPayment, "Continue to payment", "submit");
      track("shipping_submitted", { success: false, error_fields: SHIPPING_FIELDS, promo_applied: true });
      wait(6);
      if (chance(profile.wipeQuit)) return leave("Shipping", "wipe");
      wait(30);
    }
  }
  const cantContinue = chance(live("T1") ? profile.failContinue : profile.base.failContinue);
  if (cantContinue) {
    if (live("T1")) {
      // They look for a button where it should be, around the card footer
      click(ELEMENTS.shippingTitle, "Contact & Shipping");
      rage(ELEMENTS.shippingFooter);
      wait(25);
    }
    if (chance(swarm ? 0.05 : 0.15)) wait(20);
    else return leave("Shipping", live("T1") ? "continue" : undefined);
  }
  if (chance(0.12)) {
    click(ELEMENTS.continueToPayment, "Continue to payment", "submit");
    track("shipping_submitted", { success: false, error_fields: [pick(rng, SHIPPING_FIELDS)], promo_applied: promo });
    wait(8);
  }
  click(ELEMENTS.continueToPayment, "Continue to payment", "submit");
  track("shipping_submitted", { success: true, error_fields: [], promo_applied: promo });

  // --- Payment (T3 delivery fee surprise)
  view("/checkout?step=payment", "Payment");
  const total = Math.round(cartValue * (promo ? 0.9 : 1)) + DELIVERY_FEE;
  wait(live("T3") ? 7 : 20);
  if (chance(live("T3") ? profile.feeShock : profile.base.feeShock)) return leave("Payment", live("T3") ? "fee" : undefined);
  wait(25);
  for (let attempt = 0; ; attempt++) {
    click(ELEMENTS.pay, "Pay now", "submit");
    const fails = !swarm && chance(0.05);
    const failure = fails ? pick(rng, FAILURES) : undefined;
    track("payment_submitted", { success: !fails, ...(failure && { failure_code: failure }), delivery_fee: DELIVERY_FEE, total });
    t += 1800;
    if (!fails) break;
    view("/checkout/failed", "Payment failed");
    wait(10);
    if (attempt > 0 || chance(0.4)) return leave("Payment failed");
    click(ELEMENTS.tryAgain, "Try Again");
    view("/checkout?step=payment", "Payment");
    wait(20);
  }
  const orderId = `SC-${hex(rng, 8).toUpperCase()}`;
  track("order_completed", { order_id: orderId, total, delivery_fee: DELIVERY_FEE, items: quantity });
  view("/checkout/success", "Confirmation");
  narrate("swarm_done", { actions });
  wait(10);
  emit("$pageleave");
  return { events, completed: true, exitStep: "Confirmation", createdAccount };
}

export const visitorSegment = (v: Visitor): SegmentId =>
  segmentOf({ $session_id: "", $device_type: v.device, font_scale: v.fontScale, prefers_contrast: v.prefersContrast });
