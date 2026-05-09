import { sh } from "../lib/shell";
import { log } from "../lib/log";
import type { Step } from "../types";

async function ensureDockerDaemonRunning(): Promise<boolean> {
  // Try to ping Docker. If it fails, try to start it.
  const ping = await sh("docker ps --no-trunc 2>&1");
  if (ping.ok) return true;

  // Check if it's a daemon connection error on macOS/Linux
  if (
    ping.stderr.includes("Cannot connect to the Docker daemon") ||
    ping.stderr.includes("dial unix") ||
    ping.stderr.includes("no such file or directory")
  ) {
    log.info("Docker daemon not running. Starting…");

    // macOS: Open Docker.app
    if (process.platform === "darwin") {
      await sh("open -a Docker || true");
      // Wait up to 30s for Docker to be ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const retry = await sh("docker ps --no-trunc 2>&1");
        if (retry.ok) {
          log.ok("Docker daemon is running.");
          return true;
        }
      }
      log.warn("Docker startup timed out. Please open Docker Desktop manually.");
      return false;
    }

    // Linux: Try systemctl
    const systemctl = await sh("sudo systemctl start docker || true");
    if (systemctl.ok) {
      log.ok("Docker daemon started.");
      return true;
    }

    return false;
  }

  return false;
}

export const networkStep: Step = {
  id: "docker-network",
  title: "Create proxy network",
  async run() {
    // Ensure Docker daemon is running first
    const daemonReady = await ensureDockerDaemonRunning();
    if (!daemonReady) {
      return {
        ok: false,
        error: "Docker daemon could not be started. Please start Docker manually and retry.",
      };
    }

    const ls = await sh("docker network ls --format '{{.Name}}'");
    if (ls.ok && ls.stdout.split("\n").includes("proxy")) {
      return { ok: true, note: "exists" };
    }
    const r = await sh("docker network create proxy");
    if (!r.ok) return { ok: false, error: "network create failed", stderr: r.stderr };
    return { ok: true, note: "created" };
  },
};
