import { which } from "../lib/shell";
import type { Step } from "../types";

export const checkToolsStep: Step = {
  id: "check-tools",
  title: "Check required tools (git, openssl)",
  async run() {
    const missing: string[] = [];
    for (const bin of ["git", "openssl"]) {
      if (!(await which(bin))) missing.push(bin);
    }
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Missing required tools: ${missing.join(", ")}. Install with: sudo apt install -y ${missing.join(" ")}`,
      };
    }
    return { ok: true };
  },
};
