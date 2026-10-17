// The run store the dashboard reads and writes: RUNS_DIR on disk locally,
// Netlify Blobs when deployed (RUN_STORE=fs|blobs, see packages/store).
// With Blobs, the committed demo runs (runs/fixture-*, bundled into the
// function by next.config.ts) are layered underneath as a read-only fallback.
import "server-only";
import { existsSync } from "node:fs";
import { createStore, FixtureFallbackStore, FsStore, type RunStore } from "@frictionswarm/store";
import { runStoreSetting } from "./deploy";
import { runsDir } from "./runs-dir";

const g = globalThis as { __frictionswarmStore?: RunStore };

export function makeRunStore(env: Record<string, string | undefined> = process.env, dir = runsDir()): RunStore {
  const RUN_STORE = runStoreSetting(env);
  const store = createStore(dir, RUN_STORE ? { ...env, RUN_STORE } : env);
  if (store.kind === "fs" || !existsSync(/*turbopackIgnore: true*/ dir)) return store;
  return new FixtureFallbackStore(store, new FsStore(dir));
}

export function runStore(): RunStore {
  return (g.__frictionswarmStore ??= makeRunStore());
}

/** Tests swap in a MemoryStore. */
export function setRunStore(store: RunStore | undefined) {
  g.__frictionswarmStore = store;
}
