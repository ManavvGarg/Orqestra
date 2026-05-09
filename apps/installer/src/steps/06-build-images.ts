import { sh } from "../lib/shell";
import type { Step } from "../types";

export const buildImagesStep: Step = {
  id: "build-images",
  title: "Build Docker images (this is slow)",
  async run({ installDir }) {
    const r = await sh(
      "docker compose build",
      { cwd: installDir, timeoutMs: 30 * 60 * 1000 },
    );
    if (!r.ok) {
      return { ok: false, error: "docker compose build failed", stdout: r.stdout, stderr: r.stderr };
    }
    return { ok: true };
  },
};
