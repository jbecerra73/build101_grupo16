// @frictionswarm/analyzer: PostHog events → metrics, findings and themes.
// analyzeRun(runDir, { source }) reads runs/<id>/config.json and writes, next to it,
//   posthog.jsonl   the events it analyzed (snapshot; the run replays offline from it)
//   history.json    History      analysis runs: per-release / per-week aggregates behind
//                                the trend and release attribution (see history.ts)
//   metrics.json    Metrics      deterministic (see metrics.ts for the definitions)
//   findings.json   Finding[]    ranked (Sonnet 5.5 over aggregated signals, else heuristic)
//   themes.json     Theme[]      why sessions ended without an order (see themes.ts)
// createAnalyzer({ runsDir, source }) is the orchestrator's port: (runId) => { metrics, findings }.
export * from "./run";
export * from "./elements";
export * from "./sessions";
export * from "./releases";
export * from "./history";
export * from "./metrics";
export * from "./signals";
export * from "./heuristic";
export * from "./themes";
export * from "./findings";
export * from "./verdict";
export * from "./analyze";
