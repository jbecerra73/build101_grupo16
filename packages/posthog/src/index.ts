// @frictionswarm/posthog: the analyzer's only door to PostHog (SPEC.md, PostHog source).
//   createPostHogSource()            POSTHOG_SOURCE=file (default) | api
//   file   data/posthog/events.jsonl + swarm-<runId>.jsonl, streamed (POSTHOG_DATA_DIR)
//   api    HogQL over POST {POSTHOG_HOST}/api/projects/{POSTHOG_PROJECT_ID}/query
//          with POSTHOG_PERSONAL_API_KEY
//   snapshot(events, runDir)         writes runs/<id>/posthog.jsonl
//   snapshotSource(runDir)           replays a past run offline
import type { PostHogSourceKind } from "@frictionswarm/shared";
import { apiSource, type ApiSourceOptions } from "./api";
import { defaultDataDir, fileSource, type FileSourceOptions } from "./file";
import type { DescribedSource } from "./source";

export * from "./source";
export * from "./file";
export * from "./api";
export * from "./snapshot";

export type PostHogSourceOptions = FileSourceOptions & ApiSourceOptions;

/** A source for `kind`, defaulting to POSTHOG_SOURCE, then "file". */
export function createPostHogSource(kind?: PostHogSourceKind, opts: PostHogSourceOptions = {}): DescribedSource {
  const env = opts.env ?? process.env;
  const k = kind ?? ((env.POSTHOG_SOURCE || undefined) as PostHogSourceKind | undefined) ?? "file";
  if (k === "file") return fileSource({ ...opts, dataDir: opts.dataDir ?? defaultDataDir(env) });
  if (k === "api") return apiSource(opts);
  throw new Error(`unknown POSTHOG_SOURCE ${k} (file | api)`);
}
