// Flows in the run store: custom flows live under KEYS.flows and overlay the
// seed flows from shared/flows.ts by id.
import { createHash } from "node:crypto";
import { FLOWS, PERSONAS, REQUIRED_FIELDS, withFlowDefaults, type EventMatch, type Flow, type PersonaId, type RequiredField } from "@frictionswarm/shared";
import { KEYS } from "./control";
import type { RunStore } from "./types";

export type FlowValidation =
  | { ok: true; flow: Flow }
  | { ok: false; missing: string[]; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isHttpUrl = (v: string) => {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isEventValue = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** An EventMatch ({ event, where? }), or the error describing why it is not one. */
function eventMatch(v: unknown, label: string): EventMatch | string {
  if (!isRecord(v) || !isString(v.event) || !v.event) return `${label} needs an event name`;
  if (v.where === undefined) return { event: v.event };
  if (!isRecord(v.where)) return `${label}.where must be an object`;
  for (const [k, x] of Object.entries(v.where))
    if (!(isEventValue(x) || (Array.isArray(x) && x.length && x.every(isEventValue)))) return `${label}.where.${k} must be a string, number, boolean or a list of them`;
  return { event: v.event, where: v.where as EventMatch["where"] };
}

const TOP_LEVEL = ["id", "goal", "startUrl", "success", "steps", "required"] as const;

export function validateFlow(input: unknown): FlowValidation {
  const raw = isRecord(input) ? input : {};
  const missing = TOP_LEVEL.filter((k) => raw[k] === undefined || raw[k] === null || raw[k] === "");
  if (missing.length) return { ok: false, missing, errors: [] };

  const errors: string[] = [];
  if (!isString(raw.id) || !SLUG.test(raw.id)) {
    errors.push("id must be a lowercase slug (a-z, 0-9, -)");
  }
  if (!isString(raw.goal)) errors.push("goal must be a string");
  if (!isString(raw.startUrl) || !isHttpUrl(raw.startUrl)) errors.push("startUrl must be an http(s) URL");

  const success = isRecord(raw.success) ? raw.success : {};
  if (!isRecord(raw.success)) errors.push("success must be an object");
  else if (!success.urlPattern && !success.visibleText) errors.push("success needs urlPattern or visibleText");

  const steps: { route: string; name: string }[] = [];
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) errors.push("steps must be a non-empty list");
  else {
    for (const s of raw.steps) {
      if (isRecord(s) && isString(s.route) && s.route && isString(s.name) && s.name) {
        steps.push({ route: s.route, name: s.name });
      } else errors.push("each step needs a route and a name");
    }
    if (new Set(steps.map((s) => s.name)).size !== steps.length) errors.push("step names must be unique");
    if (new Set(steps.map((s) => s.route)).size !== steps.length) errors.push("step routes must be unique");
  }

  const req = isRecord(raw.required) ? raw.required : {};
  if (!isRecord(raw.required)) errors.push("required must be an object");
  const reqSteps = Array.isArray(req.steps) ? req.steps : [];
  const reqFields = Array.isArray(req.fields) ? req.fields : [];
  if (isRecord(raw.required) && (!Array.isArray(req.steps) || !Array.isArray(req.fields))) {
    errors.push("required needs steps and fields lists");
  }
  const names = new Set(steps.map((s) => s.name));
  for (const n of reqSteps) if (!names.has(n as string)) errors.push(`required step "${String(n)}" is not in steps`);
  for (const f of reqFields) {
    if (!(REQUIRED_FIELDS as readonly unknown[]).includes(f)) errors.push(`unknown required field "${String(f)}"`);
  }

  // Optional (main's Flow fields): completion events, the real-user attempt filter, the swarm's
  // done instruction and the flow's personas. Defaults: no extra events, every session, a doneWhen
  // from the success rule, every segment's persona.
  const completion: EventMatch[] = [];
  if (raw.completion !== undefined && raw.completion !== null) {
    if (!Array.isArray(raw.completion)) errors.push("completion must be a list of { event, where? }");
    else
      raw.completion.forEach((c, i) => {
        const m = eventMatch(c, `completion[${i}]`);
        if (isString(m)) errors.push(m);
        else completion.push(m);
      });
  }
  let attempt: EventMatch | undefined;
  if (raw.attempt !== undefined && raw.attempt !== null) {
    const m = eventMatch(raw.attempt, "attempt");
    if (isString(m)) errors.push(m);
    else attempt = m;
  }
  if (raw.doneWhen !== undefined && raw.doneWhen !== null && (!isString(raw.doneWhen) || !raw.doneWhen.trim())) errors.push("doneWhen must be a non-empty string");
  let personas: PersonaId[] | undefined;
  if (raw.personas !== undefined && raw.personas !== null) {
    if (!Array.isArray(raw.personas) || !raw.personas.length) errors.push("personas must be a non-empty list");
    else {
      for (const p of raw.personas) if (!isString(p) || !Object.hasOwn(PERSONAS, p)) errors.push(`unknown persona "${String(p)}"`);
      personas = raw.personas as PersonaId[];
    }
  }

  if (errors.length) return { ok: false, missing: [], errors };
  return {
    ok: true,
    flow: withFlowDefaults({
      id: raw.id as string,
      goal: raw.goal as string,
      startUrl: raw.startUrl as string,
      success: {
        ...(success.urlPattern ? { urlPattern: String(success.urlPattern) } : {}),
        ...(success.visibleText ? { visibleText: String(success.visibleText) } : {}),
      },
      steps,
      required: { steps: reqSteps as string[], fields: reqFields as RequiredField[] },
      completion,
      ...(attempt ? { attempt } : {}),
      ...(isString(raw.doneWhen) && raw.doneWhen.trim() ? { doneWhen: raw.doneWhen.trim() } : {}),
      ...(personas ? { personas } : {}),
    }),
  };
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : isRecord(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;

/** sha256 hex of the flow's canonical JSON (keys sorted recursively). */
export const flowHash = (flow: Flow): string =>
  createHash("sha256").update(JSON.stringify(canonical(flow))).digest("hex");

/** Human-readable lines describing what changed from `before` to `after`. */
export function diffFlows(before: Flow | undefined, after: Flow): string[] {
  const lines: string[] = [];
  const q = (v: string | undefined) => (v === undefined ? "(none)" : JSON.stringify(v));
  const scalar = (label: string, a: string | undefined, b: string | undefined) => {
    if (a !== b) lines.push(`${label}: ${q(a)} → ${q(b)}`);
  };
  scalar("goal", before?.goal, after.goal);
  scalar("startUrl", before?.startUrl, after.startUrl);
  scalar("success.urlPattern", before?.success.urlPattern, after.success.urlPattern);
  scalar("success.visibleText", before?.success.visibleText, after.success.visibleText);
  scalar("doneWhen", before?.doneWhen, after.doneWhen);
  const json = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));
  scalar("attempt", json(before?.attempt), json(after.attempt));

  const key = (s: { route: string; name: string }) => `${s.route} → ${s.name}`;
  const was = new Set((before?.steps ?? []).map(key));
  const now = new Set(after.steps.map(key));
  for (const s of after.steps) if (!was.has(key(s))) lines.push(`steps: + ${key(s)}`);
  for (const s of before?.steps ?? []) if (!now.has(key(s))) lines.push(`steps: - ${key(s)}`);
  // Steps are in funnel order, so a move matters even when nothing was added or removed.
  const kept = (before?.steps ?? []).map(key).filter((k) => now.has(k));
  if (kept.join("\n") !== after.steps.map(key).filter((k) => was.has(k)).join("\n")) lines.push("steps: reordered");

  const list = (label: string, a: string[], b: string[]) => {
    for (const x of b) if (!a.includes(x)) lines.push(`${label}: + ${x}`);
    for (const x of a) if (!b.includes(x)) lines.push(`${label}: - ${x}`);
  };
  list("required.steps", before?.required.steps ?? [], after.required.steps);
  list("required.fields", before?.required.fields ?? [], after.required.fields);
  list("completion", (before?.completion ?? []).map((c) => JSON.stringify(c)), (after.completion ?? []).map((c) => JSON.stringify(c)));
  list("personas", before?.personas ?? [], after.personas ?? []);
  return lines;
}

export async function listFlows(store: RunStore): Promise<Flow[]> {
  const byId = new Map<string, Flow>(Object.entries(FLOWS));
  for (const key of await store.list(KEYS.flows)) {
    if (!key.endsWith(".json")) continue;
    const flow = await store.getJson<Flow>(key);
    if (flow && isString(flow.id)) byId.set(flow.id, withFlowDefaults(flow));
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function getFlow(store: RunStore, id: string): Promise<Flow | undefined> {
  if (!SLUG.test(id)) return undefined;
  const stored = await store.getJson<Flow>(KEYS.flow(id));
  return stored ? withFlowDefaults(stored) : Object.hasOwn(FLOWS, id) ? FLOWS[id] : undefined;
}

export async function putFlow(store: RunStore, flow: Flow): Promise<void> {
  if (!SLUG.test(flow.id)) throw new Error(`Invalid flow id "${flow.id}"`);
  await store.putJson(KEYS.flow(flow.id), flow);
}
