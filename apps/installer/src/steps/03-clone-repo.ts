import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sh } from "../lib/shell";
import type { Step } from "../types";

export const cloneRepoStep: Step = {
  id: "clone-repo",
  title: "Fetch Orqestra source",
  async run({ config, installDir }) {
    // If directory exists but is marked for cleanup (indicator: has non-.git contents but no .git folder)
    // Remove it entirely and recreate clean.
    if (existsSync(installDir)) {
      const isGitRepo = existsSync(join(installDir, ".git"));
      if (!isGitRepo) {
        // Non-git directory exists — clean it for a fresh clone
        try {
          await rm(installDir, { recursive: true, force: true });
        } catch (e) {
          return { ok: false, error: `Failed to remove existing directory: ${(e as Error).message}` };
        }
      } else {
        // Already a git repo — update it instead
        const fetch = await sh(`git -C "${installDir}" fetch --tags --quiet`);
        if (!fetch.ok) return { ok: false, error: "git fetch failed", stderr: fetch.stderr };
        const checkout = await sh(`git -C "${installDir}" checkout "${config.repoRef}"`);
        if (!checkout.ok)
          return { ok: false, error: "git checkout failed", stderr: checkout.stderr };
        const pull = await sh(`git -C "${installDir}" pull --ff-only --quiet || true`);
        return { ok: true, note: `updated to ${config.repoRef}`, stdout: pull.stdout };
      }
    }

    // Create the directory and clone
    try {
      await mkdir(installDir, { recursive: true });
    } catch (e) {
      return { ok: false, error: `Failed to create directory: ${(e as Error).message}` };
    }

    const cmd = `git clone --branch "${config.repoRef}" --depth 1 "${config.repoUrl}" "${installDir}"`;
    const r = await sh(cmd);
    if (!r.ok) {
      return { ok: false, error: "git clone failed", stdout: r.stdout, stderr: r.stderr };
    }
    return { ok: true, note: `${config.repoUrl}@${config.repoRef}` };
  },
};
