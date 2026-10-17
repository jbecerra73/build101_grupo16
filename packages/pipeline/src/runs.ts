import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const runsDir = () => process.env.RUNS_DIR ?? join(REPO_ROOT, "runs");

/** Sortable, unique: 2026-10-17T21-05-00-ab12 (UTC). */
export const newRunId = (now = new Date()) =>
  `${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${randomBytes(2).toString("hex")}`;

/** Atomic JSON write (tmp + rename) so pollers never read half a file. */
export async function writeJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

// runs/.usage.json: runs-per-day cap and a global seed counter, so every
// swarm (including retests) gets fresh seeds.
type Usage = { days: Record<string, number>; nextSeed: number };
const usageFile = (dir: string) => join(dir, ".usage.json");
const today = () => new Date().toISOString().slice(0, 10);
let lock: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
};
const loadUsage = async (dir: string): Promise<Usage> =>
  (await readJson<Usage>(usageFile(dir))) ?? { days: {}, nextSeed: 1 };

export class RunCapError extends Error {}

/** Count one run against today's cap; throws RunCapError when exceeded. */
export const reserveRun = (dir: string, maxPerDay: number) =>
  serial(async () => {
    const u = await loadUsage(dir);
    const used = u.days[today()] ?? 0;
    if (used >= maxPerDay) throw new RunCapError(`Run cap reached: ${used}/${maxPerDay} runs today`);
    u.days[today()] = used + 1;
    await writeJson(usageFile(dir), u);
    return used + 1;
  });

/** Allocate `count` never-used seeds. */
export const allocateSeeds = (dir: string, count: number) =>
  serial(async () => {
    const u = await loadUsage(dir);
    const seeds = Array.from({ length: count }, (_, i) => u.nextSeed + i);
    u.nextSeed += count;
    await writeJson(usageFile(dir), u);
    return seeds;
  });
