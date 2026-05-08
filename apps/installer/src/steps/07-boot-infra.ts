import { sh } from "../lib/shell";
import type { Step } from "../types";

export const bootInfraStep: Step = {
  id: "boot-infra",
  title: "Boot infrastructure (postgres, redis, traefik)",
  async run({ installDir, config }) {
    const services = config.mode === "local" ? "postgres redis" : "postgres redis traefik";
    const r = await sh(`docker compose up -d ${services}`, { cwd: installDir });
    if (!r.ok) {
      return { ok: false, error: "compose up failed", stdout: r.stdout, stderr: r.stderr };
    }

    for (let i = 0; i < 30; i++) {
      const ps = await sh(
        "docker compose ps --format '{{.Service}} {{.Health}}' | grep -E 'postgres|redis'",
        { cwd: installDir },
      );
      const lines = ps.stdout.split("\n").filter(Boolean);
      const allHealthy = lines.length >= 2 && lines.every((l) => l.includes("healthy"));
      if (allHealthy) return { ok: true, note: "healthy" };
      await new Promise((res) => setTimeout(res, 1000));
    }
    return { ok: false, error: "postgres/redis did not become healthy in 30s" };
  },
};
