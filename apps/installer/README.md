# @orqestra/installer

Single-binary installer for Orqestra. Bun-compiled, ~30 MB per arch. End-user docs live at [`docs/INSTALL.md`](../../docs/INSTALL.md). Maintainer docs at [`docs/RELEASING.md`](../../docs/RELEASING.md). This README is for people working **on** the installer.

## How users run it

```bash
curl -fsSL https://orqestra.xyz/install | bash
```

`scripts/install.sh` (in repo root) detects OS+arch, aborts on Windows, downloads the matching binary from the latest GitHub release, runs it.

## What the installer does

| # | Step | Notes |
|---|------|-------|
| 1 | check-os | Linux + macOS only; Windows aborts |
| 2 | preflight | Disk free + RAM + ports 80/443 (server only) |
| 3 | check-tools | git, openssl |
| 4 | install-docker | Auto-install via `get.docker.com` if sudo allowed; otherwise prints commands |
| 5 | install-nvidia | Auto-install NVIDIA Container Toolkit if GPU + sudo |
| 6 | firewall | `ufw allow 80/443` (server only) |
| 7 | clone-repo | `git clone <repoUrl>@<repoRef>` |
| 8 | write-env | Generates `.env` with `openssl rand -hex 32` secrets |
| 9 | network | `docker network create proxy` |
| 10 | cloudflare-dns | Creates wildcard A record via CF API (server + token) |
| 10b | dns-manual-guide | Prints record table, waits for confirm (server + manual) |
| 11 | build-images | `docker compose build` (slow first time) |
| 12 | boot-infra | postgres + redis (+ traefik in server mode) |
| 13 | db-push | `drizzle-kit push` |
| 14 | boot-apps | full `docker compose up -d` |
| 15 | verify | Curl health endpoints until 200 |

Steps with `appliesTo` are filtered against the live config — server-only / GPU-only / DNS-mode-specific drop out for local installs.

State persists to `<install-dir>/.orqestra-install.json`. Re-running resumes from the last failed step.

## Failure recovery

```
✗ <step> failed: <error>
What now?
  ● Retry the same step
  ○ Diagnose with AI         (only if config.anthropicApiKey)
  ○ Skip and continue (advanced)
  ○ Abort install
```

Diagnostic agent (Claude Opus 4.7 via Anthropic SDK) gets `run_command`, `read_file`, `grep`, `ask_user`, `propose_fix` tools. Capped at 8 turns. System prompt is cached. Cost ~$0.05–0.40 per failed step diagnosis.

## File layout

```
apps/installer/
├── package.json
├── tsconfig.json
├── README.md                 # this file
├── src/
│   ├── index.ts              # entry — orchestrates steps + recovery
│   ├── collect-config.ts     # interactive prompts → InstallConfig
│   ├── types.ts              # Step, InstallConfig, etc.
│   ├── steps/
│   │   ├── 00-check-os.ts
│   │   ├── 00-preflight.ts
│   │   ├── 01-install-docker.ts
│   │   ├── 02-install-nvidia.ts
│   │   ├── 02-check-tools.ts
│   │   ├── 03-firewall.ts
│   │   ├── 03-clone-repo.ts
│   │   ├── 04-dns.ts
│   │   ├── 04-write-env.ts
│   │   ├── 05-network.ts
│   │   ├── 06-build-images.ts
│   │   ├── 07-boot-infra.ts
│   │   ├── 08-db-push.ts
│   │   ├── 09-boot-apps.ts
│   │   ├── 10-verify.ts
│   │   └── index.ts          # ordered list with appliesTo
│   ├── agent/
│   │   ├── diagnose.ts       # @anthropic-ai/sdk toolRunner loop
│   │   ├── tools.ts          # betaZodTool definitions
│   │   └── system-prompt.ts  # cached
│   ├── ui/
│   │   └── prompts.ts        # @clack/prompts wrapper
│   └── lib/
│       ├── shell.ts          # exec, sh, which
│       ├── sudo.ts           # isRoot, hasPasswordlessSudo, sudoSh, printGuide
│       ├── log.ts            # banner + step formatter
│       ├── env-file.ts       # writes .env from InstallConfig
│       ├── secrets.ts        # openssl rand wrapper
│       └── state.ts          # resume-on-rerun
```

(File numbering is cosmetic; engine runs in `steps/index.ts` array order, not filename order.)

## Development

```bash
cd apps/installer
pnpm install

# Run from source (no compile)
pnpm dev

# Compile binary for current arch
pnpm build       # → dist/orqestra-install

# Compile all 4 release arches
pnpm build:all   # → dist/orqestra-install-{linux,darwin}-{x64,arm64}

# Type-check
pnpm typecheck
```

Test against a specific repo without re-releasing:

```bash
ORQESTRA_REPO_URL=https://github.com/your-fork/Orqestra.git \
ORQESTRA_REPO_REF=feature-branch \
  pnpm dev
```

## Adding a new step

1. Create `src/steps/NN-name.ts` exporting a `Step`:
   ```ts
   import type { Step } from "../types";

   export const myStep: Step = {
     id: "my-step",
     title: "Do the thing",
     appliesTo: (cfg) => cfg.mode === "server",   // optional
     async check() { return /* already done? */; }, // optional pre-check
     async run({ config, installDir }) {
       // ...
       return { ok: true, note: "details" };
     },
   };
   ```
2. Import + push into `allSteps` array in `src/steps/index.ts` at the right position.
3. Engine handles retry / diagnose / skip / abort UX automatically.

## Sudo helper

```ts
import { isRoot, hasPasswordlessSudo, sudoSh, sudoExec, printGuide } from "../lib/sudo";

if (config.sudo === "auto") {
  await sudoSh("apt-get install -y foo");
} else {
  printGuide(["sudo apt-get install -y foo"], "Install foo manually:");
  // confirm prompt
}
```

`sudoSh` runs commands directly when EUID is 0, otherwise prefixes with `sudo`. Inherits stdio so password prompt is visible.

## Releasing

See [`docs/RELEASING.md`](../../docs/RELEASING.md) for the full flow. TL;DR:

```bash
pnpm --filter @orqestra/installer build:all
git tag v0.2.0 && git push origin v0.2.0
gh release create v0.2.0 apps/installer/dist/orqestra-install-* --notes "..."
```

End users running the curl one-liner pick up the new binary automatically.
