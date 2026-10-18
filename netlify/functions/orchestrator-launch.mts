// Background function (up to 15 min, the caller gets 202 at once): boots the
// orchestrator in a tenki sandbox when runs are queued and none is running or
// booting. Poked by the dashboard when it enqueues a run, and by
// orchestrator-watch every 5 minutes. See packages/store/src/launch.ts.
import { createStore } from "@frictionswarm/store";
import { LAUNCH_HEADER, launchOrchestrator, launchSecret } from "@frictionswarm/store/launch";

type Context = { site?: { id?: string } };

export default async (req: Request, context: Context) => {
  const secret = launchSecret();
  if (!secret || req.headers.get(LAUNCH_HEADER) !== secret) {
    console.log("[launch] refused: missing or wrong secret");
    return;
  }
  const reason = new URL(req.url).searchParams.get("reason") ?? "poke";
  // Inside Netlify the Blobs store needs no credentials; the sandbox does.
  const env = { ...process.env, SITE_ID: process.env.SITE_ID || context.site?.id };
  const result = await launchOrchestrator(
    { store: createStore("/tmp/runs", { ...env, RUN_STORE: "blobs" }), env, log: (l) => console.log(`[launch] ${l}`) },
    reason,
  );
  console.log(`[launch] ${reason}: ${JSON.stringify(result)}`);
};

export const config = { background: true };
