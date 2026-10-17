import { notFound } from "next/navigation";
import { RunView } from "@/components/run/run-view";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default async function RunPage(props: PageProps<"/runs/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const replay = sp.replay === "1" || sp.replay === "true";
  const run = await getRun(id, { events: replay });
  if (!run) notFound();
  return <RunView key={`${id}-${replay}`} initial={run} replay={replay} />;
}
