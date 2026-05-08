import { spawn } from "bun";

export interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Inherit stdio; useful for `docker compose up` style live logs. */
  inherit?: boolean;
  timeoutMs?: number;
}

export async function exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const proc = spawn({
    cmd,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as Record<string, string>,
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
  });

  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, opts.timeoutMs);
  }

  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);

  const stdout = opts.inherit ? "" : await new Response(proc.stdout).text();
  const stderr = opts.inherit ? "" : await new Response(proc.stderr).text();

  return {
    ok: !killed && exitCode === 0,
    exitCode: killed ? 124 : exitCode,
    stdout,
    stderr,
  };
}

/** Run a single shell line via /bin/sh -c. Quote your inputs! */
export async function sh(line: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return exec(["sh", "-c", line], opts);
}

export async function which(bin: string): Promise<string | null> {
  const r = await exec(["sh", "-c", `command -v ${bin}`]);
  return r.ok ? r.stdout.trim() : null;
}
