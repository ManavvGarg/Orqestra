import { sh } from "../lib/shell";
import type { Step } from "../types";

export const dbPushStep: Step = {
  id: "db-push",
  title: "Push database schema",
  async run({ installDir }) {
    const r = await sh(
      `docker compose run --rm api sh -lc 'cd /repo/packages/db && bunx drizzle-kit push --config drizzle.config.ts || pnpm drizzle-kit push'`,
      { cwd: installDir, timeoutMs: 5 * 60 * 1000 },
    );
    if (!r.ok) {
      return { ok: false, error: "drizzle push failed", stdout: r.stdout, stderr: r.stderr };
    }
    return { ok: true };
  },
};
