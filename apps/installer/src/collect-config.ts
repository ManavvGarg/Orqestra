import { homedir } from "node:os";
import { join } from "node:path";
import { text, password, select, confirm, bail } from "./ui/prompts";
import { randomHex } from "./lib/secrets";
import { sh, which } from "./lib/shell";
import { hasPasswordlessSudo, sudoAvailable, isRoot } from "./lib/sudo";
import { log } from "./lib/log";
import type { InstallConfig, InstallMode, SudoMode, GpuChoice, DnsMode } from "./types";

const DEFAULT_REPO = "https://github.com/orqestra/orqestra.git";
const DEFAULT_REF = "main";

async function detectGpu(): Promise<boolean> {
  return !!(await which("nvidia-smi"));
}

async function detectPublicIp(): Promise<string | null> {
  // Try IPv4 with curl, fall back to nothing.
  const r = await sh("curl -fsSL --max-time 5 https://api.ipify.org");
  if (r.ok && /^\d+\.\d+\.\d+\.\d+$/.test(r.stdout.trim())) return r.stdout.trim();
  return null;
}

export async function collectConfig(): Promise<InstallConfig> {
  log.section("1. Where are we installing?");

  const mode = (await select({
    message: "Pick install mode",
    options: [
      {
        value: "local",
        label: "Local — laptop or dev box",
        hint: "plain HTTP, no domain, ports on localhost",
      },
      {
        value: "server",
        label: "Server — public host + domain",
        hint: "HTTPS via Traefik + Let's Encrypt + Cloudflare DNS",
      },
    ],
    initialValue: "local" as InstallMode,
  })) as InstallMode;
  bail(mode);

  const defaultDir =
    process.getuid?.() === 0 ? "/opt/orqestra" : join(homedir(), "orqestra");
  const installDir = (await text({
    message: "Install directory (where the repo is cloned)",
    initialValue: defaultDir,
    validate: (v) => (v.startsWith("/") || v.startsWith("~") ? undefined : "Use absolute path"),
  })) as string;
  bail(installDir);

  const repoUrl = (await text({
    message: "Orqestra git repository",
    initialValue: process.env.ORQESTRA_REPO_URL ?? DEFAULT_REPO,
  })) as string;
  bail(repoUrl);

  const repoRef = (await text({
    message: "Branch / tag",
    initialValue: process.env.ORQESTRA_REPO_REF ?? DEFAULT_REF,
  })) as string;
  bail(repoRef);

  // ----- Privileges --------------------------------------------------------
  log.section("2. System privileges");

  let sudo: SudoMode = "guide";
  if (isRoot()) {
    log.ok("Running as root — system installs (Docker, NVIDIA toolkit) will run automatically.");
    sudo = "auto";
  } else if (await sudoAvailable()) {
    const passwordless = await hasPasswordlessSudo();
    if (passwordless) {
      log.ok("Passwordless sudo detected — system installs will run automatically.");
    } else {
      log.info("sudo is available but will prompt for your password when needed.");
    }
    const wantsAuto = (await confirm({
      message:
        "Allow the installer to run privileged commands (Docker install, firewall, NVIDIA toolkit) via sudo?",
      initialValue: true,
    })) as boolean;
    bail(wantsAuto);
    sudo = wantsAuto ? "auto" : "guide";
  } else {
    log.warn("sudo not found — installer will guide you through manual privileged steps.");
  }

  // ----- GPU ---------------------------------------------------------------
  log.section("3. GPU support");

  const gpuPresent = await detectGpu();
  let gpu: GpuChoice = "off";
  if (gpuPresent) {
    log.ok("NVIDIA GPU detected via nvidia-smi.");
    const enable = (await confirm({
      message: "Enable GPU support for containers? (installs nvidia-container-toolkit if missing)",
      initialValue: true,
    })) as boolean;
    bail(enable);
    gpu = enable ? "auto" : "off";
  } else {
    log.info("No NVIDIA GPU detected — containers will run on CPU.");
  }

  // ----- Domain + DNS (server mode only) ----------------------------------
  let siteDomain: string;
  let cfDnsApiToken: string | undefined;
  let cfZoneId: string | undefined;
  let letsEncryptEmail: string | undefined;
  let dns: DnsMode = "manual";
  let serverPublicIp: string | undefined;

  if (mode === "server") {
    log.section("4. Domain + TLS");

    siteDomain = (await text({
      message: "Public domain (e.g. orqestra.acme.dev)",
      validate: (v) =>
        /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ? undefined : "Invalid domain",
    })) as string;
    bail(siteDomain);

    letsEncryptEmail = (await text({
      message: "Email for Let's Encrypt notifications",
      validate: (v) => (/.+@.+\..+/.test(v) ? undefined : "Invalid email"),
    })) as string;
    bail(letsEncryptEmail);

    const detectedIp = await detectPublicIp();
    serverPublicIp = (await text({
      message: `Public IP for *.${siteDomain} → wildcard A record`,
      initialValue: detectedIp ?? "",
      validate: (v) => (/^\d+\.\d+\.\d+\.\d+$/.test(v) ? undefined : "Invalid IPv4"),
    })) as string;
    bail(serverPublicIp);

    const dnsChoice = (await select({
      message: "DNS setup",
      options: [
        {
          value: "cloudflare-auto",
          label: "I have a Cloudflare API token — auto-create the wildcard record",
          hint: "fastest path; needs Zone.DNS:Edit + Zone.Zone:Read",
        },
        {
          value: "manual",
          label: "I will add the DNS record myself",
          hint: "installer prints the exact records you need",
        },
      ],
      initialValue: "cloudflare-auto" as DnsMode,
    })) as DnsMode;
    bail(dnsChoice);
    dns = dnsChoice;

    if (dns === "cloudflare-auto") {
      cfDnsApiToken = (await password({
        message: "Cloudflare API token (Zone.DNS:Edit + Zone.Zone:Read)",
        validate: (v) => (v.length > 10 ? undefined : "Required"),
      })) as string;
      bail(cfDnsApiToken);
      // Zone ID resolved at run time (cloudflare-dns step) using the apex domain
      // — user doesn't need to paste it.
    }
  } else {
    siteDomain = "localhost";
  }

  // ----- Optional AI diagnostics ------------------------------------------
  log.section("5. AI diagnostics (optional)");

  const wantsAi = (await confirm({
    message: "Enable AI diagnostics on failures? Pastes Anthropic key for Claude to debug step failures.",
    initialValue: false,
  })) as boolean;
  bail(wantsAi);

  let anthropicApiKey: string | undefined;
  if (wantsAi) {
    anthropicApiKey = (await password({
      message: "ANTHROPIC_API_KEY",
      validate: (v) => (v.startsWith("sk-ant-") ? undefined : "Doesn't look like an Anthropic key"),
    })) as string;
    bail(anthropicApiKey);
  }

  // ----- Generate secrets -------------------------------------------------
  const [postgresPassword, betterAuthSecret, internalApiSecret] = await Promise.all([
    randomHex(16),
    randomHex(32),
    randomHex(32),
  ]);

  return {
    mode,
    installDir,
    repoUrl,
    repoRef,
    sudo,
    gpu,
    siteDomain,
    letsEncryptEmail,
    cfDnsApiToken,
    cfZoneId,
    dns,
    serverPublicIp,
    postgresPassword,
    betterAuthSecret,
    internalApiSecret,
    anthropicApiKey,
  };
}
