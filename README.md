# Orqestra

Self-hosted container orchestration for **Jupyter notebooks** and **LLMs**, on one box or many.

- Spin up isolated **Jupyter containers** (Base / TensorFlow / PyTorch / R) with persistent volumes, served at `https://<slug>.<domain>` with token auth.
- Host **LLMs** through Ollama or Docker Model Runner — search the live catalog, pick a model + tag, container exposes an OpenAI-compatible API at `/v1/chat/completions`.
- Live **container logs** + **resource stats** streamed to the dashboard via WebSockets.
- **File explorer** to browse + download files inside any Jupyter container.
- Full **TLS** via Traefik + Let's Encrypt + Cloudflare DNS-01.
- Multi-tenant with auth (Better Auth), tags, multi-select bulk delete.

---

## Install

One command — Linux or macOS, x64 or arm64:

```bash
curl -fsSL https://raw.githubusercontent.com/manavvgarg/Orqestra/main/scripts/install.sh | bash
```

Picks per-arch binary, runs interactive installer.

Two install modes:

| Mode | Use when | What you get |
|------|----------|--------------|
| **local** | Laptop / dev box | Plain HTTP, ports on localhost, no domain |
| **server** | Public host | HTTPS via Traefik, wildcard DNS, full feature set |

Full walkthrough: **[docs/INSTALL.md](docs/INSTALL.md)**.

---

## Stack

| Layer | Tech |
|-------|------|
| Web | Next.js 15 (App Router), Tailwind v4, shadcn-style |
| API | Bun + Hono + tRPC v11 + Better Auth + BullMQ |
| WebSocket | Bun native WS — fans Redis pubsub to browser |
| Orchestrators | Go + Gin + Docker SDK (one for Jupyter, one for hosting/models) |
| Reverse proxy | Traefik v3 + Let's Encrypt (DNS-01 via Cloudflare) |
| Data | PostgreSQL 17 + Drizzle ORM, Redis 7 |
| Catalog | Live `docker model search` + Hub API + Ollama scrape |
| Edge | Cloudflare Worker (optional, for static-site hosting feature) |

---

## Architecture

```
                 browser
                    │
                    ▼
   ┌──────── Traefik (server mode) ────────┐
   │  *.{domain} → routes by Host header   │
   └─┬───────────────┬───────┬─────────────┘
     │               │       │
     ▼               ▼       ▼
   web (3000)    api (4000)  ws (4001)
                     │              │
                     │  ┌───────────┘
                     ▼  ▼
                  Postgres + Redis
                     │
                     ├─→ orchestrator-jupyter (8080) ─→ Docker socket
                     │      └─ creates jupyter/* containers, manages volumes
                     │
                     └─→ orchestrator-hosting (8081) ─→ Docker socket
                            ├─ creates ollama/ollama containers per model
                            ├─ talks to Docker Model Runner via /v1/...
                            └─ scrapes Hub + Ollama for live catalog
```

Container logs + build progress stream:
```
container stdout/stderr
  → orchestrator's logtail goroutine (docker logs -f)
  → Redis PUBLISH container-logs:<projectId>
  → ws server PSUBSCRIBE container-logs:*
  → browser WebSocket
```

---

## Repo layout

```
apps/
  api/                  Bun + Hono + tRPC + BullMQ workers
  ws/                   Bun WebSocket fan-out
  orchestrator-jupyter/ Go + Gin (Jupyter container manager)
  orchestrator-hosting/ Go + Gin (LLM hosting + catalog)
  edge-proxy/           Cloudflare Worker (subdomain → R2, optional)
  web/                  Next.js 15 dashboard
  installer/            Bun-compiled single-binary installer
packages/
  db/                   Drizzle schema + client
  trpc/                 Shared routers + types
  env/                  t3-env validated env schemas
  models/               Catalog refresh logic
docker/
  traefik/              Traefik config + acme.json
  jupyter-images/       Optional custom Jupyter images
  hosting-builder/      Static-site builder (R2 hosting)
scripts/
  install.sh            curl-bash bootstrap
docs/                   Documentation
docker-compose.yml
turbo.json
pnpm-workspace.yaml
```

---

## Documentation

- **[docs/INSTALL.md](docs/INSTALL.md)** — End-user install walkthrough
- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — Clone the repo, run from source, contribute
- **[docs/RELEASING.md](docs/RELEASING.md)** — Maintainer: build binaries, tag, publish releases
- **[RUN_COMMANDS.md](RUN_COMMANDS.md)** — Quick reference for all dev commands
- **[BUILDER.md](BUILDER.md)** — Original spec (kept for reference)

---

## Status

v0.1 — single-server, single-org. Mature local-dev path; server install tested with Cloudflare DNS-01. SaaS multi-tenant is not yet supported (one user pool per install).

---

## License

See [LICENSE](LICENSE).
