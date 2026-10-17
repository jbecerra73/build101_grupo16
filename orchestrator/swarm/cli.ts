// Launch the re-test swarm against a deploy preview:
//
//   npm run swarm -- --url https://deploy-preview-12--swarm-ecommerce.netlify.app
//       [--run <runId>] [--personas rosa,kai,typical] [--seeds-per-persona 10] [--flow buy-tshirt]
//       [--provider tenki|local] [--snapshot <id>] [--daily-cap 5] [--sha <preview build sha>]
//       [--model haiku] [--dry-run]
//
// tenki (default) needs TENKI_API_KEY and TENKI_SNAPSHOT_ID (from `npm run swarm:snapshot`), and
// Claude credentials for the agents: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, passed to the
// sandboxes. `--provider local` runs the same workers on this machine. The daily cap
// (SWARM_DAILY_CAP, default 5) and fresh seeds are tracked in runs/.swarm-ledger.json.
//
// Ctrl-C stops the workers and closes every sandbox; a second Ctrl-C quits without waiting
// (sandboxes then stop at their maxDuration).
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FLOWS, PERSONAS } from "../../shared";
import { readBuildSha } from "../../worker/claude";
import { peekNextSeed } from "./ledger";
import { freshSeeds, MAX_SANDBOXES, planSwarm } from "./plan";
import type { SandboxProvider } from "./provider";
import { runSwarm } from "./run";
import { localResultsWaiter } from "./wait";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    run: { type: "string" },
    flow: { type: "string", default: "buy-tshirt" },
    personas: { type: "string", default: "rosa,kai,typical" },
    "seeds-per-persona": { type: "string", default: "10" },
    provider: { type: "string", default: "tenki" },
    snapshot: { type: "string", default: process.env.TENKI_SNAPSHOT_ID },
    "daily-cap": { type: "string", default: process.env.SWARM_DAILY_CAP ?? "5" },
    sandboxes: { type: "string", default: String(MAX_SANDBOXES) },
    sha: { type: "string" },
    model: { type: "string", default: process.env.AGENT_MODEL ?? "haiku" },
    runs: { type: "string", default: "runs" },
    "poll-sec": { type: "string", default: "3" },
    "agent-timeout-min": { type: "string", default: "10" },
    "wait-timeout-min": { type: "string", default: "10" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!args.url) {
  console.error("usage: npm run swarm -- --url <deploy preview URL> [--provider tenki|local] [--dry-run] …");
  process.exit(2);
}
const flow = FLOWS[args.flow!];
if (!flow) throw new Error(`Unknown flow ${args.flow}; known: ${Object.keys(FLOWS).join(", ")}`);
const personaIds = args.personas!.split(",").filter(Boolean);
for (const p of personaIds) if (!PERSONAS[p]) throw new Error(`Unknown persona ${p}; known: ${Object.keys(PERSONAS).join(", ")}`);
const runId = args.run ?? `retest-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
const runsDir = resolve(args.runs!);
const ledgerFile = join(runsDir, ".swarm-ledger.json");
const seedsPerPersona = Number(args["seeds-per-persona"]);

if (args["dry-run"]) {
  const plan = planSwarm({ runId, previewUrl: args.url, personaIds, seeds: freshSeeds(personaIds, seedsPerPersona, peekNextSeed(ledgerFile)), maxSandboxes: Number(args.sandboxes) });
  plan.sandboxes.forEach((agents, i) => console.log(`sandbox ${i + 1}: ${agents.map((a) => a.agentId).join(", ")}`));
  console.log(`e.g. ${plan.agents[0].startUrl}`);
  process.exit(0);
}

const log = (line: string) => console.log(line);
let provider: SandboxProvider;
if (args.provider === "tenki") {
  const { TenkiSandboxProvider } = await import("./tenki");
  provider = new TenkiSandboxProvider({ snapshotId: args.snapshot ?? "", log });
} else if (args.provider === "local") {
  const { LocalSandboxProvider } = await import("./local");
  provider = new LocalSandboxProvider(join(tmpdir(), "frictionswarm-sandboxes", runId), log);
} else throw new Error(`Unknown provider ${args.provider}; use tenki or local`);

// Credentials the agents' `claude -p` needs inside the sandbox.
const env = Object.fromEntries(
  ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
);
if (args.provider === "tenki" && Object.keys(env).length === 0)
  throw new Error("Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY: the agents run Claude Code inside the sandboxes");

const abort = new AbortController();
let interrupts = 0;
const onSignal = (sig: string) => {
  if (++interrupts > 1) {
    console.error(`\n${sig} again: quitting without waiting; check the tenki dashboard for sandboxes still running.`);
    process.exit(130);
  }
  console.error(`\n${sig}: stopping workers and closing sandboxes… (again to force quit)`);
  abort.abort();
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

const buildSha = args.sha ?? (await readBuildSha(args.url));
try {
  const { results } = await runSwarm({
    runId,
    flowId: flow.id,
    previewUrl: args.url,
    buildSha,
    personaIds,
    seedsPerPersona,
    provider,
    // TODO(#32): PostHogSource.waitForSwarm once it exists; this only waits for the agents' local results.
    waiter: localResultsWaiter(runsDir),
    runsDir,
    ledgerFile,
    dailyCap: Number(args["daily-cap"]),
    maxSandboxes: Number(args.sandboxes),
    pollMs: Number(args["poll-sec"]) * 1000,
    agentTimeoutMs: Number(args["agent-timeout-min"]) * 60_000,
    waitTimeoutMs: Number(args["wait-timeout-min"]) * 60_000,
    model: args.model,
    env,
    signal: abort.signal,
    log,
  });
  for (const r of results) log(`  ${r.agentId.padEnd(14)} ${r.outcome.padEnd(8)} ${r.actions} actions${r.reason ? ` · ${r.reason}` : ""}`);
  log(`→ ${join(runsDir, runId)} · PostHog: swarm_run = ${runId}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = abort.signal.aborted ? 130 : 1;
}
// Don't linger on the tenki client's open connections.
process.exit();
