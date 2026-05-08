import { sh, exec, type ExecResult } from "./shell";
import { log } from "./log";
import kleur from "kleur";

/** True if process EUID is 0. */
export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Probe sudo without prompting for password. Returns true if `sudo -n true`
 * succeeds (cached creds or NOPASSWD).
 */
export async function hasPasswordlessSudo(): Promise<boolean> {
  if (isRoot()) return true;
  const r = await sh("sudo -n true 2>/dev/null");
  return r.ok;
}

/** True if `sudo` binary is available at all. */
export async function sudoAvailable(): Promise<boolean> {
  if (isRoot()) return true;
  const r = await sh("command -v sudo");
  return r.ok;
}

/**
 * Run a privileged shell command. If we are root, run directly. Otherwise prefix
 * with `sudo`. The terminal will prompt for password if creds aren't cached —
 * `inherit: true` is required so the prompt is visible to the user.
 */
export async function sudoSh(line: string, opts: { cwd?: string } = {}): Promise<ExecResult> {
  if (isRoot()) {
    return sh(line, { ...opts, inherit: true });
  }
  return sh(`sudo ${line}`, { ...opts, inherit: true });
}

export async function sudoExec(cmd: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
  const args = isRoot() ? cmd : ["sudo", ...cmd];
  return exec(args, { ...opts, inherit: true });
}

/**
 * Print the commands the user should run themselves and pause until they
 * confirm. Used in `guide` sudo mode.
 */
export function printGuide(commands: string[], message?: string) {
  console.log();
  if (message) log.info(message);
  console.log();
  console.log(kleur.bold("  Run the following on the host:"));
  console.log();
  for (const c of commands) {
    console.log(kleur.cyan("    $ ") + c);
  }
  console.log();
}
