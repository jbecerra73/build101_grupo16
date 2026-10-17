// Imports a generated JSONL file into a real PostHog project through the
// `/batch` capture endpoint with historical timestamps.
//
//   POSTHOG_PROJECT_KEY=phc_... npm run posthog:upload -- data/posthog/events.jsonl [--dry-run]
//
// POSTHOG_HOST defaults to https://us.i.posthog.com. Uploading the same file
// twice stores duplicates until ClickHouse merges them (PostHog dedupes on uuid
// only eventually); the api source drops duplicate rows when it reads.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean", default: false }, "batch-size": { type: "string", default: "1000" } },
});
const file = positionals[0];
if (!file) throw new Error("usage: upload <events.jsonl> [--dry-run]");
const key = process.env.POSTHOG_PROJECT_KEY;
if (!key && !values["dry-run"]) throw new Error("POSTHOG_PROJECT_KEY is not set");
const host = (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");
const size = Number(values["batch-size"]);

async function send(batch: unknown[]) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${host}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, historical_migration: true, batch }),
    });
    if (res.ok) return;
    if (attempt === 5 || res.status < 500) throw new Error(`PostHog ${res.status}: ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

let batch: unknown[] = [];
let sent = 0;
for await (const line of createInterface({ input: createReadStream(file) })) {
  if (!line.trim()) continue;
  batch.push(JSON.parse(line));
  if (batch.length === size) {
    if (!values["dry-run"]) await send(batch);
    sent += batch.length;
    batch = [];
    if (sent % 50_000 === 0) console.log(`${sent} events`);
  }
}
if (batch.length) {
  if (!values["dry-run"]) await send(batch);
  sent += batch.length;
}
console.log(`${values["dry-run"] ? "would send" : "sent"} ${sent} events to ${host}`);
