import { sh } from "../lib/shell";
import type { Step } from "../types";

const MIN_DISK_GB = 20;
const RECOMMENDED_DISK_GB = 60;
const MIN_RAM_GB = 4;
const RECOMMENDED_RAM_GB = 8;

async function diskFreeGB(path: string): Promise<number | null> {
  // -BG = report in GB, --output=avail = available bytes column only
  const r = await sh(`df -BG --output=avail "${path}" 2>/dev/null | tail -1`);
  if (!r.ok) return null;
  const m = r.stdout.match(/(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

async function totalRamGB(): Promise<number | null> {
  // Linux /proc/meminfo MemTotal in KB
  const r = await sh("awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null");
  if (r.ok) {
    const kb = parseInt(r.stdout.trim(), 10);
    if (!isNaN(kb)) return Math.round(kb / 1024 / 1024);
  }
  // macOS fallback
  const m = await sh("sysctl -n hw.memsize 2>/dev/null");
  if (m.ok) {
    const bytes = parseInt(m.stdout.trim(), 10);
    if (!isNaN(bytes)) return Math.round(bytes / 1024 / 1024 / 1024);
  }
  return null;
}

export const preflightStep: Step = {
  id: "preflight",
  title: "Pre-flight checks (disk + RAM)",
  async run({ config }) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Probe docker dir if it exists, else install dir parent.
    const dockerProbe = await sh("test -d /var/lib/docker && echo yes || echo no");
    const probePath = dockerProbe.stdout.trim() === "yes" ? "/var/lib/docker" : "/";
    const free = await diskFreeGB(probePath);
    if (free === null) {
      warnings.push(`could not read disk free for ${probePath}`);
    } else if (free < MIN_DISK_GB) {
      errors.push(
        `Only ${free} GB free at ${probePath}; need ≥ ${MIN_DISK_GB} GB. Docker images alone are ~15 GB. Free up space then re-run.`,
      );
    } else if (free < RECOMMENDED_DISK_GB) {
      warnings.push(
        `${free} GB free at ${probePath}; recommend ≥ ${RECOMMENDED_DISK_GB} GB for comfortable build + multiple model pulls.`,
      );
    }

    const ram = await totalRamGB();
    if (ram === null) {
      warnings.push("could not detect total RAM");
    } else if (ram < MIN_RAM_GB) {
      errors.push(
        `Host has ${ram} GB RAM; need ≥ ${MIN_RAM_GB} GB. Postgres + Redis + node apps will OOM.`,
      );
    } else if (ram < RECOMMENDED_RAM_GB) {
      warnings.push(
        `Host has ${ram} GB RAM; recommend ≥ ${RECOMMENDED_RAM_GB} GB to host Jupyter + Ollama models.`,
      );
    }

    // Server-mode-only port checks.
    if (config.mode === "server") {
      for (const port of [80, 443]) {
        const r = await sh(`ss -tlnp 2>/dev/null | awk '{print $4}' | grep -q ":${port}$"`);
        if (r.ok) {
          errors.push(
            `Port ${port} already bound on the host. Traefik needs ${port} free. Stop the conflicting service.`,
          );
        }
      }
    }

    if (errors.length > 0) {
      return {
        ok: false,
        error: errors.join("\n"),
        stdout: warnings.join("\n"),
      };
    }

    const note = [
      free !== null ? `disk ${free} GB free` : "disk unknown",
      ram !== null ? `${ram} GB RAM` : "RAM unknown",
      ...(warnings.length > 0 ? [`(warnings: ${warnings.length})`] : []),
    ].join(", ");

    if (warnings.length > 0) {
      // Print warnings but don't block.
      for (const w of warnings) console.log("    ⚠ " + w);
    }
    return { ok: true, note };
  },
};
