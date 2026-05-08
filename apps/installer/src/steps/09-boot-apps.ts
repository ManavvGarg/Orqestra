import { sh } from "../lib/shell";
import type { Step } from "../types";

export const bootAppsStep: Step = {
  id: "boot-apps",
  title: "Boot application services",
  async run({ installDir }) {
    const r = await sh("docker compose up -d", { cwd: installDir });
    if (!r.ok) {
      return { ok: false, error: "compose up failed", stdout: r.stdout, stderr: r.stderr };
    }
    return { ok: true };
  },
};
