import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TenkiSandbox, type Session } from "@tenkicloud/sandbox";

export type ShellResult = { exitCode: number; stdout: string; stderr: string };

/** Where the coding agent runs: a tenki sandbox for real runs, a local
 * directory for development. Commands run under `bash -c`. */
export interface Shell {
  /** Directory the shell may use; everything goes under it. */
  home: string;
  exec(script: string, opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ShellResult>;
  writeFile(path: string, data: string): Promise<void>;
  close(): Promise<void>;
}

export class ShellError extends Error {
  constructor(script: string, public result: ShellResult) {
    super(`command failed (${result.exitCode}): ${script}\n${(result.stderr || result.stdout).slice(-2000)}`);
  }
}

/** exec that throws on a non-zero exit. */
export async function run(shell: Shell, script: string, opts?: Parameters<Shell["exec"]>[1]) {
  const result = await shell.exec(script, opts);
  if (result.exitCode !== 0) throw new ShellError(script, result);
  return result.stdout.trim();
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

export async function tenkiShell(name: string): Promise<Shell> {
  // Files must live under /home/tenki: /tmp is wiped on pause
  const session: Session = await new TenkiSandbox().create({
    name,
    cpuCores: 4,
    memoryMb: 8192,
    diskSizeGb: 20,
    maxDurationMs: 45 * 60_000,
  });
  return {
    home: "/home/tenki",
    async exec(script, opts = {}) {
      const r = await session.exec(["bash", "-c", script], { env: opts.env, timeoutMs: opts.timeoutMs });
      return { exitCode: r.exitCode, stdout: decode(r.stdout), stderr: decode(r.stderr) };
    },
    writeFile: (path, data) => session.writeFile(path, data),
    // Failed sessions still bill: always close
    close: () => session.close(),
  };
}

export function localShell(home: string): Shell {
  return {
    home,
    exec(script, opts = {}) {
      return new Promise((resolve) => {
        execFile(
          "bash",
          ["-c", script],
          { cwd: home, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
          (err, stdout, stderr) =>
            resolve({ exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
        );
      });
    },
    async writeFile(path, data) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    close: async () => {},
  };
}
