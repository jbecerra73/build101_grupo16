// @frictionswarm/analyzer: reads runs/<runId>/ and writes, next to the events,
//   metrics.json    Metrics      deterministic, from the event log (see metrics.ts)
//   findings.json   Finding[]    ranked friction findings (Sonnet, else heuristic)
//   themes.json     Theme[]      give-up reasons grouped into themes with verbatim
//                                persona quotes, largest first (see themes.ts). Produced
//                                in the same model call as the findings; quotes are
//                                checked against the agent's notes. The heuristic
//                                fallback makes one theme per step where agents gave up.
// Theme lives here, not in shared/contracts.ts:
//   { id: "T1", title, personas, agentCount, quotes: {personaId, agentId, text}[], findingIds? }
export * from "./run";
export * from "./validity";
export * from "./metrics";
export * from "./signals";
export * from "./heuristic";
export * from "./themes";
export * from "./findings";
export * from "./analyze";
