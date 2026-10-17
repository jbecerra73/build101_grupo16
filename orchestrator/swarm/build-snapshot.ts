// Build the tenki snapshot every swarm sandbox boots from:
//
//   npm run swarm:snapshot -- [--ref main | --local] [--disk-gb 20]
//   → prints the snapshot id; put it in .env as TENKI_SNAPSHOT_ID
//
// What goes in (all under /home/tenki; /tmp is wiped on pause):
//   - this repo at --ref (or, with --local, this checkout's HEAD uploaded as a tarball) in /home/tenki/frictionswarm, with `npm ci` (the worker runs from it)
//   - Playwright's Chromium in the same VM: `npx playwright install chromium` as the tenki user,
//     plus its system libraries (`playwright install-deps`, as root)
//   - Claude Code (`claude`), which the base image is expected to ship; installed if missing
//   - a ≥ 20 GB root disk (fixed at create time; sandboxes from the snapshot inherit it)
// and a smoke test that launches Chromium WITH its sandbox (no --no-sandbox), as the worker does.
//
// The snapshot freezes the worker code: rebuild it after changing worker/ or shared/.
// Needs TENKI_API_KEY. Unverified without a tenki account (written against SDK v1.4 types/README).
import { isDiskExhausted, TenkiSandbox, type Session } from "@tenkicloud/sandbox";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { REPO_DIR } from "./tenki";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "https://github.com/jbecerra73/build101_grupo16" },
    ref: { type: "string", default: "main" },
    /** Upload this checkout's HEAD (committed files only) instead of cloning --ref. */
    local: { type: "boolean", default: false },
    "disk-gb": { type: "string", default: "20" },
    name: { type: "string" },
  },
});
const diskGb = Number(args["disk-gb"]);
if (!(diskGb >= 20)) throw new Error("The swarm snapshot needs at least 20 GB of disk");

const decoder = new TextDecoder();

async function sh(session: Session, cmd: string, o: { privileged?: boolean; timeoutMs?: number } = {}) {
  console.log(`$ ${cmd}`);
  // bash -c, not -lc: a login shell's cd would override cwd.
  const r = await session.run(["bash", "-c", cmd], { cwd: "/home/tenki", privileged: o.privileged, timeoutMs: o.timeoutMs ?? 20 * 60_000 });
  const out = (decoder.decode(r.stdout) + decoder.decode(r.stderr)).trim();
  if (out) console.log(out.split("\n").slice(-15).join("\n"));
  if (r.disk && isDiskExhausted(r.disk)) throw new Error(`Disk exhausted during: ${cmd}`);
  if (r.timedOut || r.exitCode !== 0) throw new Error(`${r.timedOut ? "Timed out" : `Exit ${r.exitCode}`}: ${cmd}`);
  return decoder.decode(r.stdout).trim();
}

const client = new TenkiSandbox();
const session = await client.create({
  name: "frictionswarm-snapshot-build",
  cpuCores: 4,
  memoryMb: 8192,
  diskSizeGb: diskGb,
  maxDurationMs: 60 * 60_000,
  tags: ["frictionswarm", "snapshot-build"],
});
console.log(`build sandbox ${session.id}`);

let closed = false;
const close = async () => {
  if (closed) return;
  closed = true;
  await session.close().catch((err) => console.error(`Failed to close ${session.id}; close it by hand: ${err}`));
};
process.on("SIGINT", () => void close().then(() => process.exit(130)));

try {
  const node = await sh(session, "node --version");
  if (Number(node.replace(/^v/, "").split(".")[0]) < 22) throw new Error(`Node ${node} in the base image; the worker needs Node >= 22`);
  if (args.local) {
    const tar = execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
    await session.writeFile("/home/tenki/frictionswarm.tar.gz", tar);
    await sh(session, `rm -rf ${REPO_DIR} && mkdir -p ${REPO_DIR} && tar -xzf /home/tenki/frictionswarm.tar.gz -C ${REPO_DIR} && rm /home/tenki/frictionswarm.tar.gz`);
  } else await sh(session, `rm -rf ${REPO_DIR} && git clone --depth 1 --branch ${args.ref} ${args.repo} ${REPO_DIR}`);
  await sh(session, `cd ${REPO_DIR} && npm ci --no-audit --no-fund`);
  await sh(session, `cd ${REPO_DIR} && npx playwright install-deps chromium`, { privileged: true });
  await sh(session, `cd ${REPO_DIR} && npx playwright install chromium`);
  await sh(session, "command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code", { privileged: true });
  await sh(session, "claude --version");
  await sh(
    session,
    `cd ${REPO_DIR} && node --input-type=module -e "import { chromium } from 'playwright'; const b = await chromium.launch({ chromiumSandbox: true }); const p = await b.newPage(); await p.goto('about:blank'); await b.close(); console.log('chromium (sandboxed) ok')"`,
  );
  await sh(session, "npm cache clean --force && df -h / /home/tenki");
  const sha = args.local ? execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim() : (await sh(session, `git -C ${REPO_DIR} rev-parse --short HEAD`)).slice(0, 12);

  const snapshot = await client.createSnapshotAndWait(session.id, { name: args.name ?? `frictionswarm-swarm-${sha}`, timeoutMs: 30 * 60_000 });
  if (snapshot.state !== "READY") throw new Error(`Snapshot ${snapshot.id} is ${snapshot.state}: ${snapshot.failureReason ?? ""}`);
  console.log(`\nsnapshot ${snapshot.id} (${snapshot.name}, ${snapshot.diskSizeGb} GB disk)\nTENKI_SNAPSHOT_ID=${snapshot.id}`);
} finally {
  await close();
}
process.exit(process.exitCode ?? 0);
