// Where swarm workers run. The orchestrator only talks to this interface, so its logic
// (planning, polling, cleanup) is tested against a fake (fake.ts); tenki.ts is the real
// thing and local.ts runs workers on this machine.

/** Every file the swarm touches in a sandbox lives under here (tenki wipes /tmp on pause). */
export const SANDBOX_HOME = "/home/tenki";

export function sandboxPath(...parts: string[]) {
  const path = [SANDBOX_HOME, ...parts].join("/").replace(/\/+/g, "/");
  if (path.split("/").includes("..")) throw new Error(`Sandbox path escapes ${SANDBOX_HOME}: ${path}`);
  return path;
}

export type SandboxCreateOptions = {
  /** Human-readable, e.g. `swarm-<runId>-2`. */
  name: string;
  /** Environment for everything run in the sandbox (Claude credentials, model). */
  env: Record<string, string>;
};

export interface SandboxProvider {
  readonly name: string;
  /** Absolute path of this repo (with node_modules) as the sandbox sees it. */
  readonly repoDir: string;
  create(o: SandboxCreateOptions): Promise<Sandbox>;
}

export interface Sandbox {
  readonly id: string;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** The file's bytes, or undefined if it doesn't exist (yet). */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Starts a long-running process; it is not awaited here. */
  start(argv: string[], o: { cwd: string; env?: Record<string, string> }): SandboxProcess;
  /** Stops billing. Must be safe to call more than once. */
  close(): Promise<void>;
}

export interface SandboxProcess {
  /** Settles when the process exits; `output` is the tail of what it printed. */
  readonly done: Promise<{ exitCode: number; output: string }>;
  /** Asks the process to stop (SIGTERM, then SIGKILL); resolves once it has exited. */
  stop(): Promise<void>;
}
