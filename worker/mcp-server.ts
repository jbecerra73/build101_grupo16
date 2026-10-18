// MCP server for one persona agent, launched by Claude Code over stdio (see cli.ts).
// Its tools are the only way the model can touch the shop: every call goes through
// AgentSession, which enforces the persona's limits. The store's PostHog snippet records
// the agent's clicks and page views; AgentSession adds its swarm_* events. posthog-recorder.ts
// copies all of them to runs/<runId>/events/<agentId>.jsonl as they are sent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { z } from "zod";
import { FLOWS, PERSONAS } from "../shared";
import { describe } from "./observe";
import { recordPostHog } from "./posthog-recorder";
import { AgentSession, withSwarmTag, type StepResult, type ToolCall, type ToolName } from "./session";

const { values: args } = parseArgs({
  options: {
    persona: { type: "string" },
    seed: { type: "string" },
    flow: { type: "string", default: "buy-tshirt" },
    run: { type: "string" },
    "run-dir": { type: "string" },
    url: { type: "string" },
    headed: { type: "boolean", default: false },
    /** A Playwright browser server (see swarm.ts): open a context in it instead of a new browser. */
    "browser-ws": { type: "string" },
    /** Answer the store's PostHog requests locally instead of forwarding them (see posthog-recorder.ts). */
    "posthog-mock": { type: "boolean", default: false },
  },
});

const persona = PERSONAS[args.persona ?? ""];
const flow = FLOWS[args.flow ?? ""];
if (!persona || !flow || !args.run || !args["run-dir"] || !args.seed) {
  console.error("usage: mcp-server --persona <id> --seed <n> --run <runId> --run-dir <dir> [--flow <id>] [--url <url>]");
  process.exit(2);
}

// Closing a connected browser closes only the contexts this process created.
const browser = args["browser-ws"] ? await chromium.connect(args["browser-ws"]) : await chromium.launch({ headless: !args.headed });
const context = await browser.newContext({
  viewport: { width: persona.viewport.width, height: persona.viewport.height },
  isMobile: persona.viewport.mobile,
  hasTouch: persona.viewport.mobile,
});
const seed = Number(args.seed);
// The swarm's tracks are recorded here, not read back from PostHog.
await recordPostHog(context, { runDir: args["run-dir"], agentId: `${persona.id}-${seed}`, mock: args["posthog-mock"], log: console.error });
const session = new AgentSession({
  page: await context.newPage(),
  persona,
  flow,
  runId: args.run,
  runDir: args["run-dir"],
  seed,
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  session.abandon("Stopped without finishing.");
  await session.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);

const toContent = (r: StepResult) => ({
  isError: r.isError,
  content: [
    { type: "text" as const, text: r.observation ? `${r.text}\n\n${describe(r.observation, persona.perception.mode)}` : r.text },
    ...(r.observation && !r.ended
      ? [{ type: "image" as const, mimeType: "image/png", data: r.observation.screenshot.toString("base64") }]
      : []),
  ],
});

const server = new McpServer({ name: "shop", version: "0.1.0" });
const tool = (name: ToolName, description: string, inputSchema: z.ZodRawShape = {}) =>
  server.registerTool(name, { description, inputSchema }, async (input: Record<string, unknown>) =>
    toContent(await session.call({ name, input } as ToolCall)),
  );

tool("look", "See the screen as it is now. Free.");
tool("click", "Click (or tap) an element by its id from the latest element list, e.g. \"e7\".", {
  id: z.string().describe("Element id, e.g. e7"),
});
tool("type", "Replace the text in an input field (no need to click it first). Set submit=true to press Enter afterwards.", {
  id: z.string().describe("Element id of the input, e.g. e3"),
  text: z.string(),
  submit: z.boolean().optional(),
});
tool("scroll", "Scroll the page up or down by most of a screen.", { direction: z.enum(["up", "down"]) });
tool("back", "Go back to the previous page, like the browser back button.");
tool("think_aloud", "Say what you are thinking or feeling right now, in first person and in character. Free.", {
  note: z.string(),
});
tool("give_up", "Abandon the purchase, as a real shopper would. Explain why in first person.", {
  reason: z.string(),
});
tool("done", "Call when the order is placed and confirmed.");

await server.connect(new StdioServerTransport());
// Calls are serialized behind start(), so tools wait for the shop to open.
void session.start(withSwarmTag(args.url ?? flow.startUrl, { runId: args.run, agentId: session.agentId, personaId: persona.id }));
