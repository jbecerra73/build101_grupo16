// Tracking plan: what the storefront sends to PostHog, and how the analyzer
// reads it back. The storefront (FrissA/demo-ecommerce, src/lib/analytics.ts)
// mirrors these names; the fake dataset generator (tools/posthog-sim) emits
// exactly these events, so the analyzer can't tell the two apart.
//
// Two populations share one PostHog project:
//   - real users: everything without `swarm_run`
//   - swarm agents: `swarm_run`, `swarm_persona`, `swarm_agent` super properties,
//     set by the storefront from `?swarm=<runId>&agent=<agentId>&persona=<id>`

import type { PersonaId } from "./contracts";

/** PostHog's built-in events we rely on (posthog-js autocapture). */
export type BuiltinEvent = "$pageview" | "$pageleave" | "$autocapture" | "$rageclick";

/** Business events the storefront captures explicitly. */
export type StoreEvent =
  | "product_viewed"
  | "size_selected"
  | "add_to_cart_clicked"
  | "product_added"
  | "checkout_clicked"
  | "account_submitted"
  | "shipping_submitted"
  | "promo_applied"
  | "payment_submitted"
  | "order_completed";

/** Captured by swarm agents through the page's posthog instance, so their
 * reasoning lands next to their clicks. Never sent by real users. */
export type SwarmEvent = "swarm_think_aloud" | "swarm_give_up" | "swarm_done";

export type TrackedEvent = BuiltinEvent | StoreEvent | SwarmEvent;

/** Super properties registered on every event by the storefront. */
export type SuperProperties = {
  /** <meta name="build-sha">; tells production apart from a deploy preview. */
  build_sha: string;
  /** Root font size / 16: > 1 when the browser's default text size is raised. */
  font_scale: number;
  /** `prefers-contrast: more` media query. */
  prefers_contrast: boolean;
  /** Present only for swarm agents. */
  swarm_run?: string;
  swarm_agent?: string;
  swarm_persona?: PersonaId;
};

/** Event-specific properties (beyond PostHog's `$current_url`, `$pathname`,
 * `$session_id`, `$device_type`, `$viewport_width`, ...). */
export type StoreEventProperties = {
  product_viewed: { product_id: number; product_name: string; price: number };
  size_selected: { product_id: number; size: string };
  add_to_cart_clicked: { product_id: number; has_size: boolean };
  product_added: { product_id: number; size: string; color: string; quantity: number; price: number };
  checkout_clicked: { cart_value: number; items: number };
  account_submitted: { success: boolean; error_fields: string[] };
  shipping_submitted: { success: boolean; error_fields: string[]; promo_applied: boolean };
  promo_applied: { code: string; success: boolean };
  payment_submitted: { success: boolean; failure_code?: string; delivery_fee: number; total: number };
  order_completed: { order_id: string; total: number; delivery_fee: number; items: number };
};

export type SwarmEventProperties = {
  swarm_think_aloud: { note: string; step?: string };
  swarm_give_up: { reason: string; step?: string };
  swarm_done: { actions: number };
};

/** One event as PostHog exports it, and as the `/batch` import accepts it. */
export type PostHogEvent = {
  uuid: string;
  event: TrackedEvent | string;
  distinct_id: string;
  /** ISO 8601. */
  timestamp: string;
  properties: Record<string, unknown> & {
    $session_id: string;
    $current_url?: string;
    $pathname?: string;
    $device_type?: "Desktop" | "Mobile" | "Tablet";
    /** Autocapture/rageclick: PostHog's serialized element chain. */
    $elements_chain?: string;
    $el_text?: string;
  } & Partial<SuperProperties>;
};

/** A slice of real-user traffic the analyzer measures as the "before". */
export type SegmentId = "low_vision" | "mobile" | "desktop";

export type Segment = {
  id: SegmentId;
  name: string;
  /** Persona whose swarm stands in for this segment on the re-test. */
  personaId: PersonaId;
  /** HogQL `WHERE` fragment over `events` (real users only). */
  hogql: string;
  match: (p: PostHogEvent["properties"]) => boolean;
};

const lowVision = (p: PostHogEvent["properties"]) =>
  (p.font_scale ?? 1) >= 1.25 || p.prefers_contrast === true;

// Order matters: a mobile user with large text counts as low vision.
export const SEGMENTS: Segment[] = [
  {
    id: "low_vision",
    name: "Large text or high contrast",
    personaId: "rosa",
    hogql: "(properties.font_scale >= 1.25 OR properties.prefers_contrast = true)",
    match: lowVision,
  },
  {
    id: "mobile",
    name: "Mobile",
    personaId: "kai",
    hogql: "properties.$device_type = 'Mobile' AND NOT (properties.font_scale >= 1.25 OR properties.prefers_contrast = true)",
    match: (p) => !lowVision(p) && p.$device_type === "Mobile",
  },
  {
    id: "desktop",
    name: "Desktop (control)",
    personaId: "typical",
    hogql: "properties.$device_type != 'Mobile' AND NOT (properties.font_scale >= 1.25 OR properties.prefers_contrast = true)",
    match: (p) => !lowVision(p) && p.$device_type !== "Mobile",
  },
];

export const segmentOf = (p: PostHogEvent["properties"]): SegmentId =>
  SEGMENTS.find((s) => s.match(p))!.id;

export const isSwarm = (e: PostHogEvent) => typeof e.properties.swarm_run === "string";
