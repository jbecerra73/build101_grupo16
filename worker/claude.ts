// One persona agent as a Claude Code headless process (`claude -p`) whose only tools come from
// worker/mcp-server.ts. Shared by the single-agent CLI (cli.ts) and the swarm worker (swarm.ts).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import type { Flow, Persona, SwarmAgentResult } from "../shared";
import { resultFile } from "./trace";
import { systemPrompt, type ToolName } from "./session";

const REPO = resolve(import.meta.dirname, "..");
const TOOLS: ToolName[] = ["look", "click", "type", "scroll", "back", "think_aloud", "give_up", "done"];

export type ClaudeAgentOptions = {
  persona: Persona;
  flow: Flow;
  seed: number;
  runId: string;
  runDir: string;
  /** Store URL; the MCP server adds the swarm tag (see withSwarmTag). */
  targetUrl: string;
  model: string;
  timeoutMs: number;
  headed?: boolean;
  /** Playwright browser server to open a context in, instead of launching a browser per agent. */
  browserWs?: string;
  /** Kills the agent (its ending is then recorded as a give-up). */
  signal?: AbortSignal;
  /** Receives each progress line (tool calls, Claude's last words). */
  log?: (line: string) => void;
  /** Extra environment for `claude` and the MCP server. */
  env?: NodeJS.ProcessEnv;
};

export async function readBuildSha(url: string): Promise<string> {
  try {
    const html = await (await fetch(url)).text();
    return html.match(/<meta[^>]+name="build-sha"[^>]+content="([^"]*)"/)?.[1] || "unknown";
  } catch {
    return "unknown";
  }
}

/** Claude Code with nothing but our MCP tools: no built-in tools, settings, skills or other servers. */
export function claudeArgs(o: ClaudeAgentOptions) {
  const mcp = {
    mcpServers: {
      shop: {
        command: join(REPO, "node_modules", ".bin", "tsx"),
        args: [
          join(REPO, "worker", "mcp-server.ts"),
          "--persona", o.persona.id, "--seed", String(o.seed), "--flow", o.flow.id,
          "--run", o.runId, "--run-dir", o.runDir, "--url", o.targetUrl,
          ...(o.headed ? ["--headed"] : []),
          ...(o.browserWs ? ["--browser-ws", o.browserWs] : []),
        ],
      },
    },
  };
  return [
    "-p", "Start shopping. Call look first.",
    "--system-prompt", systemPrompt(o.persona, o.flow, o.seed),
    "--model", o.model,
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

/** Turns one stream-json line into a progress line (tool calls and the final reply), if any. */
export function progressLine(line: string): string | undefined {
  let msg: { type?: string; message?: { content?: { type: string; name?: string; input?: unknown }[] }; result?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (msg.type === "assistant")
    return (msg.message?.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => `  → ${b.name?.replace("mcp__shop__", "")} ${JSON.stringify(b.input)}`)
      .join("\n") || undefined;
  if (msg.type === "result" && msg.result) return `  claude: ${msg.result.trim().slice(0, 200)}`;
  return undefined;
}

function readResult(runDir: string, agentId: string): SwarmAgentResult | undefined {
  const file = resultFile(runDir, agentId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Runs one agent to its ending and returns how it ended (also in `agents/<agentId>.json`). */
export async function runClaudeAgent(o: ClaudeAgentOptions): Promise<{ result: SwarmAgentResult; code: number | null }> {
  const agentId = `${o.persona.id}-${o.seed}`;
  rmSync(resultFile(o.runDir, agentId), { force: true });
  // claude runs in the run folder; spawn fails with ENOENT when the cwd is missing.
  mkdirSync(o.runDir, { recursive: true });
  const child = spawn("claude", claudeArgs(o), { cwd: o.runDir, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...o.env } });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const p = progressLine(line);
    if (p) (o.log ?? console.log)(p);
  });
  const stop = () => child.kill("SIGTERM");
  const timer = setTimeout(stop, o.timeoutMs);
  o.signal?.addEventListener("abort", stop, { once: true });
  const code: number | null = await new Promise((done) => {
    child.on("close", done);
    child.on("error", (err) => {
      (o.log ?? console.log)(` could not start claude: ${err.message}`);
      done(null);
    });
  });
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", stop);

  // The MCP server (Claude Code's child) writes the agent's result when it stops, which can land
  // just after claude exits. Give it a moment before recording an ending ourselves.
  let result = readResult(o.runDir, agentId);
  for (let waited = 0; !result && waited < 10_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    result = readResult(o.runDir, agentId);
  }
  if (!result) {
    // The MCP server died before it could record an ending (nothing reached PostHog for it).
    const now = new Date().toISOString();
    result = { runId: o.runId, agentId, personaId: o.persona.id, seed: o.seed, outcome: "give_up", actions: 0, reason: "Stopped without finishing.", startedAt: now, endedAt: now };
    mkdirSync(dirname(resultFile(o.runDir, agentId)), { recursive: true });
    writeFileSync(resultFile(o.runDir, agentId), JSON.stringify(result, null, 2) + "\n");
  }
  return { result, code };
}
