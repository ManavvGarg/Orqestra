# Releasing Orqestra

`install.sh` is pure bash and lives in the repo on `main` — fetched live by users. There are no binaries to compile or attach to releases. A "release" is just a git tag pointing at known-good source.

## TL;DR

```bash
# 1. Confirm clean state
pnpm typecheck
go vet ./apps/orchestrator-jupyter/... ./apps/orchestrator-hosting/...

# 2. Tag + push
git tag v0.2.0 && git push origin main v0.2.0

# 3. (Optional) GitHub Release for the changelog
gh release create v0.2.0 --notes-file CHANGELOG.md
```

Users on `curl ... | bash` pick up `main` automatically. Users pinning a tag pass `--ref v0.2.0`.

## Architecture

```
end user runs:  curl -fsSL https://orqestra.xyz/install.sh | bash
                                │
                                ▼
                  scripts/install.sh (lives in repo @ main)
                                │
                detects OS, prompts, runs steps:
                  clone repo @ --ref → write .env → docker network
                  → docker compose build → boot infra → db push
                  → docker compose up -d → curl health endpoints
                                │
                                ▼
                            Live stack
```

`scripts/install.sh` is fetched fresh every run from the Cloudflare Worker proxy. No GitHub Release assets are required.

## Per-release checklist

| # | Step | Why |
|---|------|-----|
| 1 | Update `CHANGELOG.md` | Users want to know what changed |
| 2 | `pnpm typecheck` clean | Catches TS regressions |
| 3 | `go vet ./...` in both orchestrators | Catches Go regressions |
| 4 | Smoke-test: `bash scripts/install.sh --mode local --dir /tmp/orq-test` | Catches install.sh regressions |
| 5 | `git tag vX.Y.Z && git push origin main vX.Y.Z` | Release point |
| 6 | `gh release create vX.Y.Z --notes-file CHANGELOG.md` (optional) | Renders changelog on GitHub |

## Hotfix workflow

```bash
git commit -am "Hotfix: bug XYZ"
git push origin main
git tag v0.2.1 && git push origin v0.2.1
```

Live for all curl-pipe users on next run.

## Pinning users to a known-good ref

If `main` is broken, change the default ref in `scripts/install.sh`:

```bash
REF="${ORQESTRA_REPO_REF:-v0.2.0}"   # was main
git commit -am "Pin default install ref to v0.2.0"
git push origin main
```

Or instruct users explicitly:

```bash
curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --ref v0.2.0
```

## Branded short URL

```js
// Cloudflare Worker proxying GitHub raw → orqestra.xyz/install.sh
export default {
  async fetch() {
    const r = await fetch(
      "https://raw.githubusercontent.com/manavvgarg/Orqestra/main/scripts/install.sh",
    );
    return new Response(r.body, {
      headers: {
        "Content-Type": "text/x-shellscript",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};
```

```bash
npx wrangler deploy --name orqestra-install worker.js
```

300-second cache: a freshly-pushed `install.sh` change reaches users within 5 minutes. Purge in CF dashboard to force-refresh.

## Smoke-testing the released script

```bash
ssh fresh-vm
curl -fsSL https://raw.githubusercontent.com/manavvgarg/Orqestra/main/scripts/install.sh | bash
```

If `install.sh` itself broke, fix on `main` and push — no new tag required.
