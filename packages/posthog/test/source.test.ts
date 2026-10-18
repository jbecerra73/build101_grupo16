import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PostHogEvent } from "@frictionswarm/shared";
import {
  apiSource,
  createPostHogSource,
  fileSource,
  lineTimestamp,
  rowToEvent,
  snapshot,
  snapshotSource,
  SwarmTimeoutError,
  windowBounds,
} from "../src";

const HOST = "swarm-ecommerce.netlify.app";
let n = 0;
const ev = (event: string, timestamp: string, props: Record<string, unknown> = {}): PostHogEvent => ({
  uuid: `u${++n}`,
  event,
  distinct_id: (props.swarm_agent as string) ? `swarm:${props.swarm_agent}` : "d1",
  timestamp,
  properties: { $session_id: "s1", $host: HOST, $current_url: `https://${HOST}/`, build_sha: "prod", ...props },
});
const swarmTag = (agent: string) => ({ swarm_run: "r1", swarm_agent: agent, swarm_persona: agent.split("-")[0], build_sha: "prev", $host: "preview" });

const HISTORY = [
  ev("$pageview", "2026-10-01T10:00:00.000Z"),
  ev("$pageview", "2026-10-02T10:00:00.000Z", { build_sha: "old" }),
  ev("$pageview", "2026-10-03T10:00:00.000Z", swarmTag("rosa-1")), // swarm traffic in the history file
  ev("$pageview", "2026-10-03T11:00:00.000Z", { $host: "deploy-preview-3--x.netlify.app" }),
  ev("$pageview", "2026-10-04T23:59:59.999Z"),
  ev("$pageview", "2026-10-05T00:00:00.000Z"),
];

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "posthog-"));
  writeFileSync(join(dir, "events.jsonl"), HISTORY.map((e) => JSON.stringify(e)).join("\n") + "\n{half-written");
  return dir;
}
const collect = async (it: AsyncIterable<PostHogEvent>) => {
  const out: PostHogEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe("windowBounds", () => {
  it("treats a date-only `to` as the end of that day", () => {
    const w = windowBounds({ from: "2026-10-01", to: "2026-10-04" });
    expect(new Date(w.from).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(new Date(w.to).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(windowBounds({ from: "2026-10-01T00:00:00Z", to: "2026-10-04T12:00:00Z" }).to).toBe(Date.parse("2026-10-04T12:00:00Z"));
  });
  it("reads the top-level timestamp without parsing", () => {
    expect(lineTimestamp(JSON.stringify(HISTORY[0]))).toBe(Date.parse(HISTORY[0].timestamp));
    expect(lineTimestamp('{"properties":{"timestamp":"2020-01-01"},"timestamp":"2026-01-01"}')).toBeUndefined();
  });
});

describe("file source", () => {
  it("streams real users on the production host in [from, to), never swarm traffic", async () => {
    const src = fileSource({ dataDir: dataDir() });
    const got = await collect(src.realUserEvents({ from: "2026-10-01", to: "2026-10-04" }));
    expect(got.map((e) => e.timestamp)).toEqual([
      "2026-10-01T10:00:00.000Z",
      "2026-10-02T10:00:00.000Z",
      "2026-10-04T23:59:59.999Z",
    ]);
    const prod = await collect(src.realUserEvents({ from: "2026-10-01", to: "2026-10-06", buildSha: "prod" }));
    expect(prod).toHaveLength(3);
    expect(prod.some((e) => e.properties.swarm_run)).toBe(false);
    const allHosts = await collect(fileSource({ dataDir: dataDir(), host: null }).realUserEvents({ from: "2026-10-03", to: "2026-10-03" }));
    expect(allHosts.map((e) => e.properties.$host)).toEqual(["deploy-preview-3--x.netlify.app"]);
  });

  it("reads one swarm run's tracks on a build", async () => {
    const dir = dataDir();
    writeFileSync(
      join(dir, "swarm-r1.jsonl"),
      [ev("$pageview", "2026-10-17T10:00:00Z", swarmTag("rosa-1")), ev("$pageview", "2026-10-17T10:00:01Z", { ...swarmTag("kai-1"), build_sha: "other" })]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const got = await collect(fileSource({ dataDir: dir }).swarmEvents({ runId: "r1", buildSha: "prev" }));
    expect(got.map((e) => e.properties.swarm_agent)).toEqual(["rosa-1"]);
    expect(await collect(fileSource({ dataDir: dir }).swarmEvents({ runId: "nope", buildSha: "prev" }))).toEqual([]);
  });

  it("waitForSwarm resolves once every agent is done, else times out listing the missing ones", async () => {
    const dir = dataDir();
    const file = join(dir, "swarm-r1.jsonl");
    writeFileSync(file, JSON.stringify(ev("swarm_done", "2026-10-17T10:00:00Z", swarmTag("rosa-1"))) + "\n");
    const src = fileSource({ dataDir: dir, pollMs: 10 });
    const err = await src.waitForSwarm({ runId: "r1", agentIds: ["rosa-1", "kai-1", "typical-1"], timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(SwarmTimeoutError);
    expect(err.missing).toEqual(["kai-1", "typical-1"]);
    expect(err.message).toMatch(/kai-1, typical-1/);

    const waiting = src.waitForSwarm({ runId: "r1", agentIds: ["rosa-1", "kai-1"], timeoutMs: 2000 });
    setTimeout(() => appendFileSync(file, JSON.stringify(ev("swarm_give_up", "2026-10-17T10:00:09Z", swarmTag("kai-1"))) + "\n"), 30);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("is the default kind, configurable through env", async () => {
    const dir = dataDir();
    const src = createPostHogSource(undefined, { env: { POSTHOG_DATA_DIR: dir } });
    expect(src.kind).toBe("file");
    expect(await collect(src.realUserEvents({ from: "2026-10-01", to: "2026-10-01" }))).toHaveLength(1);
    expect(createPostHogSource(undefined, { env: { POSTHOG_SOURCE: "api" } }).kind).toBe("api");
  });
});

describe("snapshot", () => {
  it("writes posthog.jsonl and replays it with the same filters", async () => {
    const run = mkdtempSync(join(tmpdir(), "run-"));
    expect(await snapshot(HISTORY, run)).toBe(HISTORY.length);
    expect(readFileSync(join(run, "posthog.jsonl"), "utf8").trim().split("\n")).toHaveLength(HISTORY.length);
    const src = snapshotSource(run);
    const real = await collect(src.realUserEvents({ from: "2026-10-01", to: "2026-10-31" }));
    expect(real).toHaveLength(HISTORY.length - 1); // swarm excluded; hosts kept
    expect((await collect(src.swarmEvents({ runId: "r1", buildSha: "prev" }))).length).toBe(1);
    // Re-snapshotting from the snapshot itself is safe
    expect(await snapshot(src.realUserEvents({ from: "2026-10-01", to: "2026-10-31" }), run)).toBe(HISTORY.length - 1);
  });
});

describe("api source", () => {
  type Call = { url: string; auth: string; query: string };
  function mockFetch(pages: (q: string) => unknown[][]) {
    const calls: Call[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const query = JSON.parse(String(init.body)).query.query as string;
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, query });
      return new Response(JSON.stringify({ results: pages(query) }), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const row = (e: PostHogEvent) => [e.uuid, e.event, e.distinct_id, e.timestamp.replace("T", " ").replace("Z", ""), JSON.stringify(e.properties)];
  const env = { POSTHOG_APP_HOST: "https://eu.posthog.com/", POSTHOG_PROJECT_ID: "42", POSTHOG_PERSONAL_API_KEY: "phx_test" };

  it("paginates HogQL by keyset (no OFFSET: personal API keys reject it) and maps rows, excluding swarm traffic", async () => {
    const rows = HISTORY.map(row);
    const { f, calls } = mockFetch((q) => {
      const after = /toString\(uuid\) > '([^']+)'/.exec(q)?.[1];
      const start = after ? rows.findIndex((r) => r[0] === after) + 1 : 0;
      return rows.slice(start, start + 2);
    });
    const got = await collect(apiSource({ env, fetch: f, pageSize: 2 }).realUserEvents({ from: "2026-10-01", to: "2026-10-05", buildSha: "prod" }));
    expect(calls.map((c) => c.query)).not.toContainEqual(expect.stringMatching(/OFFSET/));
    expect(calls).toHaveLength(4);
    expect(calls[1].query).toContain(
      `(timestamp > toDateTime64('${rows[1][3]}', 6, 'UTC') OR (timestamp = toDateTime64('${rows[1][3]}', 6, 'UTC') AND toString(uuid) > '${rows[1][0]}'))`,
    );
    expect(calls[0].query).toMatch(/ORDER BY timestamp, toString\(uuid\) LIMIT 2$/);
    // Merges dedupe uuids only eventually: the source drops the duplicate rows PostHog still returns.
    const dup = mockFetch((q) => (/toString\(uuid\) >/.test(q) ? [] : [rows[0], rows[0], rows[1]]));
    expect(await collect(apiSource({ env, fetch: dup.f }).realUserEvents({ from: "2026-10-01", to: "2026-10-05" }))).toEqual(HISTORY.slice(0, 2));
    expect(calls[0].url).toBe("https://eu.posthog.com/api/projects/42/query");
    expect(calls[0].auth).toBe("Bearer phx_test");
    expect(calls[0].query).toMatch(/isNull\(properties\.swarm_run\)/);
    expect(calls[0].query).toMatch(/properties\.\$host = 'swarm-ecommerce\.netlify\.app'/);
    expect(calls[0].query).toMatch(/properties\.build_sha = 'prod'/);
    expect(calls[0].query).toMatch(/timestamp < toDateTime64\('2026-10-06 00:00:00\.000', 3, 'UTC'\)/);
    // The mock ignores WHERE, so the swarm row comes back; the source still drops it.
    expect(got).toHaveLength(HISTORY.length - 1);
    expect(got[0]).toEqual(HISTORY[0]);
  });

  it("queries a swarm run and polls until every agent is done", async () => {
    let polls = 0;
    const { f, calls } = mockFetch((q) => {
      if (q.includes("DISTINCT")) return ++polls < 3 ? [["rosa-1"]] : [["rosa-1"], ["kai-1"]];
      return [row(ev("$pageview", "2026-10-17T10:00:00Z", swarmTag("rosa-1")))];
    });
    const src = apiSource({ env, fetch: f, pollMs: 5 });
    expect(await collect(src.swarmEvents({ runId: "r1", buildSha: "prev" }))).toHaveLength(1);
    expect(calls[0].query).toMatch(/properties\.swarm_run = 'r1' AND properties\.build_sha = 'prev'/);
    await src.waitForSwarm({ runId: "r1", agentIds: ["rosa-1", "kai-1"], timeoutMs: 1000 });
    expect(polls).toBe(3);
    const err = await src.waitForSwarm({ runId: "r1", agentIds: ["rosa-1", "typical-9"], timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(SwarmTimeoutError);
    expect(err.missing).toEqual(["typical-9"]);
  });

  it("escapes literals and reports HTTP errors", async () => {
    const f = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(collect(apiSource({ env, fetch: f }).swarmEvents({ runId: "x' OR 1=1 --", buildSha: "s" }))).rejects.toThrow(/HTTP 403/);
    const { f: ok, calls } = mockFetch(() => []);
    await collect(apiSource({ env, fetch: ok }).swarmEvents({ runId: "x' OR 1=1 --", buildSha: "s" }));
    expect(calls[0].query).toContain("'x\\' OR 1=1 --'");
  });

  it("normalizes PostHog timestamps", () => {
    expect(rowToEvent(["u", "e", "d", "2026-10-01 10:00:00.123000", "{}"]).timestamp).toBe("2026-10-01T10:00:00.123Z");
    expect(rowToEvent(["u", "e", "d", "2026-10-01T10:00:00+00:00", { a: 1 }]).properties).toEqual({ a: 1 });
  });
});
