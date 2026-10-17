// Build-time deploy facts, baked in by next.config.ts (`env`), so they hold in
// every bundle (Node functions and the proxy) even where Netlify's runtime env
// does not say "Netlify". No imports: proxy.ts uses this too.
//
// Netlify's `[build.environment]` (netlify.toml) only exists during the build,
// so RUN_STORE / ORCHESTRATOR set there reach the functions through here.
// Runtime env still wins when set (Netlify UI env vars are runtime env).
// Next only inlines literal `process.env.FS_BUILD_*` reads, hence the style.

type Env = Record<string, string | undefined>;

/** True when `next build` ran on Netlify (NETLIFY=true). */
export const builtForNetlify = () => process.env.FS_BUILD_NETLIFY === "1";

/** The password gate fails closed when this is true and DASHBOARD_PASSWORD is
 * unset: on a Netlify build, or with DASHBOARD_REQUIRE_PASSWORD=1 (runtime or build). */
export const passwordRequired = (env: Env = process.env) =>
  env.DASHBOARD_REQUIRE_PASSWORD === "1" || process.env.FS_BUILD_REQUIRE_PASSWORD === "1";

/** RUN_STORE from the runtime env, else its value at build time (blobs on Netlify). */
export const runStoreSetting = (env: Env = process.env) => env.RUN_STORE || process.env.FS_BUILD_RUN_STORE || undefined;

/** ORCHESTRATOR from the runtime env, else its value at build time (queue on Netlify). */
export const orchestratorSetting = (env: Env = process.env) => env.ORCHESTRATOR || process.env.FS_BUILD_ORCHESTRATOR || undefined;
