// npm run analyze -- runs/<id> [--source snapshot|file|api] [--heuristic]
// Writes posthog.jsonl, history.json (analysis), metrics.json, findings.json and themes.json.
// Loads .env.local from the repo root (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, POSTHOG_*).
// Default source: replay the run's posthog.jsonl if it exists, else config.posthog.source.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPostHogSource, snapshotSource } from "@frictionswarm/posthog";
import { analyzeRun } from "./analyze";

const root = join(import.meta.dirname, "..", "..", "..");
const envFile = process.env.ANALYZER_ENV_FILE ?? join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { source: { type: "string" }, heuristic: { type: "boolean", default: false } },
});
const dir = positionals[0];
if (!dir) {
  console.error("usage: npm run analyze -- runs/<id> [--source snapshot|file|api] [--heuristic]");
  process.exit(1);
}
const runDir = resolve(process.env.INIT_CWD ?? process.cwd(), dir);
const source =
  values.source === "snapshot" ? snapshotSource(runDir) : values.source ? createPostHogSource(values.source as "file" | "api") : undefined;
const r = await analyzeRun(runDir, { source, ...(values.heuristic && { env: {} }), log: (l) => console.error(l) });
if (r.error) console.error(r.error);
console.log(`${r.events} events, ${r.sessions} sessions; read ${r.timings.readMs}ms, findings ${r.timings.findingsMs}ms (${r.path}), total ${r.timings.totalMs}ms`);
for (const s of r.metrics.segments)
  console.log(`${s.segmentId}: ${s.completed}/${s.n} completed (${(s.completionRate * 100).toFixed(1)}%), ${s.users} users, ${s.invalidCompletions} invalid`);
for (const p of r.metrics.personas)
  console.log(`${p.personaId}: ${p.completed}/${p.n} completed, ${p.gaveUp} gave up, ${p.invalidCompletions} invalid`);
for (const f of r.findings)
  console.log(`${f.id} [${f.severity}] ${f.step} ${f.title} (${f.segments.join(", ")}; ${f.evidence.sessions} sessions${f.evidence.sinceRelease ? `; since ${f.evidence.sinceRelease.name}` : ""})`);
for (const t of r.themes) console.log(`${t.id} ${t.title} (${t.sessions} sessions)`);
console.log(`wrote ${runDir}/{posthog.jsonl,${r.history ? "history.json," : ""}metrics.json,findings.json,themes.json}`);
