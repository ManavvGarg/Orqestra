# Installing Orqestra

End-user guide. Two flavors: **local** (laptop / dev box) and **server** (public host with TLS).

## Prerequisites

| Mode | Required | Optional |
|------|----------|----------|
| **local** | Linux or macOS, 4 GB RAM, 20 GB disk | NVIDIA GPU |
| **server** | Linux, public IP, 8 GB RAM, 60 GB disk, root or sudo | NVIDIA GPU, Cloudflare-hosted domain |

Windows is not supported. Use WSL2 if needed.

`install.sh` can install Docker + NVIDIA Container Toolkit for you (with sudo). If you prefer manual installs it prints the exact commands and aborts.

## One-liner

```bash
curl -fsSL https://orqestra.xyz/install.sh | bash
```

If your environment has no controlling TTY (CI, headless), use one of:

```bash
# Process-substitution form (preserves TTY for prompts)
bash <(curl -fsSL https://orqestra.xyz/install.sh)

# Fully non-interactive — uses defaults + ORQESTRA_* env vars
curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --non-interactive
```

## Flags

All optional — `install.sh` prompts otherwise.

| Flag | Env var | Notes |
|------|---------|-------|
| `--mode local\|server` | `ORQESTRA_INSTALL_MODE` | Install profile |
| `--dir <path>` | `ORQESTRA_INSTALL_DIR` | Default `/opt/orqestra` (root) or `~/orqestra` |
| `--repo <url>` | `ORQESTRA_REPO_URL` | Source repo (default: main upstream) |
| `--ref <branch\|tag>` | `ORQESTRA_REPO_REF` | Source ref (default: `main`) |
| `--domain <fqdn>` | `ORQESTRA_SITE_DOMAIN` | Public domain (server mode) |
| `--le-email <addr>` | `ORQESTRA_LETS_ENCRYPT_EMAIL` | Let's Encrypt notifications |
| `--cf-token <token>` | `ORQESTRA_CF_DNS_TOKEN` | Cloudflare API token (Zone.DNS:Edit + Zone.Zone:Read) |
| `--public-ip <ipv4>` | `ORQESTRA_SERVER_PUBLIC_IP` | Wildcard A record target |
| `--gpu auto\|off` | `ORQESTRA_GPU_MODE` | GPU support |
| `--sudo auto\|guide` | `ORQESTRA_SUDO_MODE` | Privileged command behavior |
| `--skip-build` | `ORQESTRA_SKIP_BUILD=1` | Stop after `.env` + network — operator builds/boots manually |
| `--non-interactive` | — | Refuse prompts; rely on flags + env |

## What it does

```
[1]  Check OS                        ✓
[2]  Pre-flight (disk + RAM + ports) ✓
[3]  Check tools (git, curl, openssl)✓
[4]  Ensure Docker + compose         ✓
[5]  NVIDIA Container Toolkit        ✓  (only if --gpu auto)
[6]  Open ports 80 + 443             ✓  (server only)
[7]  Fetch Orqestra source           ✓
[8]  Write .env                      ✓
[9]  Wildcard DNS for *.<domain>     ✓  (server only; CF API or manual)
[10] Create docker proxy network     ✓
[11] Build Docker images             ⏳ ~5–15 min first time
[12] Boot infra (postgres+redis)     ✓
[13] Push DB schema (drizzle-kit)    ✓
[14] Boot app services               ✓
[15] Verify health                   ✓

✓ Orqestra is installed.
```

Server mode targets `https://<domain>`, `https://api.<domain>`, `wss://ws.<domain>`. First HTTPS request triggers Let's Encrypt cert issuance via DNS-01 (~30–60s).

Local mode targets `http://localhost:{3000,4000,4001}`.

## DNS (server mode)

`install.sh` either calls the Cloudflare API (`--cf-token`) or prints the record for you to add manually:

```
Type   Name              Value          TTL   Proxy
A      *.<domain>        <your-ip>      auto  off (DNS-only)
```

> **Always set Cloudflare proxy to "DNS-only"** (grey cloud). Orange cloud breaks DNS-01 ACME and WebSockets.

If the Cloudflare zone for the apex domain isn't on the token's account, the API path falls back to the manual guide automatically.

## Re-running

`install.sh` is idempotent. Re-run any time:

- Existing checkout: `git fetch && checkout && pull --ff-only`
- Existing `.env`: overwritten with current values (regenerates secrets unless `ORQESTRA_*_SECRET` env vars set)
- Existing docker network: skipped
- Already-installed Docker / toolkit: skipped

Persistent secrets across re-runs:

```bash
ORQESTRA_POSTGRES_PASSWORD=... \
ORQESTRA_BETTER_AUTH_SECRET=... \
ORQESTRA_INTERNAL_API_SECRET=... \
  bash <(curl -fsSL https://orqestra.xyz/install.sh) --non-interactive
```

## After install

```bash
# Manage the stack
sudo docker compose -f /opt/orqestra/docker-compose.yml ps
sudo docker compose -f /opt/orqestra/docker-compose.yml logs -f

# Stop (keeps volumes)
sudo docker compose -f /opt/orqestra/docker-compose.yml down

# Stop + DELETE Postgres/Redis volumes
sudo docker compose -f /opt/orqestra/docker-compose.yml down -v
```

Open the Web URL and register the first user (becomes admin).

## Uninstalling

```bash
sudo docker compose -f /opt/orqestra/docker-compose.yml down -v
sudo docker network rm proxy
sudo docker volume prune -f
sudo rm -rf /opt/orqestra
```

Docker images stay cached — `docker image prune -a` if you want them gone.

## What you get

The dashboard exposes four workload types:

- **Jupyter** — notebook containers (Base / TensorFlow / PyTorch / R) with persistent volumes and GPU passthrough.
- **Models** — host any model from the catalog (Ollama / Docker Model Runner); each gets an OpenAI-compatible endpoint.
- **Sandboxes** — disposable Linux containers you SSH into, with a generated keypair.
- **Swarms (AgentHive)** — multi-agent orchestration; agents run on OpenAI, any LiteLLM provider, or your hosted local models.

## Known issues

- **First Docker build takes 5–15 minutes.** Pulling 4 Jupyter images (~15 GB total) + Ollama + building TS apps. Subsequent boots reuse cache.
- **First swarm create is slow.** AgentHive builds its Python harness image once on the first swarm; cached after.
- **AgentHive provider keys** (OpenAI / Anthropic / Gemini / …) are entered per-swarm in the UI and live only in the swarm container's env — never written to the database. Re-enter them when editing a swarm.
- **Sandboxes are localhost-only in this release** — public SSH routing is on the roadmap.
- **Cloudflare zone must exist on the account** for auto-DNS mode. Otherwise the script falls back to manual.
- **Docker group membership.** If `install.sh` just installed Docker, you may need `newgrp docker` or re-login before `docker` works without sudo. The installer itself runs docker via sudo to sidestep this.
