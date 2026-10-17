import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunStore } from "@frictionswarm/store";

/**
 * Copies run folders from the local disk (where the pipeline, analyzer and
 * fix loop write) to the run store, incrementally: a file is uploaded when its
 * size or mtime changed since the last sync. Event logs are uploaded whole
 * (one blob per agent, rewritten; see packages/store/src/types.ts), cut at the
 * last complete line so readers never see a partial JSON line.
 */
export class RunMirror {
  #seen = new Map<string, string>();
  #busy = new Map<string, Promise<number>>();

  constructor(
    readonly store: RunStore,
    readonly localRunsDir: string,
  ) {}

  /** Syncs runs/<runId>/ and returns how many files were uploaded. Concurrent
   * calls for the same run share one sync. */
  sync(runId: string): Promise<number> {
    const running = this.#busy.get(runId);
    if (running) return running.then(() => this.sync(runId));
    const p = this.#sync(runId).finally(() => this.#busy.delete(runId));
    this.#busy.set(runId, p);
    return p;
  }

  async #sync(runId: string): Promise<number> {
    const root = join(this.localRunsDir, runId);
    let uploaded = 0;
    for (const rel of await walk(root)) {
      const full = join(root, rel);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue; // removed while we were walking
      }
      const sig = `${st.size}:${st.mtimeMs}`;
      const key = `runs/${runId}/${rel}`;
      if (this.#seen.get(key) === sig) continue;
      let data: Buffer;
      try {
        data = await readFile(full);
      } catch {
        continue;
      }
      if (rel.endsWith(".jsonl")) {
        const end = data.lastIndexOf(0x0a);
        if (end < 0) continue; // no complete line yet
        await this.store.putBytes(key, new Uint8Array(data.subarray(0, end + 1)));
        // Only remember the signature once the whole file was uploaded.
        if (end === data.length - 1) this.#seen.set(key, sig);
      } else {
        await this.store.putBytes(key, new Uint8Array(data));
        this.#seen.set(key, sig);
      }
      uploaded++;
    }
    return uploaded;
  }
}

/** Relative paths of the files under `root` (POSIX separators), skipping temp files. */
async function walk(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.endsWith(".tmp") || e.name === ".DS_Store") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
