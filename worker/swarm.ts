// The swarm worker: one process per tenki sandbox that runs up to 6 persona agents at once,
// each in its own browser context of one shared Chromium (a Playwright browser server the
// agents' MCP servers connect to). Each agent is a `claude -p` process, exactly as in the
// single-agent CLI (see claude.ts). Entry point: swarm-cli.ts.
import { join } from "node:path";
import { chromium } from "playwright";
import { flowOf, PERSONAS, type Flow, type PersonaId, type SwarmAgentResult } from "../shared";
import { runClaudeAgent, type ClaudeAgentOptions } from "./claude";

export const AGENTS_PER_WORKER = 6;

/** What the orchestrator hands one worker (written to the sandbox as JSON). */
export type SwarmWorkerInput = {
  runId: string;
  flowId: string;
  /** The run's flow snapshot (stored flows are not in FLOWS); wins over flowId. */
  flow?: Flow;
  /** Overrides the flow's goal for the agents. */
  goal?: string;
  /** The deploy preview; each agent opens it with its swarm tag. */
  targetUrl: string;
  agents: { personaId: PersonaId; seed: number }[];
};

export type SwarmWorkerOptions = {
  /** Run folders live here: `<runsDir>/<runId>/{screenshots,agents}/`. */
  runsDir: string;
  model: string;
  timeoutMs: number;
  concurrency?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Seams for tests. */
  launchBrowser?: () => Promise<{ wsEndpoint(): string; close(): Promise<void> }>;
  runAgent?: (o: ClaudeAgentOptions) => Promise<{ result: SwarmAgentResult }>;
};

/** Runs `fn` over `items` with at most `limit` in flight; resolves when all have settled. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** Chromium keeps its sandbox (SPEC: no --no-sandbox); Playwright disables it unless asked. */
const launchBrowserServer = () => chromium.launchServer({ headless: true, chromiumSandbox: process.env.SWARM_CHROMIUM_SANDBOX !== "0" });

/** The input's own flow, else the built-in one (own keys only). */
export const workerFlow = (input: Pick<SwarmWorkerInput, "flow" | "flowId" | "goal">): Flow | undefined => flowOf(input);

export async function runSwarmWorker(input: SwarmWorkerInput, o: SwarmWorkerOptions): Promise<SwarmAgentResult[]> {
  const flow = workerFlow(input);
  if (!flow) throw new Error(`Unknown flow ${input.flowId}`);
  const unknown = input.agents.filter((a) => !PERSONAS[a.personaId]).map((a) => a.personaId);
  if (unknown.length) throw new Error(`Unknown personas: ${[...new Set(unknown)].join(", ")}`);
  const log = o.log ?? console.log;
  const runDir = join(o.runsDir, input.runId);
  const runAgent = o.runAgent ?? runClaudeAgent;

  const browser = await (o.launchBrowser ?? launchBrowserServer)();
  try {
    const settled = await pool(input.agents, o.concurrency ?? AGENTS_PER_WORKER, async ({ personaId, seed }) => {
      const agentId = `${personaId}-${seed}`;
      if (o.signal?.aborted) throw new Error("aborted");
      log(`[${agentId}] start`);
      const { result } = await runAgent({
        persona: PERSONAS[personaId],
        flow,
        seed,
        runId: input.runId,
        runDir,
        targetUrl: input.targetUrl,
        model: o.model,
        timeoutMs: o.timeoutMs,
        browserWs: browser.wsEndpoint(),
        signal: o.signal,
        log: (line) => log(`[${agentId}]${line}`),
      });
      log(`[${agentId}] ${result.outcome} · ${result.actions} actions${result.reason ? ` · ${result.reason}` : ""}`);
      return result;
    });
    const failed = settled.filter((s) => s.status === "rejected");
    for (const f of failed) log(`agent failed: ${(f as PromiseRejectedResult).reason}`);
    return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  } finally {
    await browser.close().catch(() => {});
  }
}
