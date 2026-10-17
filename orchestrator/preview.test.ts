import { describe, expect, it } from "vitest";
import { readBuildSha, StaleBuildError, waitForBuildSha } from "./preview";

const page = (sha: string) => `<html><head><meta name="build-sha" content="${sha}"/></head></html>`;
const fetchSequence = (...bodies: (string | null)[]) => {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return body === null ? new Response("", { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch;
};
const noSleep = async () => {};

describe("readBuildSha", () => {
  it("reads the meta tag", async () => {
    expect(await readBuildSha("https://x", fetchSequence(page("abc123")))).toBe("abc123");
  });
  it("is undefined on a 404 or missing tag", async () => {
    expect(await readBuildSha("https://x", fetchSequence(null))).toBeUndefined();
    expect(await readBuildSha("https://x", fetchSequence("<html></html>"))).toBeUndefined();
  });
});

describe("waitForBuildSha", () => {
  it("returns once the deploy serves the expected commit", async () => {
    const seen: (string | undefined)[] = [];
    await waitForBuildSha("https://x", "new", {
      fetchImpl: fetchSequence(null, page("old"), page("new")),
      sleep: noSleep,
      onPoll: (s) => seen.push(s),
    });
    expect(seen).toEqual([undefined, "old", "new"]);
  });

  it("throws rather than letting a swarm run against a stale build", async () => {
    await expect(
      waitForBuildSha("https://x", "new", { fetchImpl: fetchSequence(page("old")), timeoutMs: 0, sleep: noSleep }),
    ).rejects.toThrow(StaleBuildError);
  });
});
