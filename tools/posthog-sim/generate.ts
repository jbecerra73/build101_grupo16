// Fake PostHog data, in PostHog's export / `/batch` import shape (one event per
// line). Two modes:
//
//   history (default): months of real-user traffic on production
//     npm run posthog:generate
//     npm run posthog:generate -- --from 2026-04-17 --to 2026-10-16 --current-sha <prod sha>
//
//   swarm: one re-test swarm's tracks on a deploy preview
//     npm run posthog:generate -- --swarm <runId> --sha <preview sha> \
//       --host deploy-preview-12--swarm-ecommerce.netlify.app --fixed T1,T2 --seeds 1001-1010 [--flow buy-jeans]
//
// Output goes to data/posthog/ (gitignored); regenerate any time, it is seeded.

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { PostHogEvent } from "../../shared/analytics";
import { PERSONAS } from "../../shared/personas";
import { FLOWS, flowPersonas } from "../../shared/flows";
import {
  mulberry32,
  newVisitor,
  PERSONA_PROFILES,
  PRODUCTION_HOST,
  RELEASES,
  releaseAt,
  SEGMENT_PROFILES,
  simulateSession,
  SWARM_INTENTS,
  visitorSegment,
  type Rng,
  type TrapId,
  type Visitor,
} from "./sim";
import { summarize } from "./summarize";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAY = 86_400_000;

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    seed: { type: "string", default: "16" },
    from: { type: "string", default: "2026-04-17" },
    to: { type: "string", default: "2026-10-16" },
    "current-sha": { type: "string" },
    swarm: { type: "string" },
    flow: { type: "string", default: "buy-tshirt" },
    sha: { type: "string" },
    host: { type: "string" },
    fixed: { type: "string", default: "" },
    personas: { type: "string" },
    seeds: { type: "string", default: "1001-1010" },
    start: { type: "string" },
  },
});

const jsonl = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  return {
    write: (events: PostHogEvent[]) => {
      for (const e of events) stream.write(JSON.stringify(e) + "\n");
    },
    close: () => new Promise<void>((resolve) => stream.end(resolve)),
  };
};

// Hour-of-day weights (store time), lunch and evening peaks.
const HOURS = [2, 1, 1, 1, 1, 2, 3, 5, 7, 8, 9, 11, 13, 12, 10, 9, 9, 10, 12, 14, 15, 13, 8, 4];
const hourOf = (rng: Rng) => {
  let r = rng() * HOURS.reduce((a, b) => a + b, 0);
  for (let h = 0; h < 24; h++) if ((r -= HOURS[h]) <= 0) return h;
  return 23;
};

const REFERRERS = [
  [{ url: "https://www.google.com/", domain: "www.google.com" }, 38],
  [{ url: "https://l.instagram.com/", domain: "l.instagram.com" }, 22],
  [{ url: "https://www.tiktok.com/", domain: "www.tiktok.com" }, 9],
  [{ url: "https://www.facebook.com/", domain: "www.facebook.com" }, 6],
  [undefined, 25],
] as const;

async function history() {
  const rng = mulberry32(Number(args.seed));
  const from = Date.parse(`${args.from}T00:00:00Z`);
  const to = Date.parse(`${args.to}T00:00:00Z`) + DAY;
  const releases = RELEASES.map((r, i) =>
    i === RELEASES.length - 1 && args["current-sha"] ? { ...r, sha: args["current-sha"] } : r,
  );
  const out = args.out ?? join(ROOT, "data/posthog/events.jsonl");
  const file = jsonl(out);

  // Returning visitors come back from a recent pool and keep their account.
  const pool: { visitor: Visitor; hasAccount: boolean }[] = [];
  const sessions: { ts: number; sha: string; segment: string; completed: boolean; exitStep: string; swarm: false }[] = [];
  let eventCount = 0;

  for (let day = from; day < to; day += DAY) {
    const date = new Date(day);
    const progress = (day - from) / (to - from);
    const weekday = date.getUTCDay();
    // Newsletter with WELCOME10 every other Tuesday once promo codes exist
    const newsletter = day >= Date.parse("2026-08-05") && weekday === 2 && Math.floor(day / DAY / 7) % 2 === 0;
    const n = Math.round(
      (100 + 70 * progress) * (weekday === 0 || weekday === 6 ? 1.3 : weekday === 1 ? 0.9 : 1) * (0.85 + rng() * 0.3),
    );
    const dayEvents: PostHogEvent[] = [];
    for (let i = 0; i < n + (newsletter ? 60 : 0); i++) {
      const fromNewsletter = i >= n;
      const start = day + hourOf(rng) * 3_600_000 + Math.floor(rng() * 3_600_000);
      const release = releases[RELEASES.indexOf(releaseAt(start))];
      const returning = pool.length > 50 && rng() < (fromNewsletter ? 0.8 : 0.22);
      const entry = returning ? pool[Math.floor(rng() * pool.length)] : { visitor: newVisitor(rng, start), hasAccount: false };
      if (!returning) {
        pool.push(entry);
        if (pool.length > 4000) pool.shift();
      }
      const referrer = fromNewsletter
        ? { url: "https://mail.google.com/", domain: "mail.google.com", utm_campaign: "welcome10" }
        : (() => {
            let r = rng() * 100;
            for (const [ref, w] of REFERRERS) if ((r -= w) <= 0) return ref;
            return undefined;
          })();
      const segment = visitorSegment(entry.visitor);
      const result = simulateSession({
        rng,
        start,
        visitor: entry.visitor,
        host: PRODUCTION_HOST,
        buildSha: release.sha,
        traps: release.traps,
        profile: SEGMENT_PROFILES[segment],
        referrer,
        hasAccount: entry.hasAccount,
        promoCodes: start >= Date.parse("2026-08-05"),
      });
      if (result.createdAccount) entry.hasAccount = true;
      dayEvents.push(...result.events);
      sessions.push({ ts: start, sha: release.sha, segment, completed: result.completed, exitStep: result.exitStep, swarm: false });
    }
    dayEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    file.write(dayEvents);
    eventCount += dayEvents.length;
  }
  await file.close();

  const manifest = {
    kind: "history",
    seed: Number(args.seed),
    from: args.from,
    to: args.to,
    host: PRODUCTION_HOST,
    file: out.replace(ROOT + "/", ""),
    events: eventCount,
    sessions: sessions.length,
    orders: sessions.filter((s) => s.completed).length,
    releases,
    byRelease: summarize(sessions, releases),
  };
  writeFileSync(out.replace(/\.jsonl$/, ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${eventCount} events, ${sessions.length} sessions, ${manifest.orders} orders → ${manifest.file}`);
  for (const r of manifest.byRelease) {
    const segs = Object.entries(r.segments)
      .map(([s, m]) => `${s} ${(m.completionRate * 100).toFixed(1)}% (n=${m.sessions})`)
      .join(", ");
    console.log(`  ${r.date} ${r.name.padEnd(18)} ${segs}`);
  }
}

async function swarm() {
  const runId = args.swarm!;
  if (!args.sha || !args.host) throw new Error("--swarm needs --sha <preview build sha> and --host <preview host>");
  const intent = SWARM_INTENTS[args.flow];
  if (!intent) throw new Error(`unknown flow ${args.flow} (${Object.keys(SWARM_INTENTS).join(", ")})`);
  const fixed = new Set(args.fixed.split(",").filter(Boolean) as TrapId[]);
  const traps = RELEASES.at(-1)!.traps.filter((t) => !fixed.has(t));
  const [lo, hi] = args.seeds.split("-").map(Number);
  const seeds = Array.from({ length: (hi ?? lo) - lo + 1 }, (_, i) => lo + i);
  const start = args.start ? Date.parse(args.start) : Date.now();
  const out = args.out ?? join(ROOT, `data/posthog/swarm-${runId}.jsonl`);
  const file = jsonl(out);
  const results: { agent: string; persona: string; completed: boolean; exitStep: string }[] = [];
  const all: PostHogEvent[] = [];

  const personaIds = args.personas ? args.personas.split(",") : flowPersonas(FLOWS[args.flow]);
  for (const personaId of personaIds) {
    const persona = PERSONAS[personaId];
    if (!persona) throw new Error(`unknown persona ${personaId}`);
    for (const seed of seeds) {
      const agent = `${personaId}-${seed}`;
      const rng = mulberry32(seed * 7919 + personaId.charCodeAt(0));
      const visitor: Visitor = {
        distinctId: `swarm:${agent}`,
        device: persona.viewport.mobile ? "Mobile" : "Desktop",
        os: persona.viewport.mobile ? "iOS" : "Linux",
        browser: persona.viewport.mobile ? "Mobile Safari" : "Chrome",
        viewport: [persona.viewport.width, persona.viewport.height],
        fontScale: 1,
        prefersContrast: false,
      };
      const result = simulateSession({
        rng,
        start: start + Math.floor(rng() * 20_000),
        visitor,
        host: args.host,
        buildSha: args.sha,
        traps,
        profile: PERSONA_PROFILES[personaId],
        swarm: { run: runId, agent, persona: personaId },
        intent,
        promoCodes: true,
      });
      all.push(...result.events);
      results.push({ agent, persona: personaId, completed: result.completed, exitStep: result.exitStep });
    }
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  file.write(all);
  await file.close();
  writeFileSync(
    out.replace(/\.jsonl$/, ".manifest.json"),
    JSON.stringify({ kind: "swarm", runId, buildSha: args.sha, host: args.host, traps, fixed: [...fixed], agents: results }, null, 2) + "\n",
  );
  console.log(`${all.length} events from ${results.length} agents → ${out.replace(ROOT + "/", "")}`);
  for (const p of new Set(results.map((r) => r.persona))) {
    const rs = results.filter((r) => r.persona === p);
    console.log(`  ${p}: ${rs.filter((r) => r.completed).length}/${rs.length} completed`);
  }
}

await (args.swarm ? swarm() : history());
