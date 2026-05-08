export type StepResult =
  | { ok: true; note?: string }
  | { ok: false; error: string; stdout?: string; stderr?: string };

export interface StepContext {
  config: InstallConfig;
  installDir: string;
  state: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Step {
  id: string;
  title: string;
  /** Optional fast pre-check; if it returns ok, run() is skipped. */
  check?(ctx: StepContext): Promise<boolean>;
  run(ctx: StepContext): Promise<StepResult>;
}

export type InstallMode = "local" | "server";

export interface InstallConfig {
  mode: InstallMode;
  installDir: string;
  repoUrl: string;
  repoRef: string;

  siteDomain: string;
  letsEncryptEmail?: string;

  cfDnsApiToken?: string;

  postgresPassword: string;
  betterAuthSecret: string;
  internalApiSecret: string;

  anthropicApiKey?: string;
}
