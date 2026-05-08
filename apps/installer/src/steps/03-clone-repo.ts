import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sh } from "../lib/shell";
import type { Step } from "../types";

export const cloneRepoStep: Step = {
  id: "clone-repo",
  title: "Fetch Orqestra source",
  async run({ config, installDir }) {
    if (!existsSync(installDir)) {
      await mkdir(installDir, { recursive: true });
    }

    const inside = existsSync(join(installDir, ".git"));
    if (inside) {
      const fetch = await sh(`git -C "${installDir}" fetch --tags --quiet`);
      if (!fetch.ok) return { ok: false, error: "git fetch failed", stderr: fetch.stderr };
      const checkout = await sh(`git -C "${installDir}" checkout "${config.repoRef}"`);
      if (!checkout.ok)
        return { ok: false, error: "git checkout failed", stderr: checkout.stderr };
      const pull = await sh(`git -C "${installDir}" pull --ff-only --quiet || true`);
      return { ok: true, note: `updated to ${config.repoRef}`, stdout: pull.stdout };
    }

    const cmd = `git clone --branch "${config.repoRef}" --depth 1 "${config.repoUrl}" "${installDir}"`;
    const r = await sh(cmd);
    if (!r.ok) {
      return { ok: false, error: "git clone failed", stdout: r.stdout, stderr: r.stderr };
    }
    return { ok: true, note: `${config.repoUrl}@${config.repoRef}` };
  },
};
