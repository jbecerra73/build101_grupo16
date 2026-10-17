import { getStore } from "@netlify/blobs";
import { assertKey, folder, parseJson, type RunStore } from "./types";

export const BLOBS_STORE_NAME = "frictionswarm";

/** The slice of @netlify/blobs' Store that BlobsStore uses (faked in tests). */
export interface BlobsClient {
  get(key: string, opts: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  getWithMetadata(key: string, opts?: { etag?: string }): Promise<{ data: string | null; etag?: string } | null>;
  set(key: string, data: string | ArrayBuffer): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts: { prefix?: string; directories?: boolean; paginate: true }): AsyncIterable<{
    blobs: { key: string; etag: string }[];
    directories: string[];
  }>;
}

export type BlobsStoreOptions = {
  name?: string;
  /** Needed outside Netlify (the tenki sandbox, scripts): NETLIFY_SITE_ID. */
  siteID?: string;
  /** Needed outside Netlify: a Netlify personal access token (NETLIFY_AUTH_TOKEN). */
  token?: string;
  /** Override for tests / a local BlobsServer. */
  apiURL?: string;
  edgeURL?: string;
  uncachedEdgeURL?: string;
  /** Inject a client instead of calling getStore (tests). */
  client?: BlobsClient;
};

type Cached = { etag?: string; text: string };
const MAX_CACHE = 4000;
/** A listed etag is trusted for this long (a dashboard poll lists, then reads). */
const LIST_TTL_MS = 5000;

/**
 * The run store on Netlify Blobs (one site-wide store, "frictionswarm").
 * Inside Netlify functions getStore() picks up the site context by itself;
 * elsewhere it needs siteID + token. Reads use strong consistency so a poll
 * sees the orchestrator's latest write, not a CDN copy up to 60 s old.
 *
 * Text reads are cached by etag: list() records every key's current etag, and
 * getText() of a key whose etag has not changed since is served from memory.
 * readEvents() lists the events folder first, so a dashboard poll costs one
 * list plus one GET per agent log that actually changed.
 */
export class BlobsStore implements RunStore {
  readonly kind = "blobs" as const;
  #client?: BlobsClient;
  #opts: BlobsStoreOptions;
  #cache = new Map<string, Cached>();
  #listed = new Map<string, { etag: string; at: number }>();
  #locks = new Map<string, Promise<unknown>>();

  constructor(opts: BlobsStoreOptions = {}) {
    this.#opts = opts;
    this.#client = opts.client;
  }

  /** Created lazily: getStore throws when no Netlify context or credentials exist. */
  get client(): BlobsClient {
    if (!this.#client) {
      const { name = BLOBS_STORE_NAME, siteID, token, apiURL, edgeURL, uncachedEdgeURL } = this.#opts;
      // Strong reads go to the uncached edge, so they need its URL; through the
      // API (siteID + token, no edge) every read is fresh anyway.
      const consistency = edgeURL ? (uncachedEdgeURL ? "strong" : "eventual") : siteID && token ? "eventual" : contextConsistency();
      const store =
        siteID && token
          ? getStore({ name, siteID, token, apiURL, edgeURL, uncachedEdgeURL, consistency })
          : getStore({ name, consistency });
      this.#client = store as unknown as BlobsClient;
    }
    return this.#client;
  }

  async getText(key: string) {
    assertKey(key);
    const cached = this.#cache.get(key);
    const listed = this.#listed.get(key);
    if (cached && listed && cached.etag === listed.etag && Date.now() - listed.at < LIST_TTL_MS) return cached.text;
    const res = await this.client.getWithMetadata(key, cached?.etag ? { etag: cached.etag } : undefined);
    if (!res) {
      this.#cache.delete(key);
      this.#listed.delete(key);
      return undefined;
    }
    if (res.data === null && cached) return cached.text; // 304: unchanged
    const text = res.data ?? "";
    this.#remember(key, { etag: res.etag, text });
    return text;
  }
  async getJson<T>(key: string) {
    return parseJson<T>(await this.getText(key));
  }
  async getBytes(key: string) {
    assertKey(key);
    const buf = await this.client.get(key, { type: "arrayBuffer" });
    return buf ? new Uint8Array(buf) : undefined;
  }
  async putText(key: string, text: string) {
    assertKey(key);
    this.#cache.delete(key);
    await this.client.set(key, text);
  }
  putJson(key: string, data: unknown) {
    return this.putText(key, JSON.stringify(data, null, 2) + "\n");
  }
  async putBytes(key: string, data: Uint8Array) {
    assertKey(key);
    this.#cache.delete(key);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.client.set(key, buf);
  }
  async delete(key: string) {
    assertKey(key);
    this.#cache.delete(key);
    this.#listed.delete(key);
    await this.client.delete(key);
  }
  appendText(key: string, text: string) {
    // Serialised per key within this process; the orchestrator is the only writer.
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const current = (await this.getText(key)) ?? "";
      await this.putText(key, current + text);
    });
    this.#locks.set(key, next);
    void next.finally(() => {
      if (this.#locks.get(key) === next) this.#locks.delete(key);
    });
    return next;
  }

  async list(prefix: string) {
    const p = folder(prefix);
    const keys: string[] = [];
    const at = Date.now();
    for await (const page of this.client.list({ prefix: p, paginate: true })) {
      for (const b of page.blobs) {
        keys.push(b.key);
        this.#listed.set(b.key, { etag: b.etag, at });
      }
    }
    return keys.sort();
  }
  async listDirs(prefix: string) {
    const p = folder(prefix);
    const dirs = new Set<string>();
    for await (const page of this.client.list({ prefix: p, directories: true, paginate: true })) {
      for (const d of page.directories) {
        const name = d.slice(p.length).replace(/\/$/, "");
        if (name && !name.includes("/")) dirs.add(name);
      }
    }
    return [...dirs].sort();
  }

  #remember(key: string, c: Cached) {
    if (this.#cache.size >= MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(key, c);
  }
}

/** "strong" when the Netlify function context has an uncached edge URL. */
function contextConsistency(): "strong" | "eventual" {
  const raw = (globalThis as { netlifyBlobsContext?: unknown }).netlifyBlobsContext ?? process.env.NETLIFY_BLOBS_CONTEXT;
  if (typeof raw !== "string" || !raw) return "eventual";
  try {
    const ctx = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { uncachedEdgeURL?: string };
    return ctx.uncachedEdgeURL ? "strong" : "eventual";
  } catch {
    return "eventual";
  }
}
