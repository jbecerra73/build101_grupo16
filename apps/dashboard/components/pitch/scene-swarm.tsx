"use client";

import { useMemo } from "react";
import { History, Radio } from "lucide-react";
import { SwarmMap } from "@/components/swarm/swarm-map";
import { deriveAgents, deriveMetrics } from "@/lib/derive";
import { shortSha } from "@/lib/format";
import { useReplay } from "@/lib/hooks/use-replay";
import type { RunDetail } from "@/lib/types";
import type { PitchData } from "./data";
import { FitBox, Reveal, SceneHeader } from "./parts";

/** On-screen length of the replay: the whole swarm fits in the scene's 30 s. */
const REPLAY_MS = 24_000;

/** The re-test replayed from its PostHog snapshot, like Replay on the run page. */
function Replayed({ retest }: { retest: RunDetail }) {
  const events = useMemo(() => retest.events ?? [], [retest.events]);
  const span = events.length ? Date.parse(events.at(-1)!.timestamp) - Date.parse(events[0].timestamp) : 0;
  const speed = Math.max(1, span / REPLAY_MS);
  const r = useReplay(events, events.length > 0, { speed });
  const { config, flow } = retest;

  const view = useMemo(() => {
    if (r.atEnd || !events.length) return { agents: retest.agents, metrics: retest.metrics ?? retest.provisionalMetrics };
    const partial = events.slice(0, r.shown);
    const finalShot = new Map(retest.agents.map((a) => [a.agentId, a]));
    const agents = deriveAgents(config, partial, flow, true).map((a) =>
      a.state === "running" ? a : { ...a, latestScreenshot: finalShot.get(a.agentId)?.latestScreenshot, screenshotVersion: finalShot.get(a.agentId)?.screenshotVersion },
    );
    return { agents, metrics: deriveMetrics(config, partial, flow) };
  }, [r.atEnd, r.shown, events, retest, config, flow]);

  return (
    <SwarmMap
      agents={view.agents}
      metrics={view.metrics}
      flow={flow}
      size="lg"
      live={!r.atEnd}
      minimal
      lang="es"
    />
  );
}

export function SceneSwarm({ d, index }: { d: PitchData; index: number }) {
  const retest = d.retest;
  return (
    <div className="flex h-full flex-col gap-5">
      <SceneHeader
        compact
        index={index}
        kicker={d.live ? "Re-test del swarm · en vivo en el preview" : "Re-test del swarm en el preview"}
        title={
          retest ? (
            <>
              {retest.agents.length || retest.config.personaIds.length * 10} agents con restricciones prueban el fix
            </>
          ) : (
            "Esperando al swarm"
          )
        }
        aside={
          retest && (
            <span className="flex items-center gap-2 text-xl text-muted-foreground">
              {d.live ? (
                <>
                  <Radio className="size-5 animate-pulse" style={{ color: "var(--status-running)" }} aria-hidden />
                  <span className="font-semibold text-foreground">En vivo</span>
                </>
              ) : (
                <>
                  <History className="size-5" aria-hidden />
                  Replay
                </>
              )}
              <span aria-hidden>·</span> build <code className="font-mono text-foreground">{shortSha(retest.config.posthog.buildSha)}</code>
            </span>
          )
        }
      />
      <Reveal delay={0.25} className="flex min-h-0 flex-1 flex-col">
        <FitBox className="flex-1">
        {!retest ? (
          <p className="text-4xl text-muted-foreground">{d.run.status.message ?? "El re-test arranca cuando el preview está arriba."}</p>
        ) : d.live || !retest.events?.length ? (
          <SwarmMap agents={retest.agents} metrics={retest.metrics ?? retest.provisionalMetrics} flow={retest.flow} size="lg" live={d.live} minimal lang="es" />
        ) : (
          <Replayed retest={retest} />
        )}
        </FitBox>
      </Reveal>
    </div>
  );
}
