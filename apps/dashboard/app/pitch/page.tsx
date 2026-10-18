import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PitchDeck } from "@/components/pitch/pitch-deck";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pitch · FrictionSwarm" };

const DEFAULT_RUN = "fixture-proven";

/** Presenter view of one analysis run (and its re-test), read from the run store only:
 * no PostHog or model calls, so it works offline from the fixture run folders. */
export default async function PitchPage(props: PageProps<"/pitch">) {
  const sp = await props.searchParams;
  const requested = typeof sp.run === "string" && sp.run ? sp.run : DEFAULT_RUN;
  let run = await getRun(requested);
  if (!run) notFound();
  // A re-test id works too: present its analysis run.
  if (run.config.kind === "retest" && run.config.baselineRunId) run = (await getRun(run.config.baselineRunId)) ?? run;
  if (run.config.kind === "retest") notFound();

  const retestId = run.status.retestRunId ?? run.fix?.attempts.at(-1)?.retestRunId;
  const retest = retestId ? await getRun(retestId, { events: true }) : undefined;
  const scene = typeof sp.scene === "string" ? Number(sp.scene) : undefined;

  return <PitchDeck key={run.runId} initial={run} initialRetest={retest} startScene={scene} />;
}
