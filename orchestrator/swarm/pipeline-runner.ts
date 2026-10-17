// The tenki swarm as the pipeline's re-test runner (Settings.swarmRunner = "tenki"). The pipeline
// calls registerTenkiSwarmRunner(tenkiRunnerFactory()) at startup (see packages/pipeline daemon.ts
// and cli.ts); each re-test then runs `runSwarm` on the fix loop's RunConfig:
//   - the config's seeds and run folder (the fix loop already wrote config.json);
//   - every sandbox state change goes to runs/<runId>/swarm.json for the dashboard;
//   - the run's AbortSignal stops the workers and closes the sandboxes, then rejects "cancelled";
//   - no waitForSwarm here: the pipeline waits on PostHog itself (its "collecting" phase).
// Needs TENKI_API_KEY, TENKI_SNAPSHOT_ID and Claude credentials for the agents
// (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY), checked when a re-test starts.
import { join } from "node:path";
import type { SwarmRunner, TenkiSwarmRunnerFactory } from "@frictionswarm/pipeline";
import type { SandboxInfo, SwarmTopology } from "@frictionswarm/store";
import type { SandboxProvider } from "./provider";
import { runSwarm, SwarmAbortedError, type RunSwarmOptions, type SandboxState } from "./run";

/** Matches the pipeline's CANCELLED, which marks the run as cancelled rather than failed. */
const CANCELLED = "cancelled";

export type TenkiRunnerOptions = {
  env?: NodeJS.ProcessEnv;
  /** Seam for tests; defaults to tenki sandboxes from TENKI_SNAPSHOT_ID. */
  provider?: () => Promise<SandboxProvider>;
  /** Passed through to runSwarm (poll interval, timeouts, …). */
  swarm?: Partial<Pick<RunSwarmOptions, "pollMs" | "agentTimeoutMs" | "maxSandboxes" | "agentsPerSandbox" | "now">>;
};

/** The topology the dashboard reads (runs/<runId>/swarm.json). */
export function toTopology(runId: string, states: SandboxState[], now = new Date()): SwarmTopology {
  const sandboxes: SandboxInfo[] = states.map((s, i) => ({
    id: s.id ?? `pending-${runId}-${i + 1}`,
    label: `sbx-${i + 1}`,
    region: "tenki",
    status: s.status,
    agentIds: s.agentIds,
    startedAt: s.startedAt,
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
  }));
  return { runId, backend: "tenki", sandboxes, updatedAt: now.toISOString() };
}

function credentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const creds = Object.fromEntries(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].flatMap((k) => (env[k]?.trim() ? [[k, env[k]!]] : [])));
  if (Object.keys(creds).length === 0) throw new Error("Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY: the swarm's agents run Claude Code inside the sandboxes");
  return creds;
}

export function tenkiRunnerFactory(o: TenkiRunnerOptions = {}): TenkiSwarmRunnerFactory {
  const env = o.env ?? process.env;
  const makeProvider =
    o.provider ??
    (async () => {
      const { TenkiSandboxProvider } = await import("./tenki");
      return new TenkiSandboxProvider({ snapshotId: env.TENKI_SNAPSHOT_ID ?? "" });
    });

  return (ctx): SwarmRunner =>
    async (config) => {
      const provider = await makeProvider();
      const creds = o.provider ? {} : credentials(env);
      // Topology writes are queued so swarm.json never goes back in time.
      let writes = Promise.resolve();
      const onSandboxes = (states: SandboxState[]) => {
        const topo = toTopology(config.runId, states, o.swarm?.now?.());
        writes = writes.then(() => ctx.reportTopology(topo)).catch((err) => ctx.log(`swarm.json: ${err instanceof Error ? err.message : err}`));
      };
      const hasSeeds = config.personaIds.some((p) => (config.seeds[p]?.length ?? 0) > 0);
      try {
        await runSwarm({
          ...o.swarm,
          runId: config.runId,
          flowId: config.flowId,
          previewUrl: config.targetUrl,
          buildSha: config.posthog.buildSha,
          personaIds: config.personaIds,
          seeds: hasSeeds ? config.seeds : undefined,
          baselineRunId: config.baselineRunId,
          provider,
          runsDir: ctx.runsDir,
          ledgerFile: join(ctx.runsDir, ".swarm-ledger.json"),
          writeConfig: false,
          model: env.AGENT_MODEL || undefined,
          env: creds,
          onSandboxes,
          signal: ctx.signal,
          log: ctx.log,
        });
      } catch (err) {
        if (err instanceof SwarmAbortedError || ctx.signal.aborted) throw new Error(CANCELLED);
        throw err;
      } finally {
        await writes;
      }
    };
}
