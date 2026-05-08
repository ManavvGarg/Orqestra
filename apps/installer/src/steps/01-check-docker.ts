import { sh, which } from "../lib/shell";
import type { Step } from "../types";

export const checkDockerStep: Step = {
  id: "check-docker",
  title: "Check Docker + compose",
  async run() {
    const dockerPath = await which("docker");
    if (!dockerPath) {
      return {
        ok: false,
        error:
          "Docker not found. Install from https://docs.docker.com/engine/install/ then re-run the installer.",
      };
    }

    const ver = await sh("docker version --format '{{.Server.Version}}'");
    if (!ver.ok) {
      return {
        ok: false,
        error:
          "Docker daemon is not reachable. Is dockerd running? On Linux: `sudo systemctl start docker`. Also check your user is in the `docker` group.",
        stdout: ver.stdout,
        stderr: ver.stderr,
      };
    }

    const compose = await sh("docker compose version --short");
    if (!compose.ok) {
      return {
        ok: false,
        error:
          "Docker Compose v2 plugin not found. Install with `sudo apt install docker-compose-plugin` (Debian/Ubuntu) or via Docker Desktop.",
        stdout: compose.stdout,
        stderr: compose.stderr,
      };
    }

    return {
      ok: true,
      note: `docker ${ver.stdout.trim()}, compose ${compose.stdout.trim()}`,
    };
  },
};
