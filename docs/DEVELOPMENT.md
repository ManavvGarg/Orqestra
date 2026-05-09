# Self-host from source

For users who want to **clone the repo and run it themselves** instead of using the binary installer. This is the right path if you:

- Want to modify the code (UI, schema, orchestrator behavior).
- Want to vendor your own Docker images / catalogs.
- Don't trust pre-built binaries.
- Are contributing back upstream.

If you just want to install + run Orqestra, use [INSTALL.md](INSTALL.md) instead.

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | 20+ | pnpm + Drizzle Kit + Next.js |
| pnpm | 9+ | Monorepo package manager |
| Bun | 1.1+ | Runs the API + WS apps + compiles installer |
| Go | 1.25+ | Both orchestrators |
| Docker + compose | 24+ | Runs Postgres + Redis + everything else |
| Git, openssl | any | Clone + secret generation |

Optional:

| Tool | Why |
|------|-----|
| `nvidia-smi` + NVIDIA Container Toolkit | GPU support |
| Docker Model Runner plugin | For DMR-runtime LLM hosting |

## Clone

```bash
git clone https://github.com/manavvgarg/Orqestra.git
cd Orqestra
pnpm install
```

## Configure

```bash
cp .env.example .env
```

Edit `.env`. Minimum for local dev:

```env
POSTGRES_PASSWORD=dev
DATABASE_URL=postgresql://orqestra:dev@localhost:5432/orqestra
REDIS_URL=redis://localhost:6379
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
BETTER_AUTH_URL=http://localhost:4000
INTERNAL_API_SECRET=$(openssl rand -hex 32)
ORCHESTRATOR_JUPYTER_URL=http://localhost:8080
ORCHESTRATOR_HOSTING_URL=http://localhost:8081
SITE_DOMAIN=localhost
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4001
```

Generate secrets with:

```bash
{
  echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
  echo "INTERNAL_API_SECRET=$(openssl rand -hex 32)"
} >> .env
```

Don't commit `.env` — it's in `.gitignore`.

## Boot infrastructure

```bash
docker network create proxy   # one time
docker compose up -d postgres redis
docker compose ps             # confirm both healthy
```

## Push DB schema

```bash
set -a; source .env; set +a
pnpm --filter @orqestra/db db:push
```

Type `y` if prompted.

## Run apps

Five terminals — see [RUN_COMMANDS.md](../RUN_COMMANDS.md) for the full reference. Quick version:

```bash
# T1 API
pnpm --filter @orqestra/api dev

# T2 WS
pnpm --filter @orqestra/ws dev

# T3 Web
pnpm --filter @orqestra/web dev

# T4 Jupyter orchestrator
cd apps/orchestrator-jupyter
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=$(hostname -I | awk '{print $1}') \
REDIS_URL=redis://localhost:6379 \
PORT=8080 go run .

# T5 Hosting orchestrator
cd apps/orchestrator-hosting
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=$(hostname -I | awk '{print $1}') \
REDIS_URL=redis://localhost:6379 \
PORT=8081 go run .
```

Each terminal needs `set -a; source .env; set +a` first (or `orq` alias from RUN_COMMANDS).

Open http://localhost:3000 in a browser → register → done.

If your browser is on a different machine (laptop), see [RUN_COMMANDS.md § SSH tunnel](../RUN_COMMANDS.md#laptop-ssh-tunnel-separate-terminal-on-laptop).

## Run via Docker compose (production-style)

The same code can run fully containerized using `docker-compose.yml`. Slower iteration but matches what the binary installer does:

```bash
docker compose up -d
```

This builds + boots every service (Traefik, api, ws, orchestrators, web) inside Docker. Use `pnpm dev` flow during active development; use compose to test the production path.

## Development loop

| Action | Command |
|--------|---------|
| Add a tRPC procedure | Edit `packages/trpc/src/routers/*.ts`, hot-reloads in T1+T3 |
| Add DB column | Edit `packages/db/src/schema.ts`, then `pnpm --filter @orqestra/db db:push` |
| Inspect DB | `pnpm --filter @orqestra/db db:studio` opens Drizzle Studio |
| Add Web page | Drop into `apps/web/app/(dashboard)/...`, hot-reloads |
| Modify Go orchestrator | Ctrl+C T4 or T5, `go run .` again |
| Type-check everything | `pnpm typecheck` |

## Project layout

```
apps/
  api/                   # Bun + Hono + tRPC + BullMQ
  ws/                    # Bun WebSocket
  orchestrator-jupyter/  # Go + Gin (creates Jupyter containers)
  orchestrator-hosting/  # Go + Gin (creates Ollama containers + DMR)
  web/                   # Next.js 15
  installer/             # Bun-compiled installer binary

packages/
  db/      # Drizzle schema + client + migrations
  trpc/    # Routers + types (web + api both consume)
  env/     # t3-env validated env schemas
  models/  # Catalog refresh logic (HuggingFace + Hub + Ollama)
```

## Build the installer locally

If you want to test the installer itself without publishing a release:

```bash
# Run in dev (no compile)
cd apps/installer
pnpm install
pnpm dev

# Or build a binary for your arch
pnpm build           # outputs apps/installer/dist/orqestra-install
./dist/orqestra-install
```

Cross-arch builds:

```bash
pnpm --filter @orqestra/installer build:all
ls apps/installer/dist/
# orqestra-install-linux-x64
# orqestra-install-linux-arm64
# orqestra-install-darwin-x64
# orqestra-install-darwin-arm64
```

To release these as a new version, see [RELEASING.md](RELEASING.md).

## Tests

There are none yet — this is v0.1. The verify step in the installer (curl health endpoints) is the smoke test.

## Common issues

| Symptom | Fix |
|---------|-----|
| `DATABASE_URL not set` | `set -a; source .env; set +a` in that terminal |
| `network proxy not found` | `docker network create proxy` |
| Bun compile error after editing tRPC | Cold-restart T1, hot reload doesn't always pick up router changes |
| Go orchestrator can't reach Docker socket | Add user to `docker` group + `newgrp docker` |
| Empty log panel on detail page | Restart T4/T5 with `REDIS_URL=redis://localhost:6379` |
| pnpm lockfile drift | `rm -rf node_modules pnpm-lock.yaml && pnpm install` |
| Go toolchain auto-upgrades to newer than installed | `go env -w GOTOOLCHAIN=local` |

Full troubleshooting table in [RUN_COMMANDS.md](../RUN_COMMANDS.md).

## Contributing

PRs welcome. Small focused changes preferred over sweeping refactors.

Before opening a PR:

```bash
pnpm typecheck   # all workspaces compile
go vet ./apps/orchestrator-jupyter/... && go vet ./apps/orchestrator-hosting/...
```

If your change touches the schema, also run `pnpm --filter @orqestra/db db:push` against a fresh Postgres so you confirm the migration applies cleanly.
