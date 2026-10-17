// An in-memory SandboxProvider for tests: no VMs, no browsers. Each sandbox's worker is a
// script that writes files (screenshots, agent results) the way the real worker would.
import type { SwarmAgentResult } from "../../shared";
import type { SwarmWorkerInput } from "../../worker/swarm";
import { SANDBOX_HOME, type Sandbox, type SandboxCreateOptions, type SandboxProcess, type SandboxProvider } from "./provider";

export type FakeWorker = (ctx: {
  sandbox: FakeSandbox;
  input: SwarmWorkerInput;
  /** `--runs` from the worker's argv. */
  runsDir: string;
  /** Aborted by stop() or close(). */
  signal: AbortSignal;
}) => Promise<number>;

/** Writes a screenshot and a success result for every agent, then exits 0. */
export const finishingWorker: FakeWorker = async ({ sandbox, input, runsDir }) => {
  for (const { personaId, seed } of input.agents) {
    const agentId = `${personaId}-${seed}`;
    await sandbox.writeFile(`${runsDir}/${input.runId}/screenshots/${agentId}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const now = new Date().toISOString();
    const result: SwarmAgentResult = { runId: input.runId, agentId, personaId, seed, outcome: "success", actions: 12, startedAt: now, endedAt: now };
    await sandbox.writeFile(`${runsDir}/${input.runId}/agents/${agentId}.json`, JSON.stringify(result));
  }
  return 0;
};

/** Never exits on its own; resolves (exit 143) once stopped. */
export const hangingWorker: FakeWorker = ({ signal }) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(143);
    signal.addEventListener("abort", () => resolve(143), { once: true });
  });

export class FakeSandbox implements Sandbox {
  readonly files = new Map<string, Uint8Array>();
  readonly started: { argv: string[]; cwd: string; stopped: boolean }[] = [];
  closeCalls = 0;
  private readonly running = new Set<AbortController>();

  constructor(
    readonly id: string,
    readonly options: SandboxCreateOptions,
    private readonly worker: FakeWorker,
  ) {}

  get closed() {
    return this.closeCalls > 0;
  }

  private check(path: string) {
    if (this.closed) throw new Error(`${this.id} is closed`);
    if (!path.startsWith(`${SANDBOX_HOME}/`)) throw new Error(`${path} is outside ${SANDBOX_HOME}`);
  }

  async writeFile(path: string, data: string | Uint8Array) {
    this.check(path);
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  async readFile(path: string) {
    this.check(path);
    return this.files.get(path);
  }

  start(argv: string[], o: { cwd: string }): SandboxProcess {
    if (this.closed) throw new Error(`${this.id} is closed`);
    const entry = { argv, cwd: o.cwd, stopped: false };
    this.started.push(entry);
    const arg = (name: string) => argv[argv.indexOf(name) + 1];
    const input: SwarmWorkerInput = JSON.parse(new TextDecoder().decode(this.files.get(arg("--input"))));
    const abort = new AbortController();
    this.running.add(abort);
    const done = this.worker({ sandbox: this, input, runsDir: arg("--runs"), signal: abort.signal })
      .catch(() => 1)
      .then((exitCode) => {
        this.running.delete(abort);
        return { exitCode, output: `fake worker exited ${exitCode}` };
      });
    return {
      done,
      stop: async () => {
        entry.stopped = true;
        abort.abort();
        await done;
      },
    };
  }

  async close() {
    this.closeCalls++;
    for (const a of this.running) a.abort();
  }
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = "fake";
  readonly repoDir = `${SANDBOX_HOME}/frictionswarm`;
  readonly sandboxes: FakeSandbox[] = [];
  /** create() calls, including failed ones. */
  creates = 0;

  constructor(
    private readonly o: {
      /** Worker for the n-th sandbox (1-based); defaults to finishingWorker. */
      workerFor?: (n: number) => FakeWorker;
      /** create() of the n-th sandbox (1-based) throws. */
      failCreate?: number;
      createDelayMs?: number;
    } = {},
  ) {}

  async create(options: SandboxCreateOptions) {
    const n = ++this.creates;
    if (this.o.createDelayMs) await new Promise((r) => setTimeout(r, this.o.createDelayMs));
    if (this.o.failCreate === n) throw new Error(`fake: no capacity for sandbox ${n}`);
    const sb = new FakeSandbox(`fake-${n}`, options, this.o.workerFor?.(n) ?? finishingWorker);
    this.sandboxes.push(sb);
    return sb;
  }
}
