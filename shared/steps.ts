import type { PostHogEvent } from "./analytics";
import type { EventMatch, Flow } from "./contracts";

const globToRegExp = (glob: string) =>
  new RegExp(
    "^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "/?$",
  );

/** Whether `url` (absolute or path) matches a flow route pattern. */
export function matchesRoute(route: string, url: string): boolean {
  const u = new URL(url, "http://x");
  const [pathPattern, query] = route.split("?");
  if (!globToRegExp(pathPattern).test(u.pathname)) return false;
  if (!query) return true;
  const want = new URLSearchParams(query);
  for (const [k, v] of want) if (u.searchParams.get(k) !== v) return false;
  return true;
}

/** Resolve a URL to the flow's funnel step name; a route with a query wins. */
export function resolveStep(flow: Flow, url: string): string | undefined {
  const matches = flow.steps.filter((s) => matchesRoute(s.route, url));
  return (matches.find((s) => s.route.includes("?")) ?? matches[0])?.name;
}

const urlOf = (e: PostHogEvent) => (e.properties.$current_url as string | undefined) ?? (e.properties.$pathname as string | undefined);

export const matchesEvent = (m: EventMatch, e: PostHogEvent) =>
  e.event === m.event &&
  Object.entries(m.where ?? {}).every(([k, v]) => {
    const actual = (e.properties as Record<string, unknown>)[k];
    return Array.isArray(v) ? v.some((x) => x === actual) : actual === v;
  });

/** "a successful shipping_submitted", "a product_added with product_id=2", "… with product_id=2|8". */
export function describeEvent(m: EventMatch): string {
  const where = Object.entries(m.where ?? {});
  if (where.length === 1 && where[0][0] === "success" && where[0][1] === true) return `a successful ${m.event}`;
  return `a ${m.event}${where.length ? ` with ${where.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`).join(", ")}` : ""}`;
}

/** The events that enter a funnel step, in order: every $pageview on a step, plus the first event
 * on a step reached by changing only the query. posthog-js's `history_change` pageviews fire on
 * pathname changes only, so the storefront's /checkout → /checkout?step=payment sends no $pageview;
 * the payment form's clicks and payment_submitted carry the new URL. `events` in time order. */
export function stepEntries(flow: Flow, events: PostHogEvent[]): { event: PostHogEvent; step: string }[] {
  const out: { event: PostHogEvent; step: string }[] = [];
  let path: string | undefined;
  let current: string | undefined;
  for (const e of events) {
    const url = urlOf(e);
    if (!url) continue;
    if (e.event === "$pageview") {
      path = new URL(url, "http://x").pathname;
      current = resolveStep(flow, url);
      if (current) out.push({ event: e, step: current });
    } else if (e.event !== "$pageleave" && path !== undefined && new URL(url, "http://x").pathname === path) {
      const step = resolveStep(flow, url);
      if (step && step !== current) out.push({ event: e, step: (current = step) });
    }
  }
  return out;
}

/** Whether a real user's session counts towards the flow (Flow.attempt). */
export const attemptsFlow = (flow: Flow, events: PostHogEvent[]) => !flow.attempt || events.some((e) => matchesEvent(flow.attempt!, e));

/** SPEC completion validity, per flow: the session reaches the success step AND every required
 * step was entered (stepEntries) AND every flow.completion event happened. Empty = valid. */
export function completionProblems(flow: Flow, events: PostHogEvent[], isSuccess: (url: string) => boolean): string[] {
  const reasons: string[] = [];
  const views = events.filter((e) => e.event === "$pageview" && urlOf(e));
  if (!views.some((e) => isSuccess(urlOf(e)!))) reasons.push("never reached the success step");
  const seen = new Set(stepEntries(flow, events).map((x) => x.step));
  const missing = flow.required.steps.filter((s) => !seen.has(s));
  if (missing.length) reasons.push(`skipped required step(s): ${missing.join(", ")}`);
  for (const m of flow.completion) if (!events.some((e) => matchesEvent(m, e))) reasons.push(`no ${describeEvent(m).replace(/^a /, "")}`);
  return reasons;
}
