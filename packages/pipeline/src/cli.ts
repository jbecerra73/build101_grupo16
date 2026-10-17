// npm run pipeline -- --flow buy-tshirt --personas rosa,kai,typical --seeds 3 [--auto-fix] [--target <url>]
// Runs the whole pipeline in the foreground and prints each phase change.
import { parseArgs } from "node:util";
import { startPipeline } from "./pipeline";

const { values } = parseArgs({
  options: {
    flow: { type: "string", default: "buy-tshirt" },
    personas: { type: "string", default: "rosa,kai,typical" },
    seeds: { type: "string", default: "3" },
    "auto-fix": { type: "boolean", default: false },
    target: { type: "string" },
  },
});

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const { runId, done } = await startPipeline(
  {
    flowId: values.flow!,
    personaIds: values.personas!.split(",").map((s) => s.trim()).filter(Boolean),
    seedsPerPersona: Number(values.seeds),
    targetUrl: values.target,
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
