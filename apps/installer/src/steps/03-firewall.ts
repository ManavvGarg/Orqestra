import { sh, which } from "../lib/shell";
import { sudoSh, printGuide } from "../lib/sudo";
import { confirm, bail } from "../ui/prompts";
import type { Step } from "../types";

export const firewallStep: Step = {
  id: "firewall",
  title: "Open ports 80 + 443 (server mode)",
  appliesTo: (cfg) => cfg.mode === "server",
  async check() {
    if (!(await which("ufw"))) return true; // no ufw → nothing to do
    const status = await sh("sudo -n ufw status 2>/dev/null || ufw status 2>/dev/null || true");
    if (!status.ok || !status.stdout.includes("Status: active")) return true; // ufw inactive
    return status.stdout.includes("80") && status.stdout.includes("443");
  },
  async run({ config }) {
    if (!(await which("ufw"))) {
      return { ok: true, note: "no ufw — assuming open ports", skipped: true };
    }
    const status = await sh("ufw status 2>/dev/null || sudo -n ufw status 2>/dev/null");
    if (!status.stdout.includes("Status: active")) {
      return { ok: true, note: "ufw inactive — assuming open ports", skipped: true };
    }

    if (config.sudo === "auto") {
      const r1 = await sudoSh("ufw allow 80/tcp");
      const r2 = await sudoSh("ufw allow 443/tcp");
      if (!r1.ok || !r2.ok) {
        return { ok: false, error: "ufw allow failed", stderr: r1.stderr + r2.stderr };
      }
      await sudoSh("ufw reload");
      return { ok: true, note: "80 + 443 open" };
    }

    printGuide(
      ["sudo ufw allow 80/tcp", "sudo ufw allow 443/tcp", "sudo ufw reload"],
      "ufw is active and Traefik needs ports 80 + 443 open for ACME + serving.",
    );
    const done = (await confirm({
      message: "Have you allowed 80 + 443 in ufw?",
      initialValue: false,
    })) as boolean;
    bail(done);
    return done ? { ok: true } : { ok: false, error: "ports not opened" };
  },
};
