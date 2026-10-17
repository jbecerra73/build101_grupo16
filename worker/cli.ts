// Run one persona agent locally against a store and write a run folder.
//
//   npm run agent -- --persona typical --seed 1 [--url https://...] [--run <runId>] [--headed]
//
// Several invocations with the same --run add agents to the same run folder.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { FLOWS, MAX_ACTIONS_PER_AGENT, PERSONAS, type RunConfig } from "../shared";
import { runAgent, systemPrompt } from "./agent";
import { createBrain, DEFAULT_AGENT_MODEL } from "./brain";

// API keys (OPENCODE_API_KEY or ANTHROPIC_API_KEY) and optionally AGENT_MODEL live in a gitignored .env.
if (existsSync(".env")) process.loadEnvFile(".env");

const { values: args } = parseArgs({
  options: {
    persona: { type: "string", default: "typical" },
    seed: { type: "string", default: "1" },
    flow: { type: "string", default: "buy-tshirt" },
    url: { type: "string" },
    run: { type: "string" },
    runs: { type: "string", default: "runs" },
    model: { type: "string", default: DEFAULT_AGENT_MODEL() },
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
const runDir = join(args.runs!, runId);

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
  const seeds = new Set([...(config.seeds[persona.id] ?? []), seed]);
  config.seeds[persona.id] = [...seeds].sort((a, b) => a - b);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

const buildSha = await readBuildSha(targetUrl);
writeConfig(buildSha);
console.log(`run ${runId} · ${persona.id}-${seed} · ${targetUrl} · build ${buildSha} · ${args.model}`);

const browser = await chromium.launch({ headless: !args.headed });
try {
  const context = await browser.newContext({
    viewport: { width: persona.viewport.width, height: persona.viewport.height },
    isMobile: persona.viewport.mobile,
    hasTouch: persona.viewport.mobile,
  });
  const page = await context.newPage();
  const maxActions = Math.min(persona.actions.maxActions, MAX_ACTIONS_PER_AGENT);
  const brain = createBrain(systemPrompt(persona, flow, seed, maxActions), args.model);
  const startUrl = new URL(targetUrl);
  startUrl.searchParams.set("swarm", runId);
  const result = await runAgent({ page, brain, persona, flow, runId, runDir, seed, startUrl: startUrl.toString() });
  for (const e of result.events) {
    const what = e.action ? `${e.action.kind} ${e.action.text ?? e.action.selector ?? ""}${e.action.missed ? " (missed)" : ""}` : e.note ?? "";
    console.log(`  ${e.type.padEnd(11)} ${(e.step ?? "-").padEnd(13)} ${what}`);
  }
  console.log(`${result.outcome} after ${result.actions} actions → ${runDir}`);
  process.exitCode = result.outcome === "error" ? 1 : 0;
} finally {
  await browser.close();
}
