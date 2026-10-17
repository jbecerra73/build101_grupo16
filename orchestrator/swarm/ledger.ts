// A small file that hands out fresh seeds, so no two runs replay the same persona × seed.
// Default: runs/.swarm-ledger.json (gitignored).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FIRST_SEED = 1001;

type Ledger = {
  /** Next unused seed. */
  nextSeed: number;
};

function read(file: string): Ledger {
  if (!existsSync(file)) return { nextSeed: FIRST_SEED };
  const l = JSON.parse(readFileSync(file, "utf8")) as Partial<Ledger>;
  return { nextSeed: l.nextSeed ?? FIRST_SEED };
}

/** Reserves `seeds` fresh seeds and returns the first one. */
export function reserveSeeds(file: string, seeds: number): number {
  const ledger = read(file);
  const firstSeed = ledger.nextSeed;
  ledger.nextSeed += seeds;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
  return firstSeed;
}

/** The seed the next run would start at (for dry runs; reserves nothing). */
export function peekNextSeed(file: string) {
  return read(file).nextSeed;
}
