# Run commands

Quick reference for **developers running Orqestra from source**.

If you just want to install Orqestra: see [docs/INSTALL.md](docs/INSTALL.md).
If you want to develop / contribute: read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) first, then come back here.

Examples assume you're on `houdini` with browser on a laptop via SSH tunnel.

## Env loader (every shell)

Each terminal that runs an app needs `.env` loaded:

```bash
cd ~/projects/Orqestra
set -a; source .env; set +a
```

Add this alias to your shell rc to save typing:

```bash
alias orq='cd ~/projects/Orqestra && set -a && source .env && set +a'
```

Then just `orq` in any new terminal. 

---

## One-time setup

```bash
cd ~/projects/Orqestra

# Docker network (once per machine)
sudo docker network create proxy

# Install JS deps
pnpm install

# Push DB schema (after schema.ts edits — re-run as needed)
set -a; source .env; set +a
pnpm --filter @orqestra/db db:push

# Tidy Go modules (after go.mod edits)
cd apps/orchestrator-jupyter && go mod tidy && cd -
cd apps/orchestrator-hosting && go mod tidy && cd -
cd apps/orchestrator-sandbox && go mod tidy && cd -
cd apps/orchestrator-agenthive && go mod tidy && cd -
```

---

## Boot infra (once per session)

Postgres + Redis via compose:

```bash
cd ~/projects/Orqestra
sudo docker compose up -d postgres redis
sudo docker compose ps   # confirm healthy
```

Stop infra:
```bash
sudo docker compose stop postgres redis
```

Full reset (DESTROYS DB DATA):
```bash
sudo docker compose down -v
```

---

## Services — 7 terminals

Open 7 terminals on `houdini`. Each needs `set -a; source .env; set +a` first (or use `orq` alias).

### T1 — API (Bun + Hono + tRPC + BullMQ, :4000)

```bash
cd ~/projects/Orqestra
set -a; source .env; set +a
pnpm --filter @orqestra/api dev
```

### T2 — WS (Bun WebSocket, :4001)

```bash
cd ~/projects/Orqestra
set -a; source .env; set +a
pnpm --filter @orqestra/ws dev
```

### T3 — Web (Next.js 15, :3000)

```bash
cd ~/projects/Orqestra
set -a; source .env; set +a
pnpm --filter @orqestra/web dev
```

### T4 — Jupyter orchestrator (Go, :8080)

```bash
cd ~/projects/Orqestra/apps/orchestrator-jupyter
set -a; source ~/projects/Orqestra/.env; set +a
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=192.168.1.4 \
REDIS_URL=redis://localhost:6379 \
PORT=8080 \
go run .
```

> Replace `192.168.1.4` with houdini's LAN IP. Find via:
> ```bash
> hostname -I | awk '{print $1}'
> ```
>
> `REDIS_URL` override: orchestrator runs on host, so `redis://localhost:6379` (port-mapped). Inside compose it's `redis://redis:6379`.

### T5 — Hosting/Models orchestrator (Go, :8081)

```bash
cd ~/projects/Orqestra/apps/orchestrator-hosting
set -a; source ~/projects/Orqestra/.env; set +a
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=192.168.1.4 \
REDIS_URL=redis://localhost:6379 \
PORT=8081 \
go run .
```

### T6 — Sandbox orchestrator (Go, :8082)

```bash
cd ~/projects/Orqestra/apps/orchestrator-sandbox
set -a; source ~/projects/Orqestra/.env; set +a
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=192.168.1.4 \
REDIS_URL=redis://localhost:6379 \
PORT=8082 \
go run .
```

### T7 — AgentHive orchestrator (Go, :8083)

```bash
cd ~/projects/Orqestra/apps/orchestrator-agenthive
set -a; source ~/projects/Orqestra/.env; set +a
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=192.168.1.4 \
REDIS_URL=redis://localhost:6379 \
PORT=8083 \
go run .
```

> First swarm create builds the Python harness image (`orqestra-agenthive-runtime:latest`) — slow once, cached after. Per-swarm harness containers and the model/sandbox containers must share a docker network with the orchestrator; in compose that's `proxy`. Running orchestrators on the host (as above) only works for swarms whose agents are all OpenAI/provider-backed — local-model agents need the harness to reach the model container, so use the compose stack for that path.

---

## Laptop SSH tunnel (separate terminal on laptop)

Tunnel fixed app ports + DMR gateway:

```bash
ssh -N \
  -L 3000:localhost:3000 \
  -L 4000:localhost:4000 \
  -L 4001:localhost:4001 \
  -L 12434:localhost:12434 \
  manav@houdini
```

Browser → http://localhost:3000.

Jupyter container ports come from `LOCAL_PUBLIC_HOST=<houdini-ip>` directly — no tunnel needed for those (orchestrator binds containers on `0.0.0.0` and returns LAN IP in URLs).

---

## Health checks

```bash
curl localhost:4000/health    # api       → {"ok":true,...}
curl localhost:4001/health    # ws        → {"ok":true}
curl localhost:8080/health    # jupyter   → {"ok":true}
curl localhost:8081/health    # hosting   → {"ok":true}
curl localhost:8082/health    # sandbox   → {"ok":true}
curl localhost:8083/health    # agenthive → {"ok":true}
curl -I localhost:3000        # web       → 200
curl -s localhost:12434/engines/v1/models | jq    # DMR gateway
```

---

## DMR (Docker Model Runner)

Replace with sudo-prefixed invocations if your user cannot access the Docker socket directly:
```bash
sudo docker model status            # daemon state + backends
sudo docker model ls                # pulled models
sudo docker model pull ai/smollm2   # pull a model
sudo docker model rm ai/smollm2     # remove
sudo docker port docker-model-runner   # confirm gateway port (default 12434)
```

DMR gateway env override:
```bash
DMR_HOST_PORT=12434 PORT=8081 go run .
```

---

## DB / Drizzle

```bash
# Push schema (dev)
pnpm --filter @orqestra/db db:push

# Generate migration files (when ready for prod)
pnpm --filter @orqestra/db db:generate

# Apply migrations (prod)
pnpm --filter @orqestra/db db:migrate

# Drizzle Studio (browse tables in browser)
pnpm --filter @orqestra/db db:studio
```

---

## Type-checking + lint

```bash
pnpm typecheck            # all workspaces
pnpm lint                 # all workspaces
pnpm --filter @orqestra/api typecheck   # one app
```

---

## Container introspection

```bash
# All Orqestra containers
sudo docker ps --filter label=orqestra.kind

# By kind: jupyter | model | sandbox | swarm
sudo docker ps --filter label=orqestra.kind=jupyter
sudo docker ps --filter label=orqestra.kind=sandbox
sudo docker ps --filter label=orqestra.kind=swarm

# Live logs of one container
sudo docker logs -f orqestra-jupyter-<slug>
sudo docker logs -f orqestra-sandbox-<slug>
sudo docker logs -f orqestra-agenthive-<slug>

# Resource stats
sudo docker stats orqestra-jupyter-<slug>

# Wipe a stuck Jupyter project (destructive — drops volume)
SLUG=<slug>
USERID_NODASHES=$(echo $USER_UUID | tr -d '-')
sudo docker rm -f orqestra-jupyter-$SLUG
sudo docker volume rm orqestra_${USERID_NODASHES}_$SLUG

# Force a rebuild of the AgentHive harness image (picks up harness changes)
sudo docker image rm -f orqestra-agenthive-runtime:latest
sudo docker ps -a --filter label=orqestra.kind=swarm -q | xargs -r sudo docker rm -f
```

---

## Compose reference

```bash
sudo docker compose ps                         # services + health
sudo docker compose logs -f postgres           # tail one service
sudo docker compose logs -f --tail=80          # all services
sudo docker compose restart postgres           # bounce one service
sudo docker compose pull                       # pull new images
sudo docker compose build                      # build app images locally
sudo docker compose up -d                      # full stack (production-style)
sudo docker compose down                       # stop everything (keeps volumes)
sudo docker compose down -v                    # stop + DELETE volumes (destroys DB)
```

---

## Stop everything

```bash
# Ctrl+C in each app terminal (T1-T7)
# Ctrl+C the laptop SSH tunnel
sudo docker compose stop postgres redis

# Or full teardown (keeps volumes):
sudo docker compose down

# Or nuclear (LOSES DATA):
sudo docker compose down -v
sudo docker volume prune -f
```

---

## Handy aliases

Add to `~/.bashrc`:

```bash
alias orq='cd ~/projects/Orqestra && set -a && source .env && set +a'
alias orq-up='cd ~/projects/Orqestra && sudo docker compose up -d postgres redis'
alias orq-down='cd ~/projects/Orqestra && sudo docker compose stop postgres redis'
alias orq-ps='sudo docker ps --filter label=orqestra.kind --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
alias orq-health='for p in 4000 4001 8080 8081 8082 8083 12434; do echo -n "$p: "; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/health 2>/dev/null || echo down; done'
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `DATABASE_URL not set` | Forgot `set -a; source .env; set +a` in that terminal |
| `network proxy not found` | `sudo docker network create proxy` |
| `Port already in use` | `lsof -i :4000` then kill |
| Better Auth 500s on signup | Re-run `pnpm --filter @orqestra/db db:push` |
| Go orchestrator can't reach docker | User in `docker` group? `sudo usermod -aG docker $USER && newgrp docker` |
| Jupyter URL `localhost:<port>` from laptop | Container bound 127.0.0.1; restart T4 with `LOCAL_BIND_IP=0.0.0.0 LOCAL_PUBLIC_HOST=<houdini-ip>` |
| `docker: unknown command: docker model` | Install `docker-model-plugin` |
| DMR gateway connection refused | `sudo docker port docker-model-runner` to confirm port; set `DMR_HOST_PORT` |
| pnpm lockfile drift after pull | `rm -rf node_modules pnpm-lock.yaml && pnpm install` |
| Go toolchain auto-upgrades | `go env -w GOTOOLCHAIN=local` (or install Go 1.25 cleanly) |
| Detail page log panel empty | Orchestrator started without `REDIS_URL=redis://localhost:6379`. Restart T4–T7 with that env var. |
| Tail logs manually | `sudo docker compose exec redis redis-cli PSUBSCRIBE 'container-logs:*'` |
| Swarm agent on a local model 404s / unreachable | Harness can't reach the model container. Use the compose stack (shared `proxy` net); recreate the model project so it has `internal_api_url`, then recreate the swarm. |
| `<model> does not support tools` | Tiny models (e.g. smollm2:135m) can't function-call. Either drop that agent's outgoing flows so it carries no tools, or use a tool-capable model (qwen2.5, llama3.1, mistral). |
| Swarm harness build fails on `apt`/`pip` DNS | Docker build-container DNS broken. Set daemon DNS (`/etc/docker/daemon.json` → `"dns": ["8.8.8.8","1.1.1.1"]`), restart Docker. |
| 429 Too Many Requests on `/trpc/*` | API rate limiter (100 req / 5 min). Wait out the window or `sudo docker compose restart api`. |
