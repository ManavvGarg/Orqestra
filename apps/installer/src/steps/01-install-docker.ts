import { sh, which } from "../lib/shell";
import { sudoSh, printGuide } from "../lib/sudo";
import { confirm, bail } from "../ui/prompts";
import { log } from "../lib/log";
import type { Step } from "../types";

const INSTALL_SCRIPT = "curl -fsSL https://get.docker.com | sh";
const COMPOSE_PLUGIN = "apt-get install -y docker-compose-plugin || dnf install -y docker-compose-plugin || pacman -S --noconfirm docker-compose";

export const installDockerStep: Step = {
  id: "install-docker",
  title: "Ensure Docker + compose plugin",
  async check() {
    const dockerOk = !!(await which("docker"));
    if (!dockerOk) return false;
    const ver = await sh("docker version --format '{{.Server.Version}}' 2>/dev/null");
    if (!ver.ok) return false;
    const compose = await sh("docker compose version --short 2>/dev/null");
    return compose.ok;
  },
  async run({ config }) {
    const dockerPresent = !!(await which("docker"));
    const composePresent = (await sh("docker compose version --short 2>/dev/null")).ok;

    if (dockerPresent && composePresent) {
      return { ok: true, note: "already installed", skipped: true };
    }

    if (config.sudo === "auto") {
      if (!dockerPresent) {
        log.info("Installing Docker via official get.docker.com script…");
        const r = await sudoSh(`bash -c "${INSTALL_SCRIPT}"`);
        if (!r.ok) {
          return {
            ok: false,
            error: "docker install failed",
            stdout: r.stdout,
            stderr: r.stderr,
          };
        }
      }
      if (!composePresent) {
        log.info("Installing docker-compose-plugin…");
        const r = await sudoSh(`bash -c "${COMPOSE_PLUGIN}"`);
        if (!r.ok) {
          return {
            ok: false,
            error: "compose plugin install failed",
            stdout: r.stdout,
            stderr: r.stderr,
          };
        }
      }

      // Add user to docker group (best-effort; takes a fresh login to apply).
      const username = process.env.SUDO_USER ?? process.env.USER;
      if (username && username !== "root") {
        await sudoSh(`usermod -aG docker ${username}`);
        log.warn(
          `Added ${username} to docker group. You may need to \`newgrp docker\` or re-login for the change to take effect in this shell.`,
        );
      }
      return { ok: true, note: "docker + compose installed" };
    }

    // Guide mode — print exact commands for the user.
    const cmds: string[] = [];
    if (!dockerPresent) cmds.push(`curl -fsSL https://get.docker.com | sudo sh`);
    if (!composePresent) {
      cmds.push("sudo apt-get install -y docker-compose-plugin");
    }
    cmds.push(`sudo usermod -aG docker $USER`);
    cmds.push(`newgrp docker`);
    printGuide(cmds, "Docker is missing. Run these in another terminal, then come back.");
    const done = (await confirm({
      message: "Have you finished running the commands above?",
      initialValue: false,
    })) as boolean;
    bail(done);
    if (!done) return { ok: false, error: "user has not installed Docker yet" };
    return { ok: true, note: "user-installed" };
  },
};
