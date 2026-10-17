// tenki.cloud sandboxes (@tenkicloud/sandbox). Each sandbox boots from the swarm snapshot
// (see build-snapshot.ts: this repo at /home/tenki/frictionswarm with node_modules, Playwright's
// Chromium and Claude Code). Auth: TENKI_API_KEY or TENKI_AUTH_TOKEN, read by the SDK.
//
// Unverified without a tenki account: written against the SDK's published types and README
// (v1.4.x), not run against the service.
import { TenkiSandbox, type ProcessRunHandle, type Session } from "@tenkicloud/sandbox";
import { SANDBOX_HOME, type Sandbox, type SandboxCreateOptions, type SandboxProcess, type SandboxProvider } from "./provider";

export const REPO_DIR = `${SANDBOX_HOME}/frictionswarm`;

export type TenkiProviderOptions = {
  /** Snapshot built by build-snapshot.ts (TENKI_SNAPSHOT_ID). */
  snapshotId: string;
  cpuCores?: number;
  memoryMb?: number;
  /** Hard stop on tenki's side, in case this process dies without closing (failed sessions still bill). */
  maxDurationMs?: number;
  log?: (line: string) => void;
};

const decoder = new TextDecoder();

/** Streams a process's output to the log, line by line, keeping the tail. */
async function pump(stream: ReadableStream<Uint8Array>, prefix: string, log: (line: string) => void, tail: { text: string }) {
  const reader = stream.getReader();
  let partial = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = partial + decoder.decode(value, { stream: true });
      tail.text = (tail.text + text).slice(-4000);
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(`  [${prefix}] ${line}`);
    }
  } catch {
    // The stream ends with the process (or the session).
  } finally {
    reader.releaseLock();
  }
}

class TenkiBox implements Sandbox {
  private closing?: Promise<void>;
  private readonly procs = new Set<ProcessRunHandle>();

  constructor(private readonly session: Session, private readonly log: (line: string) => void) {}

  get id() {
    return this.session.id;
  }

  writeFile(path: string, data: string | Uint8Array) {
    return this.session.writeFile(path, data);
  }

  async readFile(path: string) {
    try {
      return await this.session.readFile(path);
    } catch {
      // Missing file (or a transient error); the caller polls again.
      return undefined;
    }
  }

  start(argv: string[], o: { cwd: string; env?: Record<string, string> }): SandboxProcess {
    // Keep the handle: the process lives as long as its Run stream (tenki kills it otherwise).
    const handle = this.session.run(argv, { cwd: o.cwd, env: o.env });
    this.procs.add(handle);
    const tail = { text: "" };
    const pumped = Promise.all([pump(handle.stdout, this.id, this.log, tail), pump(handle.stderr, this.id, this.log, tail)]);
    const done = Promise.resolve(handle)
      .then(
        async (r) => {
          await pumped;
          return { exitCode: r.timedOut ? 124 : r.exitCode, output: tail.text };
        },
        (err: unknown) => ({ exitCode: 1, output: `${tail.text}\n${err instanceof Error ? err.message : err}` }),
      )
      .finally(() => this.procs.delete(handle));
    return {
      done,
      stop: async () => {
        await handle.signal("SIGTERM").catch(() => {});
        const kill = setTimeout(() => void handle.kill().catch(() => {}), 10_000);
        await done;
        clearTimeout(kill);
      },
    };
  }

  close() {
    this.closing ??= (async () => {
      for (const p of this.procs) await p.signal("SIGTERM").catch(() => {});
      await this.session.close();
    })();
    return this.closing;
  }
}

export class TenkiSandboxProvider implements SandboxProvider {
  readonly name = "tenki";
  readonly repoDir = REPO_DIR;
  private readonly client: TenkiSandbox;

  constructor(private readonly o: TenkiProviderOptions) {
    if (!process.env.TENKI_API_KEY?.trim() && !process.env.TENKI_AUTH_TOKEN?.trim()) throw new Error("Set TENKI_API_KEY (or TENKI_AUTH_TOKEN) to use tenki sandboxes");
    if (!o.snapshotId) throw new Error("No swarm snapshot: build one with `npm run swarm:snapshot` and set TENKI_SNAPSHOT_ID");
    this.client = new TenkiSandbox({ warningHandler: null });
  }

  async create(o: SandboxCreateOptions): Promise<Sandbox> {
    const session = await this.client.create({
      name: o.name,
      snapshotId: this.o.snapshotId,
      // 6 Chromium contexts + 6 `claude` + 6 MCP servers.
      cpuCores: this.o.cpuCores ?? 4,
      memoryMb: this.o.memoryMb ?? 8192,
      maxDurationMs: this.o.maxDurationMs ?? 45 * 60_000,
      env: o.env,
      tags: ["frictionswarm", "swarm"],
      // We expose no ports; agents only reach out (to the preview, PostHog and Anthropic).
      allowInbound: false,
    });
    return new TenkiBox(session, this.o.log ?? console.log);
  }
}
