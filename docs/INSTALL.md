# Installing Orqestra

End-user guide. Two flavors: **local** (laptop / dev box) and **server** (public host with TLS).

## Prerequisites

| Mode | Required | Optional |
|------|----------|----------|
| **local** | Linux or macOS, 4 GB RAM, 20 GB disk | NVIDIA GPU |
| **server** | Linux, public IP, 8 GB RAM, 60 GB disk, root or sudo | NVIDIA GPU, Cloudflare-hosted domain |

Windows is not supported. Use WSL2 if needed.

The installer can install Docker + NVIDIA Container Toolkit for you (with sudo). If you prefer to install them manually, the installer prints the exact commands and pauses.

## One-liner

```bash
curl -fsSL https://orqestra.xyz/install | bash
```

What that does:

1. Detects your OS + architecture (Linux x64/arm64, macOS Intel/Apple Silicon).
2. Aborts on Windows with a helpful error.
3. Downloads the matching binary from the latest GitHub release.
4. Runs the interactive installer.

To pin a specific version:

```bash
curl -fsSL https://orqestra.xyz/install | bash -s -- --version v0.1.0
```

## What the installer asks you

The flow takes 1–2 minutes of input, then 5–15 minutes of automated work.

### 1. Mode

```
Pick install mode
● Local — laptop or dev box
○ Server — public host + domain
```

Pick **Local** for development; everything binds to localhost ports. Pick **Server** if you have a public IP and want HTTPS + a real domain.

### 2. Install directory

Where the source repo gets cloned. Defaults to `/opt/orqestra` if you're root, `~/orqestra` otherwise.

### 3. Repo + branch

Defaults to `https://github.com/manavvgarg/Orqestra.git` on `main`. Override with `ORQESTRA_REPO_URL` or `ORQESTRA_REPO_REF` env vars if you maintain a fork.

### 4. System privileges

```
Allow the installer to run privileged commands (Docker install,
firewall, NVIDIA toolkit) via sudo?
```

- **Yes (auto):** Installer runs `apt install`, `systemctl restart docker`, `ufw allow`, `nvidia-ctk runtime configure` automatically. Prompts for your sudo password if needed.
- **No (guide):** Installer prints the exact privileged commands and pauses. You run them in another terminal, come back, confirm.

If your shell is already root or has passwordless sudo, this step is silent.

### 5. GPU

If `nvidia-smi` is detected, the installer offers to install the NVIDIA Container Toolkit and wire it into Docker. Accept if you want LLM/Jupyter containers to use the GPU. Decline if you'll only run CPU workloads.

### 6. Domain (server mode only)

```
Public domain (e.g. orqestra.acme.dev)
Email for Let's Encrypt notifications
Public IP for *.<domain> → wildcard A record
```

The installer auto-detects your public IP via `api.ipify.org`. Override if you sit behind NAT or use a different egress IP.

### 7. DNS (server mode only)

```
● I have a Cloudflare API token — auto-create the wildcard record
○ I will add the DNS record myself
```

**Cloudflare auto:** Paste a token with `Zone.DNS:Edit` + `Zone.Zone:Read` scope on the apex domain. The installer creates the wildcard A record via the Cloudflare API.

**Manual:** Installer prints the exact record:

```
Type   Name              Value          TTL   Proxy
A      *.<domain>        <your-ip>      auto  off (DNS-only)
```

You add it at your registrar / DNS provider, then confirm to continue.

> **Always set Cloudflare proxy to "DNS-only"** (grey cloud, not orange). The orange proxy interferes with Let's Encrypt and breaks WebSockets.

### 8. AI diagnostics (optional)

```
Enable AI diagnostics on failures? Pastes Anthropic key for Claude
to debug step failures.
```

If a step fails, you can pick "Diagnose with AI" from the recovery menu. Claude reads the error + filesystem and proposes a fix, which you approve before any commands run. Skip if you don't want LLM cost.

## What runs after the prompts

```
[1/14]  Check OS compatibility               ✓
[2/14]  Pre-flight checks (disk + RAM)       ✓
[3/14]  Check required tools (git, openssl)  ✓
[4/14]  Ensure Docker + compose plugin       ✓ already installed
[5/14]  Install NVIDIA Container Toolkit     ✓ (only if GPU)
[6/14]  Open ports 80 + 443                  ✓ (server only)
[7/14]  Fetch Orqestra source                ✓
[8/14]  Write .env                           ✓
[9/14]  Create proxy network                 ✓
[10/14] Create wildcard DNS via Cloudflare   ✓ (server + CF auto)
[11/14] Build Docker images (slow)           ⏳ ~5 min first time
[12/14] Boot infrastructure                  ✓
[13/14] Push database schema                 ✓
[14/14] Boot application services            ✓
[15/15] Verify health endpoints              ✓

  ✓ Orqestra is live.

  URLs
    Web:        https://orqestra.acme.dev
    API:        https://api.orqestra.acme.dev
    WebSocket:  wss://ws.orqestra.acme.dev
```

First HTTPS request triggers Let's Encrypt cert issuance via DNS-01 — usually 30–60 seconds. After that, requests are instant.

## Recovery

If a step fails:

```
✗ Build Docker images failed: Cannot connect to the Docker daemon socket
What now?
  ● Retry the same step
  ○ Diagnose with AI         (only if you provided an Anthropic key)
  ○ Skip and continue (advanced)
  ○ Abort install
```

State is persisted to `<install-dir>/.orqestra-install.json`. If you abort, re-running the same one-liner picks up at the failed step.

## Re-running

The one-liner is idempotent. Re-run any time to:

- Resume after an aborted install.
- Upgrade — the latest binary fetches the latest source ref + rebuilds.
- Fix a misconfiguration — choose to **not** resume, get fresh prompts.

## After install

1. Open the Web URL and register the first user (becomes admin).
2. Manage the stack:
   ```bash
   docker compose -f /opt/orqestra/docker-compose.yml ps
   docker compose -f /opt/orqestra/docker-compose.yml logs -f
   ```
3. Stop everything (keeps data):
   ```bash
   docker compose -f /opt/orqestra/docker-compose.yml down
   ```
4. Permanent removal (deletes Postgres + Redis volumes):
   ```bash
   docker compose -f /opt/orqestra/docker-compose.yml down -v
   ```

## First-run sanity checks

```bash
# Open Web
open https://orqestra.acme.dev   # macOS
xdg-open https://orqestra.acme.dev   # Linux

# Curl API
curl https://api.orqestra.acme.dev/health
# {"ok":true,...}

# Inspect running containers
docker ps --filter label=orqestra.kind
```

## Known issues

- **First Docker build takes 5–15 minutes.** Pulling 4 Jupyter images (~15 GB total) + Ollama image + building TS apps. Subsequent boots reuse the cache.
- **Cloudflare zone must already exist on the account** for `cloudflare-auto` DNS mode. If your domain isn't on Cloudflare, the installer falls back to manual mode automatically.
- **Docker group membership.** If the installer just installed Docker, your shell may need a re-login (or `newgrp docker`) before non-sudo `docker` commands work. Internal commands during install always use sudo to sidestep this.

## Uninstalling

```bash
docker compose -f /opt/orqestra/docker-compose.yml down -v
docker network rm proxy
docker volume prune -f
sudo rm -rf /opt/orqestra
```

That removes the stack, networks, anonymous volumes, and the cloned source. Docker images stay cached — `docker image prune -a` if you want them gone too.
