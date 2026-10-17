// Run one persona agent locally against a store and write a run folder.
//
//   npm run agent -- --persona typical --seed 1 [--url https://...] [--run <runId>] [--headed]
//
// The agent is Claude Code headless (`claude -p`, logged-in account or CLAUDE_CODE_OAUTH_TOKEN)
// whose only tools come from worker/mcp-server.ts. Several invocations with the same --run add
// agents to the same run folder.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FLOWS, PERSONAS, type Event, type RunConfig } from "../shared";
import { ENDINGS } from "./events";
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
    : { runId, kind: "baseline", flowId: flow.id, personaIds: [], seeds: {}, targetUrl, buildSha, createdAt: new Date().toISOString() };
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

function readEvents(): Event[] {
  const file = join(runDir, "events", `${agentId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const buildSha = await readBuildSha(targetUrl);
writeConfig(buildSha);
console.log(`run ${runId} · ${agentId} · ${targetUrl} · build ${buildSha} · claude ${args.model}`);

const child = spawn("claude", claudeArgs(), { cwd: runDir, stdio: ["ignore", "pipe", "inherit"] });
createInterface({ input: child.stdout }).on("line", printProgress);
const timer = setTimeout(() => child.kill("SIGTERM"), Number(args["timeout-min"]) * 60_000);
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
const code: number | null = await new Promise((done) => child.on("close", done));
clearTimeout(timer);
process.off("SIGINT", stop);

// The MCP server (Claude Code's child) records its own ending when its stdin closes, which can
// land just after claude exits. Give it a moment so the log never gets two endings.
const ended = (es: Event[]) => ENDINGS.has(es.at(-1)?.type ?? "page_view");
let events = readEvents();
for (let waited = 0; !ended(events) && waited < 10_000; waited += 250) {
  await new Promise((r) => setTimeout(r, 250));
  events = readEvents();
}
const last = events.at(-1);
if (last && !ended(events)) {
  // The MCP server died before it could record an ending.
  const end: Event = { ...last, ts: Date.now(), type: "give_up", note: "Stopped without finishing." };
  delete end.action;
  delete end.screenshot;
  appendFileSync(join(runDir, "events", `${agentId}.jsonl`), JSON.stringify(end) + "\n");
  events.push(end);
}

console.log("");
for (const e of events) {
  const what = e.action ? `${e.action.kind} ${e.action.text ?? e.action.selector ?? ""}${e.action.missed ? " (missed)" : ""}` : (e.note ?? "");
  console.log(`  ${e.type.padEnd(11)} ${(e.step ?? "-").padEnd(13)} ${what}`);
}
const outcome = events.at(-1)?.type ?? "no events";
console.log(`${outcome} · ${events.filter((e) => e.type === "action").length} actions · claude exit ${code} → ${runDir}`);
process.exitCode = outcome === "success" || outcome === "give_up" ? 0 : 1;
