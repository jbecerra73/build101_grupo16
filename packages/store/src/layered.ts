import { assertKey, folder, type RunStore } from "./types";

/** Keys under runs/fixture-*: the frozen demo runs committed to the repo. */
export const isFixtureKey = (key: string) => /^runs\/fixture-[^/]+(\/|$)/.test(key);

/**
 * A primary store with a read-only fallback for the committed demo runs
 * (runs/fixture-*). The deployed dashboard reads Netlify Blobs, which starts
 * empty; the fixture folders ship inside the function bundle (next.config.ts
 * traces them in), so this layer shows them without seeding Blobs.
 *
 * Reads try the primary first, then the fallback for fixture keys. Listings are
 * the union. Writes and deletes only touch the primary, so a fixture key
 * written to Blobs simply shadows the bundled copy.
 *
 * A dashboard poll lists runs/ and then reads every run's files. That listing
 * says which fixture folders the primary holds at all, so for a while after it
 * the other fixture keys go straight to the fallback: without that, every poll
 * spends one primary miss per fixture file.
 */
export class FixtureFallbackStore implements RunStore {
  readonly kind: RunStore["kind"];
  /** The primary's runs/ folders as of its last listing. */
  #primaryRuns?: { dirs: Set<string>; at: number };

  constructor(
    readonly primary: RunStore,
    readonly fallback: RunStore,
    /** How long a runs/ listing of the primary is trusted. */
    readonly listingTtlMs = 30_000,
  ) {
    this.kind = primary.kind;
  }

  async getText(key: string) {
    return this.#read(key, (s) => s.getText(key));
  }
  async getJson<T>(key: string) {
    return this.#read(key, (s) => s.getJson<T>(key));
  }
  async getBytes(key: string) {
    return this.#read(key, (s) => s.getBytes(key));
  }
  putText(key: string, text: string) {
    this.#wrote(key);
    return this.primary.putText(key, text);
  }
  putJson(key: string, data: unknown) {
    this.#wrote(key);
    return this.primary.putJson(key, data);
  }
  putBytes(key: string, data: Uint8Array) {
    this.#wrote(key);
    return this.primary.putBytes(key, data);
  }
  delete(key: string) {
    return this.primary.delete(key);
  }
  appendText(key: string, text: string) {
    this.#wrote(key);
    return this.primary.appendText(key, text);
  }
  getJsonVersioned<T>(key: string) {
    return this.primary.getJsonVersioned<T>(key);
  }
  putJsonIf(key: string, data: unknown, version: string | undefined) {
    return this.primary.putJsonIf(key, data, version);
  }

  async list(prefix: string) {
    const p = folder(prefix);
    const [a, b] = await Promise.all([this.primary.list(p), this.#fallbackList(p)]);
    return [...new Set([...a, ...b])].sort();
  }
  async listDirs(prefix: string) {
    const p = folder(prefix);
    const at = Date.now();
    const [a, b] = await Promise.all([this.primary.listDirs(p), this.fallback.listDirs(p).catch(() => [] as string[])]);
    if (p === "runs/") this.#primaryRuns = { dirs: new Set(a), at };
    // Only fixture folders come from the fallback.
    const extra = b.filter((d) => isFixtureKey(`${p}${d}/`));
    return [...new Set([...a, ...extra])].sort();
  }

  async #read<T>(key: string, get: (s: RunStore) => Promise<T | undefined>): Promise<T | undefined> {
    if (!isFixtureKey(key)) return get(this.primary);
    if (this.#primaryLacks(key)) return get(this.fallback).catch(() => undefined);
    const v = await get(this.primary);
    return v !== undefined ? v : get(this.fallback).catch(() => undefined);
  }

  /** True when a recent runs/ listing shows the primary has no folder for this fixture key. */
  #primaryLacks(key: string) {
    const known = this.#primaryRuns;
    return !!known && Date.now() - known.at < this.listingTtlMs && !known.dirs.has(key.split("/")[1]);
  }

  #wrote(key: string) {
    if (isFixtureKey(key)) this.#primaryRuns?.dirs.add(key.split("/")[1]);
  }

  async #fallbackList(p: string): Promise<string[]> {
    if (p === "" || p === "runs/") {
      // Whole-store listings: only the fixture folders' keys.
      const dirs = (await this.fallback.listDirs("runs/").catch(() => [] as string[])).filter((d) => d.startsWith("fixture-"));
      return (await Promise.all(dirs.map((d) => this.fallback.list(`runs/${d}/`).catch(() => [] as string[])))).flat();
    }
    assertKey(p.slice(0, -1));
    return isFixtureKey(p) ? this.fallback.list(p).catch(() => []) : [];
  }
}
