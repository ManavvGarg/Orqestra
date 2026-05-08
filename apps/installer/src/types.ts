export type StepResult =
  | { ok: true; note?: string; skipped?: boolean }
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
  /** True only when the step applies to the current config (e.g. server-only). */
  appliesTo?(cfg: InstallConfig): boolean;
  /** Optional fast pre-check; if it returns true, run() is skipped. */
  check?(ctx: StepContext): Promise<boolean>;
  run(ctx: StepContext): Promise<StepResult>;
}

export type InstallMode = "local" | "server";

export type SudoMode =
  | "auto" // we have sudo (or root) — run system commands via sudo
  | "guide"; // user denies sudo — print exact commands for them to run

export type GpuChoice =
  | "off" // no GPU support requested
  | "auto" // detect + install nvidia-container-toolkit if GPU + driver present
  | "skip"; // GPU present but skip toolkit install (already done)

export type DnsMode =
  | "cloudflare-auto" // we have CF token — create A records via API
  | "manual"; // print records the user must add at their registrar

export interface InstallConfig {
  mode: InstallMode;
  installDir: string;
  repoUrl: string;
  repoRef: string;

  sudo: SudoMode;
  gpu: GpuChoice;

  siteDomain: string;
  letsEncryptEmail?: string;

  cfDnsApiToken?: string;
  cfZoneId?: string;
  dns: DnsMode;
  /** Public IP/host the wildcard A record will point to. */
  serverPublicIp?: string;

  postgresPassword: string;
  betterAuthSecret: string;
  internalApiSecret: string;

  anthropicApiKey?: string;
}
