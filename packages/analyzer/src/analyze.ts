import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FLOWS, type Finding, type Flow, type Metrics } from "@frictionswarm/shared";
import { generateFindings, type FindingsOptions, type FindingsPath } from "./findings";
import { computeMetrics } from "./metrics";
import { readRun } from "./run";
import type { Theme } from "./themes";

export type AnalyzeOptions = Omit<FindingsOptions, "flow"> & {
  flow?: Flow;
  /** Write metrics.json + findings.json + themes.json into the run folder. Default true. */
  write?: boolean;
};

export type AnalyzeResult = {
  metrics: Metrics;
  findings: Finding[];
  themes: Theme[];
  path: FindingsPath;
  themesPath: FindingsPath;
  error?: string;
};

const writeJson = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + "\n");

export async function analyzeRun(runDir: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const run = readRun(runDir);
  const flow = opts.flow ?? FLOWS[run.config.flowId];
  if (!flow) throw new Error(`Unknown flow ${run.config.flowId}`);
  const metrics = computeMetrics(run.config, flow, run.events);
  const res = await generateFindings(run, metrics, { ...opts, flow });
  if (opts.write ?? true) {
    await writeJson(join(runDir, "metrics.json"), metrics);
    await writeJson(join(runDir, "findings.json"), res.findings);
    await writeJson(join(runDir, "themes.json"), res.themes);
  }
  return { metrics, ...res };
}

/** Adapter for the orchestrator's `Analyzer` port: (runId) => { metrics, findings }. */
export function createAnalyzer({ runsDir, ...opts }: AnalyzeOptions & { runsDir: string }) {
  return async (runId: string): Promise<{ metrics: Metrics; findings: Finding[] }> => {
    const { metrics, findings, themes, path, themesPath, error } = await analyzeRun(join(runsDir, runId), opts);
    opts.log?.(
      `analyzed ${runId}: ${findings.length} findings via ${path}, ${themes.length} themes via ${themesPath}${error ? ` (${error})` : ""}`,
    );
    return { metrics, findings };
  };
}
