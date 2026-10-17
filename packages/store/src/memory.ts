import { assertKey, folder, fromBytes, parseJson, toBytes, type RunStore } from "./types";

/** In-process store for tests and throwaway runs. */
export class MemoryStore implements RunStore {
  readonly kind = "memory" as const;
  readonly data = new Map<string, Uint8Array>();

  async getText(key: string) {
    const b = await this.getBytes(key);
    return b && fromBytes(b);
  }
  async getJson<T>(key: string) {
    return parseJson<T>(await this.getText(key));
  }
  async getBytes(key: string) {
    assertKey(key);
    const b = this.data.get(key);
    return b && new Uint8Array(b);
  }
  async putText(key: string, text: string) {
    await this.putBytes(key, toBytes(text));
  }
  async putJson(key: string, data: unknown) {
    await this.putText(key, JSON.stringify(data, null, 2) + "\n");
  }
  async putBytes(key: string, data: Uint8Array) {
    assertKey(key);
    this.data.set(key, new Uint8Array(data));
  }
  async appendText(key: string, text: string) {
    assertKey(key);
    const prev = this.data.get(key) ?? new Uint8Array();
    const add = toBytes(text);
    const next = new Uint8Array(prev.length + add.length);
    next.set(prev);
    next.set(add, prev.length);
    this.data.set(key, next);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(prefix: string) {
    const p = folder(prefix);
    return [...this.data.keys()].filter((k) => k.startsWith(p)).sort();
  }
  async listDirs(prefix: string) {
    const p = folder(prefix);
    const dirs = new Set<string>();
    for (const k of this.data.keys()) {
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length);
      const i = rest.indexOf("/");
      if (i > 0) dirs.add(rest.slice(0, i));
    }
    return [...dirs].sort();
  }
}
