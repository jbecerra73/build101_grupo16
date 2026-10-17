// Run one persona agent locally against a store and write a run folder.
//
//   npm run agent -- --persona typical --seed 1 [--url https://...] [--run <runId>] [--headed]
//
// The agent is Claude Code headless (`claude -p`, logged-in account or CLAUDE_CODE_OAUTH_TOKEN)
// whose only tools come from worker/mcp-server.ts. Its tracks go to the store's PostHog (the
// store must have tracking on, e.g. a deploy preview of FrissA/demo-ecommerce#7); locally it
// leaves agents/<agentId>.json and the live-grid screenshot. Several invocations with the same
// --run add agents to the same run folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FLOWS, PERSONAS, type RunConfig } from "../shared";
import { readBuildSha, runClaudeAgent } from "./claude";
import { resultFile } from "./trace";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values: args } = parseArgs({
  options: {
    persona: { type: "string", default: "typical" },
    seed: { type: "string", default: "1" },
    flow: { type: "string", default: "buy-tshirt" },
    url: { type: "string" },
    run: { type: "string" },
    runs: { type: "string", default: "runs" },
    model: { type: "string", default: process.env.AGENT_MODEL ?? "haiku" },
    "timeout-min": { type: "string", default: "10" },
    headed: { type: "boolean", default: false },
  },
});

const persona = PERSONAS[args.persona!];
const flow = FLOWS[args.flow!];
if (!persona) throw new Error(`Unknown persona ${args.persona}; known: ${Object.keys(PERSONAS).join(", ")}`);
if (!flow) throw new Error(`Unknown flow ${args.flow}; known: ${Object.keys(FLOWS).join(", ")}`);
const seed = Number(args.seed);
const targetUrl = args.url ?? flow.startUrl;
const runId = args.run ?? `run-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
const runDir = resolve(args.runs!, runId);
const agentId = `${persona.id}-${seed}`;

function writeConfig(buildSha: string) {
  mkdirSync(runDir, { recursive: true });
  const file = join(runDir, "config.json");
  const config: RunConfig = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { runId, kind: "retest", flowId: flow.id, posthog: { source: "api", buildSha }, personaIds: [], seeds: {}, targetUrl, createdAt: new Date().toISOString() };
  if (!config.personaIds.includes(persona.id)) config.personaIds.push(persona.id);
  config.seeds[persona.id] = [...new Set([...(config.seeds[persona.id] ?? []), seed])].sort((a, b) => a - b);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

const buildSha = await readBuildSha(targetUrl);
writeConfig(buildSha);
console.log(`run ${runId} · ${agentId} · ${targetUrl} · build ${buildSha} · claude ${args.model}`);

const abort = new AbortController();
const stop = () => abort.abort();
process.on("SIGINT", stop);
const { result, code } = await runClaudeAgent({
  persona,
  flow,
  seed,
  runId,
  runDir,
  targetUrl,
  model: args.model!,
  timeoutMs: Number(args["timeout-min"]) * 60_000,
  headed: args.headed,
  signal: abort.signal,
});
process.off("SIGINT", stop);

console.log("");
const where = [result.step, result.reason].filter(Boolean).join(" · ");
console.log(`${result.outcome} · ${result.actions} actions${where ? ` · ${where}` : ""} · claude exit ${code} → ${resultFile(runDir, agentId)}`);
process.exitCode = result.outcome === "error" ? 1 : 0;
