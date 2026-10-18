// Scheduled every 5 minutes: if runs are queued and the orchestrator is
// neither online nor booting, pokes orchestrator-launch. Catches a missed poke
// and a sandbox that died mid-boot.
import { createStore, KEYS, type OrchestratorHeartbeat } from "@frictionswarm/store";
import { LAUNCH_HEADER, LAUNCH_PATH, launchDecision, launchSecret, type LaunchRecord } from "@frictionswarm/store/launch";

export default async () => {
  const store = createStore("/tmp/runs", { ...process.env, RUN_STORE: "blobs" });
  const [hb, lock, queue] = await Promise.all([
    store.getJson<OrchestratorHeartbeat>(KEYS.heartbeat).catch(() => undefined),
    store.getJson<LaunchRecord>(KEYS.launch).catch(() => undefined),
    store.list(KEYS.queue),
  ]);
  const decision = launchDecision(hb, lock, Date.now());
  if (!queue.length || !decision.launch) return;
  const base = process.env.URL;
  if (!base) return console.log("[watch] URL is not set, cannot poke the launcher");
  const res = await fetch(`${base}${LAUNCH_PATH}?reason=watch`, { method: "POST", headers: { [LAUNCH_HEADER]: launchSecret() } });
  console.log(`[watch] ${queue.length} queued, orchestrator offline: launcher answered ${res.status}`);
};

export const config = { schedule: "*/5 * * * *" };
