// SPEC "Improvement threshold": each targeted segment's real users (analysis run) against the
// persona swarm standing in for it on the preview (retest run). The rule lives in the analyzer,
// so the PR and the dashboard can't disagree.
export { compareSegmentsToPersonas as compareRuns, IMPROVEMENT_PTS } from "@frictionswarm/analyzer";
