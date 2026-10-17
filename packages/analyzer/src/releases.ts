import type { Release } from "@frictionswarm/shared";

/** Release names we know (the fake history's RELEASES in tools/posthog-sim/sim.ts; a test
 * keeps them in sync). Real storefront releases fall back to the short sha. */
export const KNOWN_RELEASES: Release[] = [
  { sha: "3b1f0c9e2a7d4b6f8c1e5a9d0b2c4e6f8a1b3c5d", date: "2026-04-01", name: "Simulated checkout" },
  { sha: "8e4d2a6c0b9f1e3a5c7d9b2f4a6c8e0d1b3f5a7c", date: "2026-05-20", name: "New product page" },
  { sha: "c7a9e1b3d5f7092a4c6e8b0d2f4a6c8e1b3d5f70", date: "2026-06-24", name: "Checkout redesign" },
  { sha: "5d2f8b4a6c0e1d3f5a7b9c2e4d6f8a0b1c3e5d7f", date: "2026-08-05", name: "Promo codes" },
  { sha: "f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1d3b5f7a9", date: "2026-09-09", name: "Accounts" },
];

export const shortSha = (sha: string) => sha.slice(0, 7);

/** A release's display name: known by sha; else a known release that shipped the day this
 * sha was first seen (the generator's --current-sha restamps the current release); else the short sha. */
export function releaseName(sha: string, firstSeenDate: string, known: Release[] = KNOWN_RELEASES): string {
  return known.find((r) => r.sha === sha)?.name ?? known.find((r) => r.date === firstSeenDate)?.name ?? shortSha(sha);
}

/** Releases as PostHog shows them: each production build_sha at the date it was first seen, oldest first. */
export function deriveReleases(firstSeen: Map<string, number>, known: Release[] = KNOWN_RELEASES): Release[] {
  return [...firstSeen]
    .sort((a, b) => a[1] - b[1])
    .map(([sha, ts]) => {
      const date = new Date(ts).toISOString().slice(0, 10);
      return { sha, date, name: releaseName(sha, date, known) };
    });
}

export type ReleaseRate = { release: Release; count: number; reached: number; rate: number };

export type AttributionOptions = {
  /** Smallest jump (absolute, 0–1) that counts. Default 0.02. */
  minJump?: number;
  /** A release needs this many sessions at the signal's step to be a candidate. Default 20. */
  minReached?: number;
  /** The first release whose jump is at least this share of the largest jump wins. Default 0.5. */
  share?: number;
};

/** The release that introduced a signal: the first release where its rate jumps against the
 * previous release. "Jumps" = at least `share` of the largest jump in the history (so noise
 * doesn't win), and at least `minJump`. The oldest release is compared against zero: a signal
 * already present when the history starts is attributed to it. */
export function attributeRelease(rates: ReleaseRate[], opts: AttributionOptions = {}): Release | undefined {
  const minJump = opts.minJump ?? 0.02;
  const minReached = opts.minReached ?? 20;
  const share = opts.share ?? 0.5;
  let prev = 0;
  const jumps = rates.map((r) => {
    const ok = r.reached >= minReached;
    const jump = ok ? r.rate - prev : -Infinity;
    if (ok) prev = r.rate;
    return jump;
  });
  const max = Math.max(...jumps);
  if (!(max >= minJump)) return undefined;
  const i = jumps.findIndex((j) => j >= Math.max(minJump, share * max));
  return rates[i]?.release;
}
