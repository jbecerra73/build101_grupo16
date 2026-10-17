// The run store the dashboard reads and writes: RUNS_DIR on disk locally,
// Netlify Blobs when deployed (RUN_STORE=fs|blobs, see packages/store).
import "server-only";
import { createStore, type RunStore } from "@frictionswarm/store";
import { runsDir } from "./runs-dir";

const g = globalThis as { __frictionswarmStore?: RunStore };

export function runStore(): RunStore {
  return (g.__frictionswarmStore ??= createStore(runsDir()));
}

/** Tests swap in a MemoryStore. */
export function setRunStore(store: RunStore | undefined) {
  g.__frictionswarmStore = store;
}
