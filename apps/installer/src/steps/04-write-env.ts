import { writeEnvFile } from "../lib/env-file";
import type { Step } from "../types";

export const writeEnvStep: Step = {
  id: "write-env",
  title: "Write .env",
  async run({ config }) {
    try {
      const path = await writeEnvFile(config);
      return { ok: true, note: path };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
