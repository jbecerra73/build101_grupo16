// MOCK DATA, DELETE WHEN THE BACKEND PR LANDS.
//
// Stand-ins for the control-center routes (/api/control, /api/runs/[id]/swarm,
// /api/settings) while they don't exist on this branch. Everything here is
// derived from real data where possible (the run list, each run's agents) and
// is flagged `mock: true` by lib/client/api.ts so the UI labels it.
import type { ControlOverview, Settings, SwarmBackendKind, SwarmTopology, SandboxInfo } from "@/lib/control-types";
import { isTerminal } from "@/lib/format";
import type { AgentState, RunSummary } from "@/lib/types";

const SETTINGS_KEY = "frictionswarm.mock.settings";

/** What the inline pipeline does today with no env overrides (lib/orchestrator.ts
 * defaults + packages/pipeline). Not a decision about the deployed default. */
const INLINE_DEFAULTS: Settings = {
  swarmRunner: "replay",
  fixLoop: "fake",
  replaySpeed: 1.5,
  maxRunsPerDay: 10,
  defaultSeedsPerPersona: 10,
  verifyBuild: false,
};

export function mockSettings(): Settings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SETTINGS_KEY) : null;
    if (raw) return { ...INLINE_DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* private mode / bad json */
  }
  return { ...INLINE_DEFAULTS };
}

export function saveMockSettings(s: Settings): Settings {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  return s;
}

const loadedAt = new Date().toISOString();

/** ControlOverview from the run list. The inline pipeline runs inside the Next
 * server, so the "orchestrator" is always online and local, with no queue. */
export function mockControl(runs: RunSummary[]): ControlOverview {
  const settings = mockSettings();
  const baselines = runs.filter((r) => r.config.kind === "baseline");
  const active = baselines.filter((r) => !isTerminal(r.status.phase));
  const today = new Date().toISOString().slice(0, 10);
  return {
    active,
    recent: runs.filter((r) => isTerminal(r.status.phase)).slice(0, 8),
    queued: [],
    usage: {
      date: today,
      runs: baselines.filter((r) => r.config.createdAt.slice(0, 10) === today && !r.runId.startsWith("fixture")).length,
      max: settings.maxRunsPerDay,
    },
    settings,
    orchestrator: {
      host: "local",
      version: "inline pipeline",
      startedAt: loadedAt,
      lastSeenAt: new Date().toISOString(),
      activeRunIds: active.map((r) => r.runId),
      queueDepth: 0,
    },
  };
}

export const AGENTS_PER_SANDBOX = 6;
/** Rough estimate for the mock only: sandbox minutes + one model call per action. */
const USD_PER_SANDBOX_MIN = 0.006;
const USD_PER_ACTION = 0.011;

/** SwarmTopology from a run's agents: packed in order into sandboxes of ≤ 6
 * (30 agents → 5 sandboxes). Times are event times, cost is an estimate. */
export function mockTopology(runId: string, agents: AgentState[], backend: SwarmBackendKind): SwarmTopology {
  const sandboxes: SandboxInfo[] = [];
  const count = Math.max(1, Math.ceil(agents.length / AGENTS_PER_SANDBOX));
  for (let i = 0; i < count; i++) {
    const mine = agents.slice(i * AGENTS_PER_SANDBOX, (i + 1) * AGENTS_PER_SANDBOX);
    const started = mine.map((a) => a.startedAt).filter((t): t is number => !!t);
    const last = mine.map((a) => a.lastEventAt).filter((t): t is number => !!t);
    const allDone = mine.length > 0 && mine.every((a) => a.state !== "running");
    const status: SandboxInfo["status"] = !started.length ? (allDone ? "done" : "booting") : allDone ? "done" : "running";
    const startedAt = started.length ? Math.min(...started) : undefined;
    const endedAt = allDone && last.length ? Math.max(...last) : undefined;
    const minutes = startedAt ? ((endedAt ?? Math.max(...last, startedAt)) - startedAt) / 60000 : 0;
    const actions = mine.reduce((n, a) => n + a.actions, 0);
    sandboxes.push({
      id: `${runId}-sbx-${i + 1}`,
      label: `sbx-${i + 1}`,
      region: backend === "tenki" ? "tenki" : "replay",
      status,
      agentIds: mine.map((a) => a.agentId),
      startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
      endedAt: endedAt ? new Date(endedAt).toISOString() : undefined,
      costUsd: minutes * USD_PER_SANDBOX_MIN + actions * USD_PER_ACTION,
    });
  }
  return { runId, backend, sandboxes, updatedAt: new Date().toISOString() };
}
