import { confirm, bail } from "../ui/prompts";
import { log } from "../lib/log";
import type { InstallConfig, Step } from "../types";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfErr {
  errors?: Array<{ message: string }>;
  success?: boolean;
}

async function cf<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const j = (await r.json()) as CfErr & { result?: T };
  if (!r.ok || j.success === false) {
    const msg = j.errors?.map((e) => e.message).join("; ") ?? `HTTP ${r.status}`;
    throw new Error(`Cloudflare: ${msg}`);
  }
  return j.result as T;
}

function apexOf(domain: string): string {
  // Strip leading subdomains until we hit two-segment apex (rough heuristic; CF
  // accepts the registered domain directly).
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

function wildcardName(domain: string, apex: string): string {
  // Cloudflare expects the record name as fully qualified. For apex domain
  // `acme.dev` we want `*.acme.dev`. For subdomain `orqestra.acme.dev` we want
  // `*.orqestra.acme.dev`.
  return `*.${domain}`;
}

async function runManualGuide(config: InstallConfig): Promise<boolean> {
  log.raw("");
  log.raw("  Add these DNS records at your registrar / DNS provider:");
  log.raw("");
  log.raw(`    Type   Name              Value              TTL   Proxy`);
  log.raw(
    `    A      *.${config.siteDomain.padEnd(16)} ${config.serverPublicIp ?? "<server-ip>"}     auto  off (DNS-only)`,
  );
  log.raw("");
  log.raw("  Why DNS-only / no proxy:");
  log.raw("    Traefik will request a Let's Encrypt cert via DNS-01 challenge.");
  log.raw("    Cloudflare proxy (orange cloud) interferes with WebSockets + ACME.");
  log.raw("");
  log.raw("  After saving the record, wait for propagation (usually <60s).");
  log.raw("");

  const done = (await confirm({
    message: "DNS record saved + propagated?",
    initialValue: false,
  })) as boolean;
  bail(done);
  return done;
}

export const cloudflareDnsStep: Step = {
  id: "cloudflare-dns",
  title: "Create wildcard DNS via Cloudflare",
  appliesTo: (cfg) => cfg.mode === "server" && cfg.dns === "cloudflare-auto",
  async run({ config }) {
    if (!config.cfDnsApiToken || !config.serverPublicIp) {
      return { ok: false, error: "missing CF token or server IP" };
    }
    const apex = apexOf(config.siteDomain);
    let zoneId: string;
    try {
      const zones = await cf<Array<{ id: string; name: string }>>(
        `/zones?name=${encodeURIComponent(apex)}`,
        config.cfDnsApiToken,
      );
      if (!zones.length) {
        // Apex isn't on this Cloudflare account (or token lacks Zone:Read).
        // Don't fail — degrade gracefully to the manual guide.
        log.warn(
          `Cloudflare zone for ${apex} not found on this token. Falling back to manual DNS setup.`,
        );
        const ok = await runManualGuide(config);
        return ok
          ? { ok: true, note: "manual fallback" }
          : { ok: false, error: "DNS not configured" };
      }
      zoneId = zones[0]!.id;
    } catch (e) {
      // API auth/network error — also fall back to manual rather than hard-fail.
      log.warn(
        `Cloudflare API error: ${e instanceof Error ? e.message : String(e)}. Falling back to manual.`,
      );
      const ok = await runManualGuide(config);
      return ok
        ? { ok: true, note: "manual fallback (API error)" }
        : { ok: false, error: "DNS not configured" };
    }

    const name = wildcardName(config.siteDomain, apex);

    // Look for existing record so we can update instead of duplicate.
    let existingId: string | null = null;
    try {
      const existing = await cf<Array<{ id: string; content: string; type: string }>>(
        `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
        config.cfDnsApiToken,
      );
      if (existing.length > 0) existingId = existing[0]!.id;
    } catch {
      /* fall through to create */
    }

    const body = JSON.stringify({
      type: "A",
      name,
      content: config.serverPublicIp,
      ttl: 1, // automatic
      proxied: false, // Traefik does ACME-DNS01; orange-cloud breaks websocket + needs origin certs
      comment: "orqestra installer",
    });

    try {
      if (existingId) {
        await cf(`/zones/${zoneId}/dns_records/${existingId}`, config.cfDnsApiToken, {
          method: "PUT",
          body,
        });
        return { ok: true, note: `updated A record ${name} → ${config.serverPublicIp}` };
      }
      await cf(`/zones/${zoneId}/dns_records`, config.cfDnsApiToken, {
        method: "POST",
        body,
      });
      return { ok: true, note: `created A record ${name} → ${config.serverPublicIp}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const dnsManualGuideStep: Step = {
  id: "dns-manual-guide",
  title: "DNS records to add (manual)",
  appliesTo: (cfg) => cfg.mode === "server" && cfg.dns === "manual",
  async run({ config }) {
    const ok = await runManualGuide(config);
    return ok ? { ok: true } : { ok: false, error: "DNS not configured" };
  },
};
