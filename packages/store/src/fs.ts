import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertKey, folder, fromBytes, jsonText, parseJson, toBytes, type RunStore, type Versioned } from "./types";

/** Folder inside the runs dir that holds the non-run keys (queue/, settings.json, ...). */
export const CONTROL_DIR = ".control";

/**
 * The run store on local disk, keeping today's RUNS_DIR layout:
 *   runs/<id>/...   -> <root>/<id>/...
 *   anything else   -> <root>/.control/...   (queue/, settings.json, orchestrator.json, usage.json)
 * Writes are atomic (tmp + rename) so pollers never read half a JSON file.
 */
export class FsStore implements RunStore {
  readonly kind = "fs" as const;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path for a key or folder prefix ("" = the store root is not addressable). */
  path(key: string): string {
    const k = key.endsWith("/") ? key.slice(0, -1) : key;
    assertKey(k);
    if (k === "runs") return this.root;
    if (k.startsWith("runs/")) return join(/*turbopackIgnore: true*/ this.root, k.slice(5));
    return join(/*turbopackIgnore: true*/ this.root, CONTROL_DIR, k);
  }

  async getText(key: string) {
    const b = await this.getBytes(key);
    return b && fromBytes(b);
  }
  async getJson<T>(key: string) {
    return parseJson<T>(await this.getText(key));
  }
  async getBytes(key: string) {
    try {
      // Refuse symlinks that point outside the store root.
      const real = await realpath(/*turbopackIgnore: true*/ this.path(key));
      const rel = relative(await realpath(/*turbopackIgnore: true*/ this.root), real);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
      return new Uint8Array(await readFile(/*turbopackIgnore: true*/ real));
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw e;
    }
  }
  putText(key: string, text: string) {
    return this.putBytes(key, toBytes(text));
  }
  putJson(key: string, data: unknown) {
    return this.putText(key, jsonText(data));
  }
  /** The version is the stored text itself. */
  async getJsonVersioned<T>(key: string): Promise<Versioned<T>> {
    const text = await this.getText(key);
    return { value: parseJson<T>(text), version: text };
  }
  /** Check-then-write: not atomic, but the fs store is local (one machine). */
  async putJsonIf(key: string, data: unknown, version: string | undefined) {
    if ((await this.getText(key)) !== version) return false;
    await this.putText(key, jsonText(data));
    return true;
  }
  async putBytes(key: string, data: Uint8Array) {
    const file = this.path(key);
    await mkdir(/*turbopackIgnore: true*/ dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(/*turbopackIgnore: true*/ tmp, data);
    await rename(/*turbopackIgnore: true*/ tmp, file);
  }
  async appendText(key: string, text: string) {
    const file = this.path(key);
    await mkdir(/*turbopackIgnore: true*/ dirname(file), { recursive: true });
    await appendFile(/*turbopackIgnore: true*/ file, text);
  }
  async delete(key: string) {
    await rm(/*turbopackIgnore: true*/ this.path(key), { force: true });
  }

  async list(prefix: string) {
    const p = folder(prefix);
    if (!p) throw new Error("FsStore.list needs a folder prefix");
    const out: string[] = [];
    const walk = async (dir: string, keyPrefix: string) => {
      let entries;
      try {
        entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
      } catch (e) {
        if (isMissing(e)) return;
        throw e;
      }
      for (const e of entries) {
        if (e.name.endsWith(".tmp") || e.name === ".DS_Store") continue;
        // The runs/ root also holds .control/ and .usage.json: not run folders.
        if (keyPrefix === "runs/" && e.name.startsWith(".")) continue;
        if (e.isDirectory()) await walk(join(/*turbopackIgnore: true*/ dir, e.name), `${keyPrefix}${e.name}/`);
        else if (e.isFile()) out.push(`${keyPrefix}${e.name}`);
      }
    };
    await walk(this.path(p), p);
    return out.sort();
  }

  async listDirs(prefix: string) {
    const p = folder(prefix);
    if (!p) throw new Error("FsStore.listDirs needs a folder prefix");
    try {
      const entries = await readdir(/*turbopackIgnore: true*/ this.path(p), { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !(p === "runs/" && e.name.startsWith(".")))
        .map((e) => e.name)
        .sort();
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
  }
}

const isMissing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
};
