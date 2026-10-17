// One session = one funnel attempt (real user) or one agent (swarm). Everything
// downstream (metrics, history, signals) works on SessionSummary, a compact,
// pure digest of a session's PostHog events.
import { matchesRoute, resolveStep, segmentOf, type Flow, type PostHogEvent, type SegmentId } from "@frictionswarm/shared";
import { describeElement } from "./elements";

export type MarkKind = "rage_click" | "no_size" | "promo_wipe" | "failed_submit" | "drop_off" | "give_up";

/** Something that happened in a session that may point at friction. `key` is
 * `${kind}|${step}|${detail}` and is the same across sessions, releases and runs. */
export type Mark = {
  key: string;
  kind: MarkKind;
  step: string;
  /** Events behind the mark in this session (e.g. number of $rageclicks). */
  count: number;
  selector?: string;
  label?: string;
  /** Raw $elements_chain (rage clicks). */
  chain?: string;
  /** failed_submit / promo_wipe: the event and its error_fields. */
  event?: string;
  fields?: string[];
  /** drop_off: ms on the exit page; whether another mark at that step explains the exit. */
  dwellMs?: number;
  explained?: boolean;
  /** give_up reason (swarm). */
  reason?: string;
};

export type SessionSummary = {
  id: string;
  distinctId: string;
  segment: SegmentId;
  /** Swarm sessions only. */
  personaId?: string;
  agentId?: string;
  swarmRun?: string;
  buildSha: string;
  start: number;
  end: number;
  /** Funnel steps in $pageview order (repeats of the same step collapsed). */
  steps: string[];
  lastStep?: string;
  /** Reached the success step (flow.success.urlPattern). */
  success: boolean;
  /** Valid completion (see validateCompletion). */
  valid: boolean;
  reasons: string[];
  /** $autocapture events (clicks, submits). */
  actions: number;
  /** $pageviews that resolve to a funnel step. */
  pageviews: number;
  /** First event → first success $pageview, valid completions only. */
  timeToCompleteMs?: number;
  /** Per funnel $pageview: time until the next $pageview (or the session's last event). */
  dwell: { step: string; ms: number; last: boolean }[];
  /** The click that took the session from one step to the next. */
  transitions: { from: string; to: string; chain: string }[];
  marks: Mark[];
  /** swarm_give_up / swarm_think_aloud notes (swarm only). */
  notes: { kind: "give_up" | "think_aloud"; text: string; step?: string }[];
  deliveryFee?: number;
};

export type Validity = { valid: boolean; reasons: string[] };

const tsOf = (e: PostHogEvent) => Date.parse(e.timestamp);

// resolveStep builds URLs and regexes; a store has few distinct URLs, so memoize per flow.
const stepMemo = new WeakMap<Flow, Map<string, string | undefined>>();
const successMemo = new WeakMap<Flow, Map<string, boolean>>();
/** resolveStep, memoized per flow and URL. */
export function stepOf(flow: Flow, url: string): string | undefined {
  let m = stepMemo.get(flow);
  if (!m) stepMemo.set(flow, (m = new Map()));
  if (m.has(url)) return m.get(url);
  const s = resolveStep(flow, url);
  if (m.size < 50_000) m.set(url, s);
  return s;
}
const urlOf = (e: PostHogEvent) => (e.properties.$current_url as string | undefined) ?? (e.properties.$pathname as string | undefined);

/** Group events by $session_id, each session sorted by timestamp (stable). */
export function groupSessions(events: Iterable<PostHogEvent>): Map<string, PostHogEvent[]> {
  const map = new Map<string, PostHogEvent[]>();
  for (const e of events) {
    const id = e.properties.$session_id;
    if (!id) continue;
    const list = map.get(id);
    if (list) list.push(e);
    else map.set(id, [e]);
  }
  for (const [k, evs] of map) map.set(k, sortEvents(evs));
  return map;
}

const sortEvents = (evs: PostHogEvent[]) =>
  evs
    .map((e, i) => ({ e, i, t: tsOf(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);

/** Group a (roughly time-ordered) stream by $session_id without holding it all: a session is
 * flushed once the stream has moved `gapMs` past its last event (PostHog ends sessions after
 * 30 min idle). Unordered input still works; it is just held longer. */
export async function* streamSessions(events: AsyncIterable<PostHogEvent>, gapMs = 2 * 3_600_000): AsyncGenerator<PostHogEvent[]> {
  const open = new Map<string, { evs: PostHogEvent[]; last: number }>();
  let now = -Infinity;
  let seen = 0;
  for await (const e of events) {
    const id = e.properties.$session_id;
    if (!id) continue;
    const t = tsOf(e);
    if (t > now) now = t;
    const s = open.get(id);
    if (s) {
      s.evs.push(e);
      if (t > s.last) s.last = t;
    } else open.set(id, { evs: [e], last: t });
    if (++seen % 5000 === 0)
      for (const [k, v] of open)
        if (v.last < now - gapMs) {
          open.delete(k);
          yield sortEvents(v.evs);
        }
  }
  for (const v of open.values()) yield sortEvents(v.evs);
}

const STEP_EVENTS = { shipping: "shipping_submitted", payment: "payment_submitted", order: "order_completed" } as const;

/** SPEC completion validity: the session reaches the success step AND every required step is in
 * its $pageviews AND shipping_submitted {success:true} AND payment_submitted {success:true}
 * AND order_completed happened. (The confirmation echo is the swarm agent's done() evidence.) */
export function validateCompletion(flow: Flow, events: PostHogEvent[]): Validity {
  const reasons: string[] = [];
  const views = events.filter((e) => e.event === "$pageview" && urlOf(e));
  const success = views.some((e) => isSuccessUrl(flow, urlOf(e)!));
  if (!success) reasons.push("never reached the success step");
  const seen = new Set(views.map((e) => stepOf(flow, urlOf(e)!)).filter(Boolean));
  const missing = flow.required.steps.filter((s) => !seen.has(s));
  if (missing.length) reasons.push(`skipped required step(s): ${missing.join(", ")}`);
  const ok = (name: string) => events.some((e) => e.event === name && e.properties.success === true);
  if (!ok(STEP_EVENTS.shipping)) reasons.push("no successful shipping_submitted");
  if (!ok(STEP_EVENTS.payment)) reasons.push("no successful payment_submitted");
  if (!events.some((e) => e.event === STEP_EVENTS.order)) reasons.push("no order_completed");
  return { valid: reasons.length === 0, reasons };
}

export function isSuccessUrl(flow: Flow, url: string): boolean {
  let m = successMemo.get(flow);
  if (!m) successMemo.set(flow, (m = new Map()));
  const hit = m.get(url);
  if (hit !== undefined) return hit;
  const last = flow.steps.at(-1);
  const ok = flow.success.urlPattern ? matchesRoute(flow.success.urlPattern, url) : !!last && stepOf(flow, url) === last.name;
  if (m.size < 50_000) m.set(url, ok);
  return ok;
}

const SHIPPING_WIPE_MIN_FIELDS = 4;

/** Digest one session's events (sorted by timestamp). Pure. */
export function summarizeSession(flow: Flow, events: PostHogEvent[]): SessionSummary {
  const first = events[0];
  const p = first.properties;
  const { valid, reasons } = validateCompletion(flow, events);
  const start = tsOf(first);
  const end = tsOf(events.at(-1)!);
  const steps: string[] = [];
  const dwell: SessionSummary["dwell"] = [];
  const transitions: SessionSummary["transitions"] = [];
  const marks = new Map<string, Mark>();
  const notes: SessionSummary["notes"] = [];
  let current: string | undefined;
  let lastClick: string | undefined;
  let actions = 0;
  let pageviews = 0;
  let promoOk = false;
  let success = false;
  let timeToCompleteMs: number | undefined;
  let deliveryFee: number | undefined;
  let openView: { step: string; t: number } | undefined;

  const mark = (m: Omit<Mark, "count">, n = 1) => {
    const prev = marks.get(m.key);
    if (prev) prev.count += n;
    else marks.set(m.key, { ...m, count: n });
  };

  for (const e of events) {
    const t = tsOf(e);
    const url = urlOf(e);
    const step = (url && stepOf(flow, url)) || current || "Unknown";
    const props = e.properties as Record<string, unknown>;
    switch (e.event) {
      case "$pageview": {
        const s = url && stepOf(flow, url);
        if (!s) break;
        pageviews++;
        if (openView) dwell.push({ step: openView.step, ms: t - openView.t, last: false });
        openView = { step: s, t };
        if (current && s !== current && lastClick) transitions.push({ from: current, to: s, chain: lastClick });
        if (s !== steps.at(-1)) steps.push(s);
        current = s;
        lastClick = undefined;
        if (url && isSuccessUrl(flow, url) && !success) {
          success = true;
          timeToCompleteMs = t - start;
        }
        break;
      }
      case "$autocapture":
        actions++;
        if (typeof props.$elements_chain === "string") lastClick = props.$elements_chain;
        break;
      case "$rageclick": {
        const chain = typeof props.$elements_chain === "string" ? props.$elements_chain : "";
        const el = describeElement(chain);
        mark({ key: `rage_click|${step}|${el.selector}`, kind: "rage_click", step, selector: el.selector, label: el.label, chain });
        break;
      }
      case "add_to_cart_clicked":
        if (props.has_size === false) mark({ key: `no_size|${step}|add_to_cart_clicked`, kind: "no_size", step, event: e.event });
        break;
      case "promo_applied":
        if (props.success === true) promoOk = true;
        break;
      case "payment_submitted":
      case "order_completed":
        if (typeof props.delivery_fee === "number") deliveryFee = props.delivery_fee;
      // fallthrough: payment_submitted may carry error_fields
      default:
        if (e.event.endsWith("_submitted") && props.success === false) {
          const fields = Array.isArray(props.error_fields) ? (props.error_fields as string[]) : [];
          if (!fields.length) break; // e.g. a declined card: not a form problem
          const wipe = e.event === STEP_EVENTS.shipping && props.promo_applied === true && promoOk && fields.length >= SHIPPING_WIPE_MIN_FIELDS;
          if (wipe) mark({ key: `promo_wipe|${step}|${e.event}`, kind: "promo_wipe", step, event: e.event, fields });
          else mark({ key: `failed_submit|${step}|${e.event}`, kind: "failed_submit", step, event: e.event, fields });
        } else if (e.event === "swarm_give_up") {
          const reason = String(props.reason ?? "").trim();
          const s = (props.step as string | undefined) ?? step;
          if (reason) notes.push({ kind: "give_up", text: reason, step: s });
          mark({ key: `give_up|${s}|`, kind: "give_up", step: s, ...(reason ? { reason } : {}) });
        } else if (e.event === "swarm_think_aloud") {
          const note = String(props.note ?? "").trim();
          if (note) notes.push({ kind: "think_aloud", text: note, step: (props.step as string | undefined) ?? step });
        }
    }
  }
  if (openView) dwell.push({ step: openView.step, ms: end - openView.t, last: true });
  const lastStep = steps.at(-1);
  if (!valid && lastStep) {
    const explained = [...marks.values()].some((m) => m.step === lastStep && (m.kind === "promo_wipe" || m.kind === "failed_submit"));
    mark({ key: `drop_off|${lastStep}|`, kind: "drop_off", step: lastStep, dwellMs: dwell.at(-1)?.ms ?? 0, explained });
  }

  return {
    id: p.$session_id,
    distinctId: first.distinct_id,
    segment: segmentOf(p),
    ...(typeof p.swarm_persona === "string" && { personaId: p.swarm_persona }),
    ...(typeof p.swarm_agent === "string" && { agentId: p.swarm_agent }),
    ...(typeof p.swarm_run === "string" && { swarmRun: p.swarm_run }),
    buildSha: String(p.build_sha ?? "unknown"),
    start,
    end,
    steps,
    ...(lastStep && { lastStep }),
    success,
    valid,
    reasons,
    actions,
    pageviews,
    ...(valid && timeToCompleteMs !== undefined && { timeToCompleteMs }),
    dwell,
    transitions,
    marks: [...marks.values()],
    notes,
    ...(deliveryFee !== undefined && { deliveryFee }),
  };
}

/** Summaries of every session in `events`, ordered by start. */
export function summarizeSessions(flow: Flow, events: Iterable<PostHogEvent>): SessionSummary[] {
  return [...groupSessions(events).values()].map((evs) => summarizeSession(flow, evs)).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
