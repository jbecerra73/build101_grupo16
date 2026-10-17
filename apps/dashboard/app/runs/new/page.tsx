import { datasetReleases, knownReleases } from "@/lib/runs";
import { NewRunForm } from "./new-run-form";

export const dynamic = "force-dynamic";

export default async function NewRunPage() {
  const known = await knownReleases();
  const releases = known.length ? known : await datasetReleases();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Analyze</h1>
        <p className="text-muted-foreground">
          Find where real users stumble, per segment, from the store&apos;s PostHog data. Optionally fix the top findings and verify the
          fix with a persona swarm on the preview.
        </p>
      </div>
      <NewRunForm releases={releases} today={today} defaultSource={process.env.POSTHOG_SOURCE === "api" ? "api" : "file"} />
    </div>
  );
}
