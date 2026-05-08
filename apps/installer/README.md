# @orqestra/installer

Single-binary installer for Orqestra. Downloads the source, writes a validated `.env`, builds Docker images, boots the stack, and verifies health.

If a step fails and you provided an Anthropic API key, an agent (Claude Opus 4.7 with adaptive thinking) investigates the failure with `run_command`, `read_file`, and `grep` tools, then proposes commands you approve before anything mutates state.

## How users run it

```bash
curl -fsSL https://install.orqestra.xyz | bash
```

That fetches `scripts/install.sh`, which downloads the right per-arch binary from GitHub Releases and runs it. Linux (x64/arm64) and macOS (Intel/Apple Silicon). **Windows aborts with a message.**

## What the installer does

| # | Step | What |
|---|------|------|
| 1 | check-os | Detect distro; abort on Windows |
| 2 | check-docker | Ensure `docker` + `docker compose` are present and the daemon is reachable |
| 3 | check-tools | Ensure `git` + `openssl` are present |
| 4 | clone-repo | `git clone <repo>@<ref>` into the install dir |
| 5 | write-env | Write `.env` from collected prompts + `openssl rand -hex 32` secrets |
| 6 | docker-network | Create the shared `proxy` network |
| 7 | build-images | `docker compose build` (slow first time) |
| 8 | boot-infra | Boot postgres + redis (+ traefik in server mode), wait for healthy |
| 9 | db-push | Run `drizzle-kit push` against the new Postgres |
| 10 | boot-apps | `docker compose up -d` for everything else |
| 11 | verify | curl health endpoints until they 200 |

Resumable: state is persisted to `.orqestra-install.json` in the install dir; re-running the binary asks if you want to resume from the last failed step.

## Failure recovery

When a step fails, the user gets four choices:

```
[r] Retry  [d] Diagnose with AI  [s] Skip  [a] Abort
```

`d` is offered only if the user pasted an Anthropic API key during config collection. The diagnostic agent:

- Has access to `run_command`, `read_file`, `grep`, `ask_user`, `propose_fix` tools
- Cannot mutate state itself — only the user-approved commands run
- Hard-capped at 8 turns, then bails to "couldn't determine root cause"
- Caches the system prompt (Orqestra arch + common failure modes) for cheap repeat invocations

## Build

Per-arch single binaries via `bun build --compile`:

```bash
pnpm --filter @orqestra/installer build:all
ls dist/
# orqestra-install-linux-x64
# orqestra-install-linux-arm64
# orqestra-install-darwin-x64
# orqestra-install-darwin-arm64
```

Upload these to a GitHub Release; `scripts/install.sh` resolves them by name.

## Local development

```bash
cd apps/installer
pnpm install
pnpm dev    # bun run src/index.ts
```

Set `ORQESTRA_REPO_URL` and `ORQESTRA_REPO_REF` to point at a local fork during testing.

## Files

```
src/
├── index.ts             # entry — orchestrate steps + recovery
├── collect-config.ts    # interactive prompts → InstallConfig
├── types.ts
├── steps/
│   ├── 00-check-os.ts
│   ├── 01-check-docker.ts
│   ├── 02-check-tools.ts
│   ├── 03-clone-repo.ts
│   ├── 04-write-env.ts
│   ├── 05-network.ts
│   ├── 06-build-images.ts
│   ├── 07-boot-infra.ts
│   ├── 08-db-push.ts
│   ├── 09-boot-apps.ts
│   └── 10-verify.ts
├── agent/
│   ├── diagnose.ts      # @anthropic-ai/sdk toolRunner loop
│   ├── tools.ts         # betaZodTool definitions
│   └── system-prompt.ts # cached
├── ui/prompts.ts
└── lib/
    ├── shell.ts
    ├── log.ts
    ├── env-file.ts
    ├── secrets.ts
    └── state.ts
```

## Adding a new step

1. Create `src/steps/NN-name.ts` exporting a `Step` (`{id, title, run(ctx)}`).
2. Add it to `src/steps/index.ts` in the right position.
3. The step engine handles retry / diagnose / skip / abort UX automatically.
