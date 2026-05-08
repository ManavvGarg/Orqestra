import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const FILE = ".orqestra-install.json";

export interface InstallState {
  completedSteps: string[];
  installDir: string;
  startedAt: string;
}

export async function loadState(installDir: string): Promise<InstallState | null> {
  const path = join(installDir, FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as InstallState;
  } catch {
    return null;
  }
}

export async function saveState(state: InstallState): Promise<void> {
  const path = join(state.installDir, FILE);
  await writeFile(path, JSON.stringify(state, null, 2));
}
