// Runs swarm workers on this machine instead of tenki: each "sandbox" is a folder standing in for
// /home/tenki, and the worker is a local process using this checkout. For trying the whole swarm
// without tenki credits (Claude Code and Playwright's Chromium must be installed locally).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SANDBOX_HOME, type Sandbox, type SandboxCreateOptions, type SandboxProcess, type SandboxProvider } from "./provider";

const REPO = resolve(import.meta.dirname, "..", "..");

class LocalSandbox implements Sandbox {
  private readonly children = new Set<ChildProcess>();

  constructor(
    readonly id: string,
    private readonly home: string,
    private readonly env: Record<string, string>,
    private readonly log: (line: string) => void,
  ) {}

  /** /home/tenki/… → <home>/…; anything else (the repo) is used as is. */
  private local(path: string) {
    return path === SANDBOX_HOME || path.startsWith(`${SANDBOX_HOME}/`) ? join(this.home, path.slice(SANDBOX_HOME.length)) : path;
  }

  async writeFile(path: string, data: string | Uint8Array) {
    const file = this.local(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }

  async readFile(path: string) {
    const file = this.local(path);
    return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
  }

  start(argv: string[], o: { cwd: string; env?: Record<string, string> }): SandboxProcess {
    const [cmd, ...rest] = argv.map((a) => this.local(a));
    const child = spawn(cmd, rest, { cwd: this.local(o.cwd), env: { ...process.env, ...this.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-4000);
      for (const line of text.split("\n")) if (line.trim()) this.log(`  [${this.id}] ${line}`);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    const done = new Promise<{ exitCode: number; output: string }>((r) => {
      child.on("close", (code) => r({ exitCode: code ?? 1, output }));
      child.on("error", (err) => r({ exitCode: 1, output: err.message }));
    }).finally(() => this.children.delete(child));
    return {
      done,
      stop: async () => {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await done;
        clearTimeout(kill);
      },
    };
  }

  async close() {
    for (const c of this.children) c.kill("SIGTERM");
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = "local";
  readonly repoDir = REPO;
  private n = 0;

  /** `root` holds one folder per sandbox (its /home/tenki). */
  constructor(private readonly root: string, private readonly log: (line: string) => void = console.log) {}

  async create(o: SandboxCreateOptions): Promise<Sandbox> {
    const home = join(this.root, o.name);
    mkdirSync(home, { recursive: true });
    return new LocalSandbox(`local-${++this.n}`, home, o.env, this.log);
  }
}
