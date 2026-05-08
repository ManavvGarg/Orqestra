import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Step } from "../types";

export const checkOsStep: Step = {
  id: "check-os",
  title: "Check OS compatibility",
  async run() {
    if (process.platform === "win32") {
      return {
        ok: false,
        error:
          "Windows is not supported. Please run the installer on Linux or macOS, or use WSL2.",
      };
    }

    let distro = process.platform === "darwin" ? "macOS" : "Linux";
    if (process.platform === "linux" && existsSync("/etc/os-release")) {
      try {
        const content = await readFile("/etc/os-release", "utf-8");
        const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (match) distro = match[1]!;
      } catch {
        /* ignore */
      }
    }

    return { ok: true, note: distro };
  },
};
