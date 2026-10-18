import { BlobsStore } from "./blobs";
import { FsStore } from "./fs";
import type { RunStore } from "./types";

export { BlobsStore, BLOBS_STORE_NAME, type BlobsClient, type BlobsStoreOptions } from "./blobs";
export { CONTROL_DIR, FsStore } from "./fs";
export { MemoryStore } from "./memory";
export { FixtureFallbackStore, isFixtureKey } from "./layered";
export { assertKey, folder, fromBytes, parseJson, toBytes, type RunStore } from "./types";
export * from "./control";

type Env = Record<string, string | undefined>;

/** True inside a Netlify build or function (NETLIFY is set in builds, the
 * others at function runtime). */
export const onNetlify = (env: Env = process.env) =>
  env.NETLIFY === "true" ||
  !!env.NETLIFY_BLOBS_CONTEXT ||
  !!env.AWS_LAMBDA_FUNCTION_NAME ||
  !!env.NETLIFY_LOCAL ||
  (!!env.SITE_ID && !!env.DEPLOY_ID);

/** RUN_STORE=fs|blobs; default blobs on Netlify, fs elsewhere. */
export function storeKind(env: Env = process.env): "fs" | "blobs" {
  const k = env.RUN_STORE;
  if (k === "fs" || k === "blobs") return k;
  if (k) throw new Error(`Unknown RUN_STORE "${k}" (fs|blobs)`);
  return onNetlify(env) ? "blobs" : "fs";
}

/** The run store selected by env. `runsDir` is the FsStore root (RUNS_DIR). */
export function createStore(runsDir: string, env: Env = process.env): RunStore {
  if (storeKind(env) === "fs") return new FsStore(runsDir);
  return new BlobsStore({
    name: env.NETLIFY_BLOBS_STORE || undefined,
    siteID: env.NETLIFY_SITE_ID || undefined,
    token: env.NETLIFY_AUTH_TOKEN || undefined,
  });
}
export * from "./flows";
