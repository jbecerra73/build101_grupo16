// Records what the storefront's posthog-js sends, in the agent's own browser context, so the
// swarm's tracks don't depend on PostHog ingesting them (deploy previews were slow or silent).
// Every capture request (/e/, /i/v0/e/, /batch/, …) is decoded and appended, one PostHogEvent
// per line, to runs/<runId>/events/<agentId>.jsonl; the orchestrator pulls those files into
// the run's posthog.jsonl, which the analyzer and the dashboard read like any snapshot.
//
// The request is then forwarded to PostHog (best effort) or, with SWARM_POSTHOG=mock, answered
// locally without reaching PostHog at all.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { BrowserContext, Request, Route } from "playwright";
import type { PostHogEvent } from "../shared";

export const eventsFile = (runDir: string, agentId: string) => join(runDir, "events", `${agentId}.jsonl`);

const CAPTURE_PATH = /\/(?:e|i\/v0\/e|batch|capture|track)\/?$/;

/** A posthog-js capture request: an ingestion path on a PostHog host (or a proxy, which keeps `ver=`). */
export function isCaptureUrl(url: URL): boolean {
  return CAPTURE_PATH.test(url.pathname) && (url.hostname.includes("posthog") || url.searchParams.has("ver"));
}

/** The JSON a capture request carries: gzip-js, base64 (`data=` form) or plain JSON. */
export function decodeBody(body: Buffer, url: URL): unknown {
  let text: string;
  if (body[0] === 0x1f && body[1] === 0x8b) text = gunzipSync(body).toString("utf8");
  else {
    text = body.toString("utf8");
    if (text.startsWith("data=")) {
      const data = decodeURIComponent(new URLSearchParams(text).get("data") ?? "");
      text = url.searchParams.get("compression") === "base64" || !/^[[{]/.test(data) ? Buffer.from(data, "base64").toString("utf8") : data;
    }
  }
  return JSON.parse(text);
}

type RawElement = Record<string, unknown> & { tag_name?: string; classes?: string[]; $el_text?: string; nth_child?: number; nth_of_type?: number };

const quote = (v: unknown) => `"${String(v).replace(/"/g, '\\"')}"`;

/** posthog-js `$elements` → PostHog's `$elements_chain` (what ingestion would have stored). */
export function elementsChain(elements: RawElement[]): string {
  return elements
    .map((el) => {
      const head = [el.tag_name ?? "", ...(el.classes ?? [])].join(".");
      const attrs: [string, unknown][] = [];
      if (el.$el_text) attrs.push(["text", el.$el_text]);
      if (el.attr__href) attrs.push(["href", el.attr__href]);
      if (el.nth_child !== undefined) attrs.push(["nth-child", el.nth_child]);
      if (el.nth_of_type !== undefined) attrs.push(["nth-of-type", el.nth_of_type]);
      if (el.attr__id) attrs.push(["attr_id", el.attr__id]);
      for (const [k, v] of Object.entries(el)) if (k.startsWith("attr__") && v != null) attrs.push([k, v]);
      return attrs.length ? `${head}:${attrs.map(([k, v]) => `${k}=${quote(v)}`).join("")}` : head;
    })
    .join(";");
}

/** One event as posthog-js sends it → as PostHog exports it. Batched events carry `offset`
 * (ms before the request) instead of `timestamp`. */
export function toPostHogEvent(raw: unknown, sentAt: number): PostHogEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { event?: unknown; uuid?: string; timestamp?: string; offset?: number; distinct_id?: string; properties?: Record<string, unknown> };
  if (typeof r.event !== "string") return undefined;
  const { token: _token, $elements, ...properties } = r.properties ?? {};
  if (Array.isArray($elements) && !properties.$elements_chain) properties.$elements_chain = elementsChain($elements as RawElement[]);
  const ts = r.timestamp ? Date.parse(r.timestamp) : typeof r.offset === "number" ? sentAt - r.offset : sentAt;
  return {
    uuid: r.uuid ?? randomUUID(),
    event: r.event,
    distinct_id: String(properties.distinct_id ?? r.distinct_id ?? ""),
    timestamp: new Date(Number.isNaN(ts) ? sentAt : ts).toISOString(),
    properties: properties as PostHogEvent["properties"],
  };
}

/** The events in one capture request ({batch: […]}, […] or a single event). */
export function eventsInRequest(request: Request, sentAt = Date.now()): PostHogEvent[] {
  const body = request.postDataBuffer();
  if (!body?.length) return [];
  const payload = decodeBody(body, new URL(request.url()));
  const list = Array.isArray(payload) ? payload : (payload as { batch?: unknown[] })?.batch ?? [payload];
  return list.flatMap((raw) => toPostHogEvent(raw, sentAt) ?? []);
}

/** Records every capture request in `context` to events/<agentId>.jsonl. */
export async function recordPostHog(context: BrowserContext, o: { runDir: string; agentId: string; mock?: boolean; log?: (line: string) => void }) {
  const file = eventsFile(o.runDir, o.agentId);
  mkdirSync(join(o.runDir, "events"), { recursive: true });
  const ok = (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
  await context.route(isCaptureUrl, async (route) => {
    try {
      const events = eventsInRequest(route.request());
      if (events.length) appendFileSync(file, events.map((e) => JSON.stringify(e) + "\n").join(""));
    } catch (err) {
      o.log?.(`posthog recorder: could not decode ${route.request().url()}: ${err instanceof Error ? err.message : err}`);
    }
    if (o.mock) return ok(route).catch(() => {});
    // Forward, but never let a slow or failing PostHog hold the page up.
    try {
      await route.fulfill({ response: await route.fetch({ timeout: 10_000 }) });
    } catch {
      await ok(route).catch(() => {});
    }
  });
}
