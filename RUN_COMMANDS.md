# Run commands

Full local-dev reference. Run on `houdini`. Browser on laptop via SSH tunnel.

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
docker network create proxy

# Install JS deps
pnpm install

# Push DB schema (after schema.ts edits — re-run as needed)
set -a; source .env; set +a
pnpm --filter @orqestra/db db:push

# Tidy Go modules (after go.mod edits)
cd apps/orchestrator-jupyter && go mod tidy && cd -
cd apps/orchestrator-hosting && go mod tidy && cd -
```

---

## Boot infra (once per session)

Postgres + Redis via compose:

```bash
cd ~/projects/Orqestra
docker compose up -d postgres redis
docker compose ps   # confirm healthy
```

Stop infra:
```bash
docker compose stop postgres redis
```

Full reset (DESTROYS DB DATA):
```bash
docker compose down -v
```

---

## Services — 5 terminals

Open 5 terminals on `houdini`. Each needs `set -a; source .env; set +a` first (or use `orq` alias).

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
curl localhost:4000/health    # api      → {"ok":true,...}
curl localhost:4001/health    # ws       → {"ok":true}
curl localhost:8080/health    # jupyter  → {"ok":true}
curl localhost:8081/health    # hosting  → {"ok":true}
curl -I localhost:3000        # web      → 200
curl -s localhost:12434/engines/v1/models | jq    # DMR gateway
```

---

## DMR (Docker Model Runner)

```bash
docker model status            # daemon state + backends
docker model ls                # pulled models
docker model pull ai/smollm2   # pull a model
docker model rm ai/smollm2     # remove
docker port docker-model-runner   # confirm gateway port (default 12434)
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
docker ps --filter label=orqestra.kind

# Just Jupyter
docker ps --filter label=orqestra.kind=jupyter

# Live logs of one container
docker logs -f orqestra-jupyter-<slug>

# Resource stats
docker stats orqestra-jupyter-<slug>

# Wipe a stuck Jupyter project (destructive — drops volume)
SLUG=<slug>
USERID_NODASHES=$(echo $USER_UUID | tr -d '-')
docker rm -f orqestra-jupyter-$SLUG
docker volume rm orqestra_${USERID_NODASHES}_$SLUG
```

---

## Compose reference

```bash
docker compose ps                         # services + health
docker compose logs -f postgres           # tail one service
docker compose logs -f --tail=80          # all services
docker compose restart postgres           # bounce one service
docker compose pull                       # pull new images
docker compose build                      # build app images locally
docker compose up -d                      # full stack (production-style)
docker compose down                       # stop everything (keeps volumes)
docker compose down -v                    # stop + DELETE volumes (destroys DB)
```

---

## Stop everything

```bash
# Ctrl+C in each app terminal (T1-T5)
# Ctrl+C the laptop SSH tunnel
docker compose stop postgres redis

# Or full teardown (keeps volumes):
docker compose down

# Or nuclear (LOSES DATA):
docker compose down -v
docker volume prune -f
```

---

## Handy aliases

Add to `~/.bashrc`:

```bash
alias orq='cd ~/projects/Orqestra && set -a && source .env && set +a'
alias orq-up='cd ~/projects/Orqestra && docker compose up -d postgres redis'
alias orq-down='cd ~/projects/Orqestra && docker compose stop postgres redis'
alias orq-ps='docker ps --filter label=orqestra.kind --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
alias orq-health='for p in 4000 4001 8080 8081 12434; do echo -n "$p: "; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/health 2>/dev/null || echo down; done'
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `DATABASE_URL not set` | Forgot `set -a; source .env; set +a` in that terminal |
| `network proxy not found` | `docker network create proxy` |
| `Port already in use` | `lsof -i :4000` then kill |
| Better Auth 500s on signup | Re-run `pnpm --filter @orqestra/db db:push` |
| Go orchestrator can't reach docker | User in `docker` group? `sudo usermod -aG docker $USER && newgrp docker` |
| Jupyter URL `localhost:<port>` from laptop | Container bound 127.0.0.1; restart T4 with `LOCAL_BIND_IP=0.0.0.0 LOCAL_PUBLIC_HOST=<houdini-ip>` |
| `docker: unknown command: docker model` | Install `docker-model-plugin` |
| DMR gateway connection refused | `docker port docker-model-runner` to confirm port; set `DMR_HOST_PORT` |
| pnpm lockfile drift after pull | `rm -rf node_modules pnpm-lock.yaml && pnpm install` |
| Go toolchain auto-upgrades | `go env -w GOTOOLCHAIN=local` (or install Go 1.25 cleanly) |
| Detail page log panel empty | Orchestrator started without `REDIS_URL=redis://localhost:6379`. Restart T4/T5 with that env var. |
| Tail logs manually | `docker compose exec redis redis-cli PSUBSCRIBE 'container-logs:*'` |
