// A small file that enforces the daily swarm cap and hands out fresh seeds, so no two runs
// replay the same persona × seed. Default: runs/.swarm-ledger.json (gitignored).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FIRST_SEED = 1001;
const KEEP_DAYS = 14;

type Ledger = {
  /** UTC day (YYYY-MM-DD) → runIds started that day, failed and aborted ones included. */
  days: Record<string, string[]>;
  /** Next unused seed. */
  nextSeed: number;
};

export class DailyCapError extends Error {
  constructor(readonly day: string, readonly cap: number, readonly runIds: string[]) {
    super(`Daily swarm cap reached: ${runIds.length}/${cap} runs on ${day} (${runIds.join(", ")}). Raise SWARM_DAILY_CAP or wait until tomorrow (UTC).`);
  }
}

function read(file: string): Ledger {
  if (!existsSync(file)) return { days: {}, nextSeed: FIRST_SEED };
  const l = JSON.parse(readFileSync(file, "utf8")) as Partial<Ledger>;
  return { days: l.days ?? {}, nextSeed: l.nextSeed ?? FIRST_SEED };
}

/** Records a run against today's cap and reserves `seeds` fresh seeds for it.
 * Throws DailyCapError (and records nothing) once `cap` runs were started today. */
export function claimRun(file: string, o: { runId: string; cap: number; seeds: number; now?: Date }): { firstSeed: number; runsToday: number } {
  if (!Number.isInteger(o.cap) || o.cap < 0) throw new Error(`Invalid daily cap ${o.cap}`);
  const ledger = read(file);
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
  const today = ledger.days[day] ?? [];
  if (today.length >= o.cap) throw new DailyCapError(day, o.cap, today);
  const firstSeed = ledger.nextSeed;
  ledger.days[day] = [...today, o.runId];
  ledger.nextSeed += o.seeds;
  for (const d of Object.keys(ledger.days).sort().slice(0, -KEEP_DAYS)) delete ledger.days[d];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
  return { firstSeed, runsToday: today.length + 1 };
}

/** The seed the next claimed run would start at (for dry runs; reserves nothing). */
export function peekNextSeed(file: string) {
  return read(file).nextSeed;
}
