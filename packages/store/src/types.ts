/**
 * Where the orchestrator and the dashboard meet. Keys are "/"-separated paths
 * relative to the store root, as laid out in apps/dashboard/lib/control-types.ts:
 *
 *   runs/<runId>/...                     a run folder (shared/contracts.ts)
 *   runs/<runId>/events/<agentId>.jsonl  one event log per agent (see below)
 *   queue/<requestId>.json, settings.json, orchestrator.json, usage.json
 *
 * Event logs: Netlify Blobs has no append, so each agent's JSONL is one blob
 * that is rewritten whole by its single writer (the orchestrator's mirror, at
 * most once per mirror tick, ~1 s). At 30 agents x 25 actions that is <= 30
 * small PUTs per tick while a swarm runs, and a reader needs 1 list + one GET
 * per agent whose etag changed (BlobsStore caches the rest). Chunked logs
 * (events/<agentId>/<seq>.jsonl) would make every poll read hundreds of blobs.
 */
export interface RunStore {
  readonly kind: "fs" | "blobs" | "memory";
  getText(key: string): Promise<string | undefined>;
  /** undefined when missing or not valid JSON (e.g. half-written). */
  getJson<T>(key: string): Promise<T | undefined>;
  getBytes(key: string): Promise<Uint8Array | undefined>;
  putText(key: string, text: string): Promise<void>;
  putJson(key: string, data: unknown): Promise<void>;
  putBytes(key: string, data: Uint8Array): Promise<void>;
  /** Every key under `prefix` (recursively), sorted. `prefix` is a folder: "runs/<id>/events/". */
  list(prefix: string): Promise<string[]>;
  /** Names of the immediate sub-folders of `prefix` ("runs/" -> run ids), sorted. */
  listDirs(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  /** Appends to a text blob. Blobs: read-modify-write, safe only with one
   * writer per key (true for event logs: one agent, one orchestrator). */
  appendText(key: string, text: string): Promise<void>;
  /** A JSON value plus an opaque version of it, for putJsonIf. */
  getJsonVersioned<T>(key: string): Promise<Versioned<T>>;
  /** Compare-and-set: writes only while the key still has `version` (undefined:
   * only while the key is missing). false when someone else wrote first. Atomic
   * on Blobs and in memory; the fs store only has one machine to race with. */
  putJsonIf(key: string, data: unknown, version: string | undefined): Promise<boolean>;
}

export type Versioned<T> = { value?: T; version?: string };

/** Rejects keys that could escape the store root or confuse Blobs. */
export function assertKey(key: string): void {
  if (
    !key ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw new Error(`Invalid store key "${key}"`);
}

/** Normalises a folder prefix to "a/b/" ("" stays ""). */
export function folder(prefix: string): string {
  if (!prefix) return "";
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  assertKey(p.slice(0, -1));
  return p;
}

export const jsonText = (data: unknown) => JSON.stringify(data, null, 2) + "\n";

export const toBytes = (text: string) => new TextEncoder().encode(text);
export const fromBytes = (b: Uint8Array) => new TextDecoder().decode(b);

export function parseJson<T>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
