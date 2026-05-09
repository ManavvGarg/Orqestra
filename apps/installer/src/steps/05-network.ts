import { sh } from "../lib/shell";
import { log } from "../lib/log";
import type { Step } from "../types";

async function ensureDockerDaemonRunning(): Promise<boolean> {
  // Try to ping Docker
  const ping = await sh("docker ps 2>&1");
  if (ping.ok) return true;

  // Check if it's a daemon connection error
  const stderr = ping.stderr + ping.stdout;
  if (
    stderr.includes("Cannot connect to the Docker daemon") ||
    stderr.includes("dial unix") ||
    stderr.includes("connect: no such file or directory")
  ) {
    log.info("Docker daemon not running. Starting…");

    // macOS: Open Docker.app
    if (process.platform === "darwin") {
      // Try to open Docker Desktop
      await sh("open -a Docker 2>/dev/null || true");
      
      // Wait up to 60s for Docker socket to appear and be responsive
      let ready = false;
      for (let i = 0; i < 60; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1000));
        
        // Check both: socket exists AND docker responds
        const retry = await sh(
          "[ -S /var/run/docker.sock ] || [ -S $HOME/.docker/run/docker.sock ] && docker ps > /dev/null 2>&1"
        );
        if (retry.ok) {
          ready = true;
          log.ok("Docker daemon is running.");
          break;
        }
        
        if (i % 10 === 0 && i > 0) {
          log.info(`Waiting for Docker… (${i}s)`);
        }
      }
      
      if (!ready) {
        log.err("Docker did not start within 60 seconds.");
        log.info("Try manually opening Docker Desktop, then re-run the installer.");
        return false;
      }
      return true;
    }

    // Linux: Try systemctl
    const systemctl = await sh("sudo systemctl start docker 2>&1 || true");
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
        error: "Docker daemon is not running. Please start Docker Desktop and retry.",
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
