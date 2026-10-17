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
 */
export class FixtureFallbackStore implements RunStore {
  readonly kind: RunStore["kind"];
  constructor(
    readonly primary: RunStore,
    readonly fallback: RunStore,
  ) {
    this.kind = primary.kind;
  }

  async getText(key: string) {
    const v = await this.primary.getText(key);
    return v !== undefined || !isFixtureKey(key) ? v : this.fallback.getText(key).catch(() => undefined);
  }
  async getJson<T>(key: string) {
    const v = await this.primary.getJson<T>(key);
    return v !== undefined || !isFixtureKey(key) ? v : this.fallback.getJson<T>(key).catch(() => undefined);
  }
  async getBytes(key: string) {
    const v = await this.primary.getBytes(key);
    return v !== undefined || !isFixtureKey(key) ? v : this.fallback.getBytes(key).catch(() => undefined);
  }
  putText(key: string, text: string) {
    return this.primary.putText(key, text);
  }
  putJson(key: string, data: unknown) {
    return this.primary.putJson(key, data);
  }
  putBytes(key: string, data: Uint8Array) {
    return this.primary.putBytes(key, data);
  }
  delete(key: string) {
    return this.primary.delete(key);
  }
  appendText(key: string, text: string) {
    return this.primary.appendText(key, text);
  }

  async list(prefix: string) {
    const p = folder(prefix);
    const [a, b] = await Promise.all([this.primary.list(p), this.#fallbackList(p)]);
    return [...new Set([...a, ...b])].sort();
  }
  async listDirs(prefix: string) {
    const p = folder(prefix);
    const [a, b] = await Promise.all([this.primary.listDirs(p), this.fallback.listDirs(p).catch(() => [] as string[])]);
    // Only fixture folders come from the fallback.
    const extra = b.filter((d) => isFixtureKey(`${p}${d}/`));
    return [...new Set([...a, ...extra])].sort();
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
