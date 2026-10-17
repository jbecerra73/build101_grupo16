// npm run pipeline -- [--flow buy-tshirt] [--from 2026-09-19 --to 2026-10-17] [--source file|api] [--seeds 10] [--auto-fix]
// Runs the whole pipeline in the foreground and prints each phase change.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { PostHogSourceKind } from "@frictionswarm/shared";
import { startPipeline } from "./pipeline";
import { REPO_ROOT } from "./runs";

const envFile = join(REPO_ROOT, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: {
    flow: { type: "string", default: "buy-tshirt" },
    from: { type: "string" },
    to: { type: "string" },
    source: { type: "string" },
    seeds: { type: "string", default: "10" },
    "auto-fix": { type: "boolean", default: false },
  },
});

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const { runId, done } = await startPipeline(
  {
    flowId: values.flow!,
    ...(values.from && values.to ? { window: { from: values.from, to: values.to } } : {}),
    ...(values.source ? { source: values.source as PostHogSourceKind } : {}),
    seedsPerPersona: Number(values.seeds),
    autoFix: values["auto-fix"]!,
  },
  {
    onStatus: (s) => console.log(`${stamp()} ${s.phase.padEnd(15)} ${s.message ?? ""}${s.error ? `\n  error: ${s.error}` : ""}`),
    log: (line) => console.log(`${stamp()}   ${line}`),
  },
);
console.log(`run ${runId}`);
const final = await done;
process.exit(final.phase === "done" ? 0 : 1);
