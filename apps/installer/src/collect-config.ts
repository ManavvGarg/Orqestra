import { homedir } from "node:os";
import { join } from "node:path";
import { text, password, select, confirm, bail } from "./ui/prompts";
import { randomHex } from "./lib/secrets";
import type { InstallConfig, InstallMode } from "./types";

const DEFAULT_REPO = "https://github.com/orqestra/orqestra.git";
const DEFAULT_REF = "main";

export async function collectConfig(): Promise<InstallConfig> {
  const mode = (await select({
    message: "Where are you installing?",
    options: [
      {
        value: "local",
        label: "Local (laptop / dev)",
        hint: "Plain HTTP, no Cloudflare, ports on localhost",
      },
      {
        value: "server",
        label: "Server (production)",
        hint: "HTTPS via Traefik + Let's Encrypt + Cloudflare DNS",
      },
    ],
    initialValue: "local" as InstallMode,
  })) as InstallMode;
  bail(mode);

  const defaultDir =
    process.getuid?.() === 0 ? "/opt/orqestra" : join(homedir(), "orqestra");
  const installDir = (await text({
    message: "Install directory",
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
    message: "Branch / tag to install",
    initialValue: process.env.ORQESTRA_REPO_REF ?? DEFAULT_REF,
  })) as string;
  bail(repoRef);

  let siteDomain: string;
  let cfDnsApiToken: string | undefined;
  let letsEncryptEmail: string | undefined;

  if (mode === "server") {
    siteDomain = (await text({
      message: "Public domain (e.g. orqestra.acme.dev)",
      validate: (v) => (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ? undefined : "Invalid domain"),
    })) as string;
    bail(siteDomain);

    letsEncryptEmail = (await text({
      message: "Email for Let's Encrypt notifications",
      validate: (v) => (/.+@.+\..+/.test(v) ? undefined : "Invalid email"),
    })) as string;
    bail(letsEncryptEmail);

    cfDnsApiToken = (await password({
      message: "Cloudflare API token (Zone.DNS Edit scope)",
      validate: (v) => (v.length > 10 ? undefined : "Required"),
    })) as string;
    bail(cfDnsApiToken);
  } else {
    siteDomain = "localhost";
  }

  const wantsAi = (await confirm({
    message: "Enable AI diagnostics on failures? (paste Anthropic API key)",
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
    siteDomain,
    letsEncryptEmail,
    cfDnsApiToken,
    postgresPassword,
    betterAuthSecret,
    internalApiSecret,
    anthropicApiKey,
  };
}
