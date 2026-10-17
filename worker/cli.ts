// Run one persona agent locally against a store and write a run folder.
//
//   npm run agent -- --persona typical --seed 1 [--url https://...] [--run <runId>] [--headed]
//
// The agent is Claude Code headless (`claude -p`, logged-in account or CLAUDE_CODE_OAUTH_TOKEN)
// whose only tools come from worker/mcp-server.ts. Its tracks go to the store's PostHog (the
// store must have tracking on, e.g. a deploy preview of FrissA/demo-ecommerce#7); locally it
// leaves agents/<agentId>.json and the live-grid screenshot. Several invocations with the same
// --run add agents to the same run folder.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FLOWS, PERSONAS, type RunConfig, type SwarmAgentResult } from "../shared";
import { resultFile } from "./trace";
import { systemPrompt, type ToolName } from "./session";

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
const repo = resolve(import.meta.dirname, "..");

async function readBuildSha(url: string): Promise<string> {
  try {
    const html = await (await fetch(url)).text();
    return html.match(/<meta[^>]+name="build-sha"[^>]+content="([^"]*)"/)?.[1] || "unknown";
  } catch {
    return "unknown";
  }
}

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

const TOOLS: ToolName[] = ["look", "click", "type", "scroll", "back", "think_aloud", "give_up", "done"];

/** Claude Code with nothing but our MCP tools: no built-in tools, settings, skills or other servers. */
function claudeArgs() {
  const mcp = {
    mcpServers: {
      shop: {
        command: join(repo, "node_modules", ".bin", "tsx"),
        args: [
          join(repo, "worker", "mcp-server.ts"),
          "--persona", persona.id, "--seed", String(seed), "--flow", flow.id,
          "--run", runId, "--run-dir", runDir, "--url", targetUrl,
          ...(args.headed ? ["--headed"] : []),
        ],
      },
    },
  };
  return [
    "-p", "Start shopping. Call look first.",
    "--system-prompt", systemPrompt(persona, flow, seed),
    "--model", args.model!,
    "--mcp-config", JSON.stringify(mcp),
    "--strict-mcp-config",
    "--tools", "",
    "--allowedTools", TOOLS.map((t) => `mcp__shop__${t}`).join(","),
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
  ];
}

/** Print each tool call as Claude Code streams it. */
function printProgress(line: string) {
  let msg: { type?: string; message?: { content?: { type: string; name?: string; input?: unknown }[] }; result?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "assistant")
    for (const b of msg.message?.content ?? [])
      if (b.type === "tool_use") console.log(`  → ${b.name?.replace("mcp__shop__", "")} ${JSON.stringify(b.input)}`);
  if (msg.type === "result" && msg.result) console.log(`  claude: ${msg.result.trim().slice(0, 200)}`);
}

function readResult(): SwarmAgentResult | undefined {
  const file = resultFile(runDir, agentId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

const buildSha = await readBuildSha(targetUrl);
writeConfig(buildSha);
rmSync(resultFile(runDir, agentId), { force: true });
console.log(`run ${runId} · ${agentId} · ${targetUrl} · build ${buildSha} · claude ${args.model}`);

const child = spawn("claude", claudeArgs(), { cwd: runDir, stdio: ["ignore", "pipe", "inherit"] });
createInterface({ input: child.stdout }).on("line", printProgress);
const timer = setTimeout(() => child.kill("SIGTERM"), Number(args["timeout-min"]) * 60_000);
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
const code: number | null = await new Promise((done) => child.on("close", done));
clearTimeout(timer);
process.off("SIGINT", stop);

// The MCP server (Claude Code's child) writes the agent's result when it stops, which can land
// just after claude exits. Give it a moment before recording an ending ourselves.
let result = readResult();
for (let waited = 0; !result && waited < 10_000; waited += 250) {
  await new Promise((r) => setTimeout(r, 250));
  result = readResult();
}
if (!result) {
  // The MCP server died before it could record an ending (nothing reached PostHog for it).
  const now = new Date().toISOString();
  result = { runId, agentId, personaId: persona.id, seed, outcome: "give_up", actions: 0, reason: "Stopped without finishing.", startedAt: now, endedAt: now };
  writeFileSync(resultFile(runDir, agentId), JSON.stringify(result, null, 2) + "\n");
}

console.log("");
const where = [result.step, result.reason].filter(Boolean).join(" · ");
console.log(`${result.outcome} · ${result.actions} actions${where ? ` · ${where}` : ""} · claude exit ${code} → ${resultFile(runDir, agentId)}`);
process.exitCode = result.outcome === "error" ? 1 : 0;
