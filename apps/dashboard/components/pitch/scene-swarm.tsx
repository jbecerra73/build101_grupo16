"use client";

import { useMemo } from "react";
import { History, Radio } from "lucide-react";
import { SwarmMap } from "@/components/swarm/swarm-map";
import { deriveAgents, deriveMetrics } from "@/lib/derive";
import { personaShort, shortSha } from "@/lib/format";
import { useReplay } from "@/lib/hooks/use-replay";
import type { RunDetail } from "@/lib/types";
import { seedLabel, type PitchData } from "./data";
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
    />
  );
}

export function SceneSwarm({ d, index }: { d: PitchData; index: number }) {
  const retest = d.retest;
  const seeds = retest ? Object.entries(retest.config.seeds) : [];
  return (
    <div className="flex h-full flex-col gap-5">
      <SceneHeader
        compact
        index={index}
        kicker={d.live ? "Swarm re-test · live on the preview" : "Swarm re-test on the preview"}
        title={
          retest ? (
            <>
              {retest.agents.length || retest.config.personaIds.length * 10} constrained agents shop the fix
            </>
          ) : (
            "Waiting for the swarm"
          )
        }
        aside={
          retest && (
            <div className="flex flex-col items-end gap-1 text-xl text-muted-foreground">
              {d.live && (
                <span className="flex items-center gap-2 font-semibold text-foreground">
                  <Radio className="size-5 animate-pulse" style={{ color: "var(--status-running)" }} aria-hidden />
                  Live
                </span>
              )}
              {!d.live && retest.events?.length ? (
                <span className="flex items-center gap-2">
                  <History className="size-5" aria-hidden />
                  replay of the PostHog snapshot · {retest.events.length} events · build{" "}
                  <code className="font-mono text-foreground">{shortSha(retest.config.posthog.buildSha)}</code>
                </span>
              ) : (
                <span>
                  build <code className="font-mono text-foreground">{shortSha(retest.config.posthog.buildSha)}</code>
                </span>
              )}
              <span className="tabular">fresh seeds · {seeds.map(([p, s]) => `${personaShort(p)} ${seedLabel(s)}`).join(" · ")}</span>
            </div>
          )
        }
      />
      <Reveal delay={0.25} className="flex min-h-0 flex-1 flex-col">
        <FitBox className="flex-1">
        {!retest ? (
          <p className="text-4xl text-muted-foreground">{d.run.status.message ?? "The re-test starts once the preview is up."}</p>
        ) : d.live || !retest.events?.length ? (
          <SwarmMap agents={retest.agents} metrics={retest.metrics ?? retest.provisionalMetrics} flow={retest.flow} size="lg" live={d.live} />
        ) : (
          <Replayed retest={retest} />
        )}
        </FitBox>
      </Reveal>
    </div>
  );
}
