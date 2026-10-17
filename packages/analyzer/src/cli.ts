// npm run analyze -- runs/<id>   (writes metrics.json + findings.json + themes.json; loads .env.local from the repo root)
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeRun } from "./analyze";

const root = join(import.meta.dirname, "..", "..", "..");
const envFile = process.env.ANALYZER_ENV_FILE ?? join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run analyze -- runs/<id>");
  process.exit(1);
}
const runDir = resolve(process.env.INIT_CWD ?? process.cwd(), dir);
const { metrics, findings, themes, path, themesPath, error } = await analyzeRun(runDir, { log: (l) => console.error(l) });
if (error) console.error(error);
console.log(`findings path: ${path}, themes path: ${themesPath}`);
for (const p of metrics.personas)
  console.log(`${p.personaId}: ${p.completed}/${p.n} completed, ${p.gaveUp} gave up, ${p.invalidCompletions} invalid`);
for (const f of findings) console.log(`${f.id} [${f.severity}] ${f.step} ${f.title} (${f.personas.join(", ")})`);
for (const t of themes) console.log(`${t.id} ${t.title} (${t.agentCount} agents: ${t.personas.join(", ")})`);
console.log(`wrote ${join(runDir, "metrics.json")}, findings.json and themes.json`);
