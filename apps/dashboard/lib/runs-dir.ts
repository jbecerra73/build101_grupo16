import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `RUNS_DIR` env, else `<repo-root>/runs` (repo root = nearest ancestor with shared/contracts.ts). */
export function runsDir(): string {
  if (process.env.RUNS_DIR) return resolve(process.env.RUNS_DIR);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(/*turbopackIgnore: true*/ join(dir, "shared", "contracts.ts"))) return join(dir, "runs");
    const up = dirname(dir);
    if (up === dir) return resolve(process.cwd(), "..", "..", "runs");
    dir = up;
  }
}
