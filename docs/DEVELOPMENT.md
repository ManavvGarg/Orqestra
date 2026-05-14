# Self-host from source

For users who want to **clone the repo and run it themselves** instead of using `install.sh`. This is the right path if you:

- Want to modify the code (UI, schema, orchestrator behavior).
- Want to vendor your own Docker images / catalogs.
- Are contributing back upstream.

If you just want to install + run Orqestra, use [INSTALL.md](INSTALL.md) instead.

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | 20+ | pnpm + Drizzle Kit + Next.js |
| pnpm | 9+ | Monorepo package manager |
| Bun | 1.1+ | Runs the API + WS apps |
| Go | 1.25+ | All four orchestrators (jupyter, hosting, sandbox, agenthive) |
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
ORCHESTRATOR_SANDBOX_URL=http://localhost:8082
ORCHESTRATOR_AGENTHIVE_URL=http://localhost:8083
INTERNAL_API_CALLBACK_BASE=http://api:4000
SITE_DOMAIN=localhost
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4001
```

> `INTERNAL_API_CALLBACK_BASE` is the URL the AgentHive Python harness uses to call back into the API to persist agent messages. In compose it's `http://api:4000`; running the API on the host instead, use `http://<host-lan-ip>:4000`.

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

# T6 Sandbox orchestrator
cd apps/orchestrator-sandbox
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=$(hostname -I | awk '{print $1}') \
REDIS_URL=redis://localhost:6379 \
PORT=8082 go run .

# T7 AgentHive orchestrator
cd apps/orchestrator-agenthive
SITE_DOMAIN=localhost \
LOCAL_BIND_IP=0.0.0.0 \
LOCAL_PUBLIC_HOST=$(hostname -I | awk '{print $1}') \
REDIS_URL=redis://localhost:6379 \
PORT=8083 go run .
```

Each terminal needs `set -a; source .env; set +a` first (or `orq` alias from RUN_COMMANDS).

> AgentHive note: the orchestrator builds a Python harness image on first swarm create and runs one harness container per swarm. Swarms using **local-model** agents need the harness to reach the model container over a shared docker network — run the full compose stack for that path rather than host-mode orchestrators.

Open http://localhost:3000 in a browser → register → done.

If your browser is on a different machine (laptop), see [RUN_COMMANDS.md § SSH tunnel](../RUN_COMMANDS.md#laptop-ssh-tunnel-separate-terminal-on-laptop).

## Run via Docker compose (production-style)

The same code can run fully containerized using `docker-compose.yml`. Slower iteration but matches what `scripts/install.sh` produces:

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
| Modify Go orchestrator | Ctrl+C T4–T7, `go run .` again |
| Modify AgentHive harness (`harness.go`) | Rebuild orchestrator, then `docker image rm -f orqestra-agenthive-runtime:latest` so it rebuilds; recreate affected swarms |
| Type-check everything | `pnpm typecheck` |

## Project layout

```
apps/
  api/                    # Bun + Hono + tRPC + BullMQ
  ws/                     # Bun WebSocket
  orchestrator-jupyter/   # Go + Gin (creates Jupyter containers)
  orchestrator-hosting/   # Go + Gin (creates Ollama containers + DMR)
  orchestrator-sandbox/   # Go + Gin (SSH Linux sandboxes)
  orchestrator-agenthive/ # Go + Gin (multi-agent swarms; embeds Python harness)
  web/                    # Next.js 15

packages/
  db/      # Drizzle schema + client + migrations
  trpc/    # Routers + types (web + api both consume)
  env/     # t3-env validated env schemas
  models/  # Catalog refresh logic (HuggingFace + Hub + Ollama)
```

## Test the installer locally

`scripts/install.sh` is pure bash; no build step. Test against a fork or branch:

```bash
ORQESTRA_REPO_URL=https://github.com/your-fork/Orqestra.git \
ORQESTRA_REPO_REF=feature-branch \
  bash scripts/install.sh --mode local --dir /tmp/orq-test --skip-build
```

`--skip-build` stops after `.env` + network creation so you can iterate without 5–15 minute Docker builds.

## Tests

There are none yet — this is v0.1. The verify step in `install.sh` (curl health endpoints) is the smoke test.

## Common issues

| Symptom | Fix |
|---------|-----|
| `DATABASE_URL not set` | `set -a; source .env; set +a` in that terminal |
| `network proxy not found` | `docker network create proxy` |
| Bun compile error after editing tRPC | Cold-restart T1, hot reload doesn't always pick up router changes |
| Go orchestrator can't reach Docker socket | Add user to `docker` group + `newgrp docker` |
| Empty log panel on detail page | Restart T4–T7 with `REDIS_URL=redis://localhost:6379` |
| pnpm lockfile drift | `rm -rf node_modules pnpm-lock.yaml && pnpm install` |
| Go toolchain auto-upgrades to newer than installed | `go env -w GOTOOLCHAIN=local` |
| Swarm agent on a local model unreachable / 404 | Run the compose stack so the harness shares the `proxy` net with the model container; recreate the model project, then the swarm |
| `<model> does not support tools` | Use a tool-capable model, or remove that agent's outgoing flows so it carries no tools |

Full troubleshooting table in [RUN_COMMANDS.md](../RUN_COMMANDS.md).

## Contributing

PRs welcome. Small focused changes preferred over sweeping refactors.

Before opening a PR:

```bash
pnpm typecheck   # all workspaces — includes `go vet` for every orchestrator
```

Each orchestrator's `pnpm typecheck` runs `go vet ./...`. To vet one directly:

```bash
cd apps/orchestrator-agenthive && go vet ./...
```

If your change touches the schema, also run `pnpm --filter @orqestra/db db:push` against a fresh Postgres so you confirm the migration applies cleanly.
