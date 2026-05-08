import { sh, which } from "../lib/shell";
import { sudoSh, sudoExec, printGuide } from "../lib/sudo";
import { confirm, bail } from "../ui/prompts";
import { log } from "../lib/log";
import type { Step } from "../types";

/** Docker daemon reachable via root (avoids docker-group membership requirement). */
async function dockerDaemonUp(): Promise<boolean> {
  // `sudo -n docker info` succeeds if dockerd running. Suppress output.
  const r = await sh("sudo -n docker info >/dev/null 2>&1 || docker info >/dev/null 2>&1");
  return r.ok;
}

async function startDockerDaemon(): Promise<boolean> {
  // Try systemd first; fall back to service.
  let r = await sudoSh("systemctl start docker");
  if (r.ok) return true;
  r = await sudoSh("service docker start");
  return r.ok;
}

const REPO_INSTALL = `
set -e
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker
`.trim();

export const installNvidiaStep: Step = {
  id: "install-nvidia",
  title: "Install NVIDIA Container Toolkit",
  appliesTo: (cfg) => cfg.gpu === "auto",
  async check() {
    if (!(await which("nvidia-ctk"))) return false;
    const r = await sh("docker info --format '{{json .Runtimes}}' 2>/dev/null");
    return r.ok && r.stdout.includes("nvidia");
  },
  async run({ config }) {
    if (!(await which("nvidia-smi"))) {
      return {
        ok: false,
        error:
          "nvidia-smi not found. Install NVIDIA driver first (https://www.nvidia.com/Download/index.aspx) then re-run.",
      };
    }

    // The toolkit configure command + probe both require dockerd to be running.
    // After a fresh `get.docker.com` install, the daemon is usually started by
    // the postinst — but be defensive.
    if (!(await dockerDaemonUp())) {
      log.info("Docker daemon not reachable — attempting to start it…");
      if (!(await startDockerDaemon())) {
        return {
          ok: false,
          error:
            "Docker daemon is not running. Start it (`sudo systemctl start docker`) and re-run.",
        };
      }
    }

    const ctkPresent = !!(await which("nvidia-ctk"));
    // Use sudo for `docker info` so docker-group membership isn't required —
    // matters when this step runs right after a fresh Docker install in the
    // same session (group changes apply only on next login).
    const dockerInfo = await sudoExec(["docker", "info", "--format", "{{json .Runtimes}}"]);
    const dockerNvidia = dockerInfo.ok && dockerInfo.stdout.includes("nvidia");

    if (ctkPresent && dockerNvidia) {
      return { ok: true, note: "toolkit already wired", skipped: true };
    }

    if (config.sudo === "auto") {
      log.info("Installing NVIDIA Container Toolkit + wiring into Docker…");
      const r = await sudoSh(`bash -c '${REPO_INSTALL.replace(/'/g, "'\\''")}'`);
      if (!r.ok) {
        return {
          ok: false,
          error: "nvidia toolkit install failed",
          stdout: r.stdout,
          stderr: r.stderr,
        };
      }

      // Verify via test container — run via sudo so it works even when the
      // current shell isn't yet in the docker group (fresh install case).
      const probe = await sudoExec([
        "docker",
        "run",
        "--rm",
        "--gpus",
        "all",
        "--entrypoint",
        "nvidia-smi",
        "ollama/ollama:latest",
      ]);
      if (!probe.ok) {
        log.warn(
          "Toolkit installed but GPU probe failed. If your shell isn't in the `docker` group yet, that's expected — the daemon-side check via sudo will pass on next runs.",
        );
      }
      return { ok: true, note: "toolkit configured" };
    }

    const cmds = [
      "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
      "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list",
      "sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit",
      "sudo nvidia-ctk runtime configure --runtime=docker",
      "sudo systemctl restart docker",
      "docker run --rm --gpus all --entrypoint nvidia-smi ollama/ollama:latest",
    ];
    printGuide(cmds, "Install NVIDIA Container Toolkit so Docker can pass GPUs into containers.");
    const done = (await confirm({
      message: "Has the toolkit been installed and `docker info` now shows nvidia runtime?",
      initialValue: false,
    })) as boolean;
    bail(done);
    if (!done) return { ok: false, error: "toolkit not installed" };
    return { ok: true, note: "user-installed" };
  },
};
