import { isSwarm, type PostHogEvent } from "@frictionswarm/shared";
import { PRODUCTION_HOST, pollSwarm } from "./file";
import { windowBounds, type DescribedSource } from "./source";

export type ApiSourceOptions = {
  /** POSTHOG_HOST, e.g. https://us.posthog.com (the API host, not the ingestion host). */
  host?: string;
  /** POSTHOG_PROJECT_ID */
  projectId?: string;
  /** POSTHOG_PERSONAL_API_KEY (scope: query:read). */
  apiKey?: string;
  /** Production storefront host for real-user queries; null keeps every host. */
  storeHost?: string | null;
  /** Rows per HogQL page. Default 5000. */
  pageSize?: number;
  /** waitForSwarm polling interval. Default 5000 ms (ingestion lags ~30–90 s). */
  pollMs?: number;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
};

/** HogQL string literal. */
export const hogqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** HogQL DateTime literal from epoch ms. */
const hogqlTime = (ms: number) => `toDateTime64(${hogqlString(new Date(ms).toISOString().replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;

const COLUMNS = "uuid, event, distinct_id, timestamp, properties";

/** A HogQL result row → PostHogEvent (properties may come back as a JSON string). */
export function rowToEvent(row: unknown[]): PostHogEvent {
  const [uuid, event, distinctId, timestamp, properties] = row;
  const props = typeof properties === "string" ? JSON.parse(properties) : (properties ?? {});
  const ts = new Date(String(timestamp).replace(" ", "T").replace(/(?<!Z|[+-]\d\d:?\d\d)$/, "Z"));
  return {
    uuid: String(uuid),
    event: String(event),
    distinct_id: String(distinctId),
    timestamp: Number.isNaN(ts.getTime()) ? String(timestamp) : ts.toISOString(),
    properties: props,
  };
}

/** PostHog over HogQL: POST {host}/api/projects/{id}/query. */
export function apiSource(opts: ApiSourceOptions = {}): DescribedSource {
  const env = opts.env ?? process.env;
  const host = (opts.host ?? env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/+$/, "");
  const projectId = opts.projectId ?? env.POSTHOG_PROJECT_ID;
  const apiKey = opts.apiKey ?? env.POSTHOG_PERSONAL_API_KEY;
  const storeHost = opts.storeHost === undefined ? PRODUCTION_HOST : opts.storeHost;
  const pageSize = opts.pageSize ?? 5000;
  const doFetch = opts.fetch ?? fetch;

  async function query(hogql: string): Promise<unknown[][]> {
    if (!projectId || !apiKey) throw new Error("api source needs POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY");
    const res = await doFetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql }, name: "frictionswarm" }),
    });
    if (!res.ok) throw new Error(`PostHog query failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { results?: unknown[][] };
    return body.results ?? [];
  }

  /** Page through `where` ordered by (timestamp, uuid) with LIMIT/OFFSET. */
  async function* events(where: string[], keep: (e: PostHogEvent) => boolean): AsyncGenerator<PostHogEvent> {
    for (let offset = 0; ; offset += pageSize) {
      const rows = await query(
        `SELECT ${COLUMNS} FROM events WHERE ${where.join(" AND ")} ORDER BY timestamp, uuid LIMIT ${pageSize} OFFSET ${offset}`,
      );
      for (const row of rows) {
        const e = rowToEvent(row);
        if (keep(e)) yield e;
      }
      if (rows.length < pageSize) return;
    }
  }

  return {
    kind: "api",
    description: `api ${host} project ${projectId ?? "?"}`,
    realUserEvents(q) {
      const { from, to } = windowBounds(q);
      const where = [`timestamp >= ${hogqlTime(from)}`, `timestamp < ${hogqlTime(to)}`, "isNull(properties.swarm_run)"];
      if (storeHost) where.push(`properties.$host = ${hogqlString(storeHost)}`);
      if (q.buildSha) where.push(`properties.build_sha = ${hogqlString(q.buildSha)}`);
      // Belt and braces: swarm traffic never reaches real-user metrics.
      return events(where, (e) => !isSwarm(e));
    },
    swarmEvents(q) {
      return events(
        [`properties.swarm_run = ${hogqlString(q.runId)}`, `properties.build_sha = ${hogqlString(q.buildSha)}`],
        (e) => e.properties.swarm_run === q.runId,
      );
    },
    waitForSwarm(q) {
      return pollSwarm(q, opts.pollMs ?? 5000, async () => {
        const rows = await query(
          `SELECT DISTINCT properties.swarm_agent FROM events WHERE properties.swarm_run = ${hogqlString(q.runId)} ` +
            `AND event IN ('swarm_done', 'swarm_give_up') LIMIT 10000`,
        );
        return new Set(rows.map((r) => String(r[0])));
      });
    },
  };
}
