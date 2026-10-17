// Swarm worker entry, run by the orchestrator inside a tenki sandbox (one per sandbox):
//
//   tsx worker/swarm-cli.ts --input /home/tenki/runs/<runId>/worker-<n>.json --runs /home/tenki/runs
//
// Runs every agent in the input (up to 6 at a time) and exits when they have all ended. Each
// agent leaves runs/<runId>/screenshots/<agentId>.png (live grid) and agents/<agentId>.json;
// its tracks go to the preview's PostHog. Exit code 0 means every agent recorded an ending.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runSwarmWorker, type SwarmWorkerInput } from "./swarm";

const { values: args } = parseArgs({
  options: {
    input: { type: "string" },
    runs: { type: "string", default: "/home/tenki/runs" },
    model: { type: "string", default: process.env.AGENT_MODEL ?? "haiku" },
    "timeout-min": { type: "string", default: "10" },
    concurrency: { type: "string", default: "6" },
  },
});
if (!args.input) {
  console.error("usage: swarm-cli --input <worker.json> [--runs /home/tenki/runs] [--model haiku] [--timeout-min 10]");
  process.exit(2);
}

const input: SwarmWorkerInput = JSON.parse(readFileSync(args.input, "utf8"));
const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => abort.abort());

const results = await runSwarmWorker(input, {
  runsDir: args.runs!,
  model: args.model!,
  timeoutMs: Number(args["timeout-min"]) * 60_000,
  concurrency: Number(args.concurrency),
  signal: abort.signal,
});
console.log(`worker done: ${results.length}/${input.agents.length} agents ended`);
process.exitCode = results.length === input.agents.length ? 0 : 1;
