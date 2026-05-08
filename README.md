# Orqestra

Full-stack Docker container orchestration platform.

- Spin up isolated **Jupyter Notebook** containers (Base / TensorFlow / PyTorch / R) with persistent volumes, served via subdomain + token.
- Deploy **static sites** from a GitHub URL — clone → build → upload to Cloudflare R2 → serve at a subdomain.
- Real-time build/run logs streamed over native WebSockets.
- Manage everything from a Next.js 15 dashboard.

## Stack

| Layer | Tech |
|---|---|
| Monorepo | Turborepo + pnpm workspaces |
| API | Bun + Hono + tRPC v11 |
| Auth | Better Auth (Drizzle adapter) |
| WebSockets | Bun native WS |
| Orchestrators | Go 1.23 + Gin + Docker SDK |
| Edge | Cloudflare Workers + Hyperdrive + R2 |
| Web | Next.js 15 (App Router) + shadcn-style + Tailwind v4 |
| DB | PostgreSQL + Drizzle ORM |
| Queue | BullMQ on Redis |
| Reverse proxy | Traefik v3 + Let's Encrypt (Cloudflare DNS) |
| Logs | Pino |

## Layout

```
apps/
  api/                  # Bun + Hono + tRPC + BullMQ workers
  ws/                   # Bun WebSocket log streamer
  orchestrator-jupyter/ # Go + Gin Jupyter container manager
  orchestrator-hosting/ # Go + Gin hosting builder
  edge-proxy/           # Cloudflare Worker (subdomain → R2)
  web/                  # Next.js 15 dashboard
packages/
  db/                   # Drizzle schema + client
  trpc/                 # Shared tRPC routers + types
  env/                  # t3-env validated env schemas
docker/
  traefik/              # Traefik config
  jupyter-images/       # Optional custom Jupyter images
  hosting-builder/      # Builder runner image
docker-compose.yml
turbo.json
pnpm-workspace.yaml
```

## Quick start

```bash
# 1. Install
pnpm install

# 2. Bootstrap secrets
cp .env.example .env
# generate two 32+ char random strings:
openssl rand -hex 32   # → BETTER_AUTH_SECRET
openssl rand -hex 32   # → INTERNAL_API_SECRET

# 3. Create the shared Docker network (once)
docker network create proxy

# 4. Build the hosting-builder image (used by orchestrator-hosting)
docker compose --profile build-only build hosting-builder-image

# 5. Boot infra
docker compose up -d postgres redis traefik

# 6. Push DB schema
pnpm --filter @orqestra/db db:push

# 7. Boot the rest in dev
pnpm dev
```

Local URLs:

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:4000 |
| WS | http://localhost:4001 |
| Orchestrator (Jupyter) | http://localhost:8080 |
| Orchestrator (Hosting) | http://localhost:8081 |

## Production

1. DNS — Cloudflare wildcard record `*.${SITE_DOMAIN} → server IP` (orange-cloud).
2. Issue an API token with **Zone.DNS Edit** for the cert resolver.
3. `docker compose up -d` boots everything; Traefik handles TLS via DNS-01.
4. The Cloudflare Worker (`apps/edge-proxy`) only matters once you flip subdomains for **hosting** projects to the edge. For self-hosted-only setups, skip it — Traefik already handles `*.${SITE_DOMAIN}`.

## Security

- All Go orchestrators require `X-Internal-Secret: ${INTERNAL_API_SECRET}`.
- `docker.sock` is mounted **only** in orchestrator services, never in the API.
- tRPC `protectedProcedure` middleware blocks unauthenticated calls.
- Hono rate limiter caps 100 req / 5 min / IP on the API.
- Jupyter tokens are 16 random bytes (32 hex chars).
- WebSocket `subscribe` messages must include a valid session ID.
- GitHub URLs are regex-validated before clone.

See `BUILDER.md` for the full build spec.
