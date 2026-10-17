const BUILD_SHA_META = /<meta\s+name="build-sha"\s+content="([^"]*)"/i;

/** The commit a storefront deploy serves, from its build-sha meta tag. */
export async function readBuildSha(url: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const res = await fetchImpl(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) return undefined;
  return (await res.text()).match(BUILD_SHA_META)?.[1];
}

export class StaleBuildError extends Error {}

/** Poll until `url` serves `sha`, so a swarm never runs against a stale build. */
export async function waitForBuildSha(
  url: string,
  sha: string,
  {
    timeoutMs = 10 * 60_000,
    intervalMs = 10_000,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    onPoll,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<unknown>;
    onPoll?: (seen: string | undefined) => void;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string | undefined;
  while (true) {
    seen = await readBuildSha(url, fetchImpl).catch(() => undefined);
    onPoll?.(seen);
    if (seen === sha) return;
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  throw new StaleBuildError(`${url} still serves ${seen ?? "nothing"} after ${timeoutMs / 1000}s, expected ${sha}`);
}
