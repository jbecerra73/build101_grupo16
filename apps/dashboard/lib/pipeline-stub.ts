// Stands in for @frictionswarm/pipeline in queue-mode builds (Netlify, or
// ORCHESTRATOR=queue at build time; see next.config.ts). The dashboard then
// only enqueues runs, and the pipeline, analyzer, Agent SDK and Playwright stay
// out of the server bundle. The real orchestrator is `npm run orchestrator`.
export function orchestratorFromEnv(): never {
  throw new Error("This dashboard was built in queue mode: run the orchestrator separately (npm run orchestrator, or npm run orchestrator:tenki -- up)");
}
