"use client";

import { motion, useReducedMotion } from "motion/react";
import { CircleCheck, CircleX, Cpu, LoaderCircle, Power, Radio, type LucideIcon } from "lucide-react";
import { PersonaAvatar } from "@/components/persona/avatar";
import { MockBadge } from "@/components/mock-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getSwarm } from "@/lib/client/api";
import { AGENTS_PER_SANDBOX, estimateTopology } from "@/lib/client/estimate";
import { moodOf, MOOD_LABEL } from "@/lib/client/mood";
import type { SandboxInfo, SandboxStatus, SwarmTopology } from "@/lib/control-types";
import { usePoll, useNow } from "@/lib/hooks/use-poll";
import { personaShort } from "@/lib/format";
import type { AgentState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { clock } from "./swarm-stats";

const STATUS: Record<SandboxStatus, { label: string; icon: LucideIcon; color: string; spin?: boolean }> = {
  booting: { label: "Booting", icon: LoaderCircle, color: "var(--status-running)", spin: true },
  running: { label: "Running", icon: Radio, color: "var(--status-running)" },
  done: { label: "Done", icon: CircleCheck, color: "var(--status-good)" },
  failed: { label: "Failed", icon: CircleX, color: "var(--status-critical)" },
  closed: { label: "Closed", icon: Power, color: "var(--muted-foreground)" },
};

const usd = (v: number) => (v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`);

function SandboxStatusBadge({ status }: { status: SandboxStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <Badge variant="outline" className="gap-1.5">
      <Icon data-icon="inline-start" className={cn(s.spin && "animate-spin", status === "running" && "motion-safe:animate-pulse")} style={{ color: s.color }} />
      {s.label}
    </Badge>
  );
}

function Slot({ a, index, sandboxIndex, booting }: { a?: AgentState; index: number; sandboxIndex: number; booting: boolean }) {
  const reduced = useReducedMotion();
  if (!a)
    return (
      <div className="flex flex-col items-center gap-1" aria-hidden>
        <span className={cn("size-11 rounded-full border-2 border-dashed", booting && "motion-safe:animate-pulse")} />
        <span className="text-xs text-transparent">—</span>
      </div>
    );
  const mood = moodOf(a);
  const delay = reduced ? 0 : sandboxIndex * 0.12 + index * 0.08;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.div
          className="relative flex flex-col items-center gap-1"
          initial={reduced ? false : { opacity: 0, y: -26, scale: 0.5 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 18, delay }}
          tabIndex={0}
        >
          {/* the "connection" into the sandbox: a short wire that draws in, then fades */}
          {!reduced && (
            <motion.span
              aria-hidden
              className="absolute -top-3 left-1/2 h-3 w-0.5 origin-top -translate-x-1/2 rounded bg-[var(--status-running)]"
              initial={{ scaleY: 0, opacity: 1 }}
              animate={{ scaleY: [0, 1, 1], opacity: [1, 1, 0] }}
              transition={{ duration: 0.9, delay: delay + 0.15 }}
            />
          )}
          <PersonaAvatar personaId={a.personaId} mood={booting ? "idle" : mood} size={44} seed={a.seed} label="" />
          <span className="tabular text-xs text-muted-foreground">
            {personaShort(a.personaId)} #{a.seed}
          </span>
        </motion.div>
      </TooltipTrigger>
      <TooltipContent side="top">
        {personaShort(a.personaId)} #{a.seed} · {MOOD_LABEL[mood]} · {a.step ?? "starting"} · {a.actions}/{a.budget} actions
      </TooltipContent>
    </Tooltip>
  );
}

function uptimeMs(s: SandboxInfo, now: number, agents: AgentState[], eventClock: boolean) {
  if (!s.startedAt) return 0;
  const start = Date.parse(s.startedAt);
  const end = s.endedAt
    ? Date.parse(s.endedAt)
    : eventClock
      ? Math.max(start, ...agents.map((a) => a.lastEventAt ?? 0))
      : now;
  return Math.max(0, end - start);
}

function SandboxCard({ s, i, agents, now, eventClock }: { s: SandboxInfo; i: number; agents: AgentState[]; now: number; eventClock: boolean }) {
  const mine = s.agentIds.map((id) => agents.find((a) => a.agentId === id));
  const slots = Array.from({ length: AGENTS_PER_SANDBOX }, (_, k) => mine[k]);
  const up = uptimeMs(s, now, mine.filter((a): a is AgentState => !!a), eventClock);
  const done = mine.filter((a) => a && a.state !== "running").length;
  return (
    <Card size="sm" className={cn("relative overflow-hidden", s.status === "failed" && "ring-2 ring-[var(--status-critical)]/50")}>
      {s.status === "running" && (
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 origin-left bg-[var(--status-running)] motion-safe:animate-pulse" />
      )}
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-mono text-base">
            <Cpu className="size-4 text-muted-foreground" aria-hidden />
            {s.label}
          </span>
          <SandboxStatusBadge status={s.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-x-2 gap-y-3 pt-2">
          {slots.map((a, k) => (
            <Slot key={a?.agentId ?? `empty-${k}`} a={a} index={k} sandboxIndex={i} booting={s.status === "booting"} />
          ))}
        </div>
        <dl className="grid grid-cols-3 gap-2 border-t pt-3 text-sm">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Uptime</dt>
            <dd className="tabular font-semibold">{clock(up)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Agents done</dt>
            <dd className="tabular font-semibold">
              {done}/{s.agentIds.length}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Cost est.</dt>
            <dd className="tabular font-semibold">{s.costUsd !== undefined ? usd(s.costUsd) : "—"}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Per-sandbox view of the swarm (SwarmTopology). `derived` = always build the
 * topology from the agents (Replay), never from the API. */
export function SwarmMonitor({ runId, agents, live, derived }: { runId: string; agents: AgentState[]; live: boolean; derived?: boolean }) {
  const poll = usePoll(() => getSwarm(runId), 2000, !derived && live);
  const once = usePoll(() => getSwarm(runId), 60_000, !derived && !live);
  const fetched = poll.data ?? once.data;
  const now = useNow(1000);
  // Estimates are rebuilt from the latest agents every render so they track the map.
  const mock = derived || !fetched;
  const topo: SwarmTopology = mock ? estimateTopology(runId, agents, fetched?.backend ?? "offline") : fetched;
  const eventClock = mock;
  const totalCost = topo.sandboxes.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  const totalUp = topo.sandboxes.reduce((s, x) => s + uptimeMs(x, now, agents.filter((a) => x.agentIds.includes(a.agentId)), eventClock), 0);
  const running = topo.sandboxes.filter((s) => s.status === "running" || s.status === "booting").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
        <div className="flex flex-col">
          <span className="text-sm text-muted-foreground">Sandboxes</span>
          <span className="tabular text-3xl font-semibold">
            {running}
            <span className="text-lg font-normal text-muted-foreground">/{topo.sandboxes.length} active</span>
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm text-muted-foreground">Sandbox time</span>
          <span className="tabular text-3xl font-semibold">{clock(totalUp)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm text-muted-foreground">Run cost est.</span>
          <span className="tabular text-3xl font-semibold">{usd(totalCost)}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary" className="uppercase">
            {topo.backend === "tenki" ? "tenki sandboxes" : "offline swarm"}
          </Badge>
          {mock && <MockBadge what="Sandbox layout, uptime and cost are estimated from the agents until the swarm runner writes swarm.json." />}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {topo.sandboxes.map((s, i) => (
          <SandboxCard key={s.id} s={s} i={i} agents={agents} now={now} eventClock={eventClock} />
        ))}
      </div>
    </div>
  );
}
