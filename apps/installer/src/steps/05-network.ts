import { sh } from "../lib/shell";
import type { Step } from "../types";

export const networkStep: Step = {
  id: "docker-network",
  title: "Create proxy network",
  async run() {
    const ls = await sh("docker network ls --format '{{.Name}}'");
    if (ls.ok && ls.stdout.split("\n").includes("proxy")) {
      return { ok: true, note: "exists" };
    }
    const r = await sh("docker network create proxy");
    if (!r.ok) return { ok: false, error: "network create failed", stderr: r.stderr };
    return { ok: true, note: "created" };
  },
};
