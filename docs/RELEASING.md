# Releasing Orqestra

For the maintainer (you). End users curl `install.sh` and don't see this.

## TL;DR

```bash
# 1. Bump version
sed -i 's/"version": ".*"/"version": "0.2.0"/' apps/installer/package.json

# 2. Build all 4 binaries
pnpm --filter @orqestra/installer build:all

# 3. Tag + push
git add . && git commit -m "Release v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0

# 4. Publish GitHub Release with binaries attached
gh release create v0.2.0 \
  --repo manavvgarg/Orqestra \
  --title "Orqestra v0.2.0" \
  --notes-file CHANGELOG.md \
  apps/installer/dist/orqestra-install-linux-x64 \
  apps/installer/dist/orqestra-install-linux-arm64 \
  apps/installer/dist/orqestra-install-darwin-x64 \
  apps/installer/dist/orqestra-install-darwin-arm64
```

That's it. End users running the curl one-liner pick up the new binary automatically (`scripts/install.sh` defaults to `latest`).

## Architecture of the release

```
end user runs:  curl -fsSL .../scripts/install.sh | bash
                                │
                                ▼
                  scripts/install.sh (lives in repo)
                                │
                detects OS+arch, aborts on Windows
                                │
                                ▼
            downloads from GitHub Releases:
            orqestra-install-{linux,darwin}-{x64,arm64}
                                │
                                ▼
                     runs binary interactively
                                │
                                ▼
                   binary clones repo @ ref,
                   writes .env, runs Docker build,
                   boots stack
```

So a "release" is just:

1. The current `main` branch source (binary clones it at install time).
2. Four pre-compiled binaries attached to a tagged GitHub Release.

`scripts/install.sh` lives in the repo on `main` and is fetched fresh every time. Its only job is to download a binary.

## First-time repo setup

If you haven't pushed yet:

```bash
cd ~/projects/Orqestra

# Initialize + commit
git init
git add .
git commit -m "v0.1.0 initial release"

# Create on GitHub
gh repo create manavvgarg/Orqestra --public --source=. --push
```

If repo exists but no remote:

```bash
git remote add origin git@github.com:manavvgarg/Orqestra.git
git push -u origin main
```

## Per-release checklist

| # | Step | Why |
|---|------|-----|
| 1 | Bump `apps/installer/package.json` version | Shows in installer banner |
| 2 | Update `CHANGELOG.md` (or release notes) | Users want to know what changed |
| 3 | Run `pnpm typecheck` clean | TS errors → broken installer |
| 4 | `go vet ./...` in both orchestrators | Go syntax errors catch here |
| 5 | Locally test: `cd apps/installer && pnpm dev` | Confirm flow before compile |
| 6 | `pnpm --filter @orqestra/installer build:all` | Produces 4 binaries |
| 7 | Test one binary on a fresh box | Catches OS-specific bugs |
| 8 | Commit, tag `vX.Y.Z`, push | Release point |
| 9 | `gh release create` with binaries | Makes them downloadable |
| 10 | Smoke-test the curl one-liner | Confirms the full path works |

## Building binaries

```bash
cd ~/projects/Orqestra
pnpm install   # if deps changed
pnpm --filter @orqestra/installer build:all
```

Output:

```
apps/installer/dist/
├── orqestra-install-linux-x64       (~30 MB)
├── orqestra-install-linux-arm64
├── orqestra-install-darwin-x64
└── orqestra-install-darwin-arm64
```

Each is a Bun-compiled single binary — no Node/Bun runtime needed at the destination, no npm install on user machine.

Cross-compilation works because Bun ships the runtime per platform inside the binary. You can build all 4 from one host (any of Linux/macOS/x64/arm64).

## Tagging

```bash
# Make sure main is pushed first
git push origin main

# Tag
git tag v0.2.0
git push origin v0.2.0
```

Use semver:

- `v0.X.0` for new features
- `v0.X.Y` for bug fixes
- `v1.0.0` when you're ready to commit to API stability

## Publishing the release

```bash
gh release create v0.2.0 \
  --repo manavvgarg/Orqestra \
  --title "Orqestra v0.2.0" \
  --notes "..." \
  apps/installer/dist/orqestra-install-*
```

Or with notes from a file:

```bash
gh release create v0.2.0 \
  --notes-file CHANGELOG.md \
  apps/installer/dist/orqestra-install-*
```

Or interactively:

```bash
gh release create v0.2.0 apps/installer/dist/orqestra-install-*
# editor opens for the notes
```

Verify:

```bash
gh release view v0.2.0 --repo manavvgarg/Orqestra
# Should list 4 attached assets named orqestra-install-{platform}-{arch}
```

## Smoke-testing the released installer

```bash
# Fresh VM or container — anywhere that's not your dev box
ssh fresh-vm
curl -fsSL https://raw.githubusercontent.com/manavvgarg/Orqestra/main/scripts/install.sh | bash
```

Should:

1. Download the binary you just released
2. Show the banner
3. Walk through prompts

If `install.sh` itself broke (e.g. arch detection regression), fix it on `main` and push — no new release needed since the script is fetched live.

## Optional — branded short URL

If you want `orqestra.xyz/install.sh` as the curl target:

### Cloudflare Worker

`worker.js`:

```js
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
# Deploy
npx wrangler deploy --name orqestra-install worker.js
```

### Route

In Cloudflare dashboard: **Workers & Pages → orqestra-install → Triggers → Custom Domains** → add `orqestra.xyz/install.sh`.

After DNS propagation, this works:

```bash
curl -fsSL https://orqestra.xyz/install.sh | bash
```

300-second cache means a freshly-pushed `install.sh` change takes up to 5 minutes to reach end users. Force purge in CF dashboard if needed.

## Hotfix workflow

```bash
# Edit, commit
git commit -am "Hotfix: bug XYZ"

# Bump patch version
sed -i 's/"version": ".*"/"version": "0.2.1"/' apps/installer/package.json

# Re-build + tag + release
pnpm --filter @orqestra/installer build:all
git tag v0.2.1 && git push origin main v0.2.1
gh release create v0.2.1 apps/installer/dist/orqestra-install-* --notes "Fix XYZ"
```

End users running the curl one-liner get the fix on next run.

## Yanking a release

If a release is broken and you need to point users to an older version:

```bash
gh release edit v0.2.0 --draft   # hides from "latest"
```

The `latest` tag now resolves to v0.1.x again. Doesn't delete the release, just removes from the "latest" alias.

To force a specific version permanently:

```bash
# Users can pin to a working version:
curl -fsSL https://raw.githubusercontent.com/manavvgarg/Orqestra/main/scripts/install.sh \
  | bash -s -- --version v0.1.0
```

Or update `scripts/install.sh` to default to a specific version:

```bash
VERSION="${ORQESTRA_INSTALLER_VERSION:-v0.1.0}"   # was "latest"
git commit -am "Pin default install to v0.1.0 while v0.2 is broken"
git push origin main
```

## CI (future work)

Currently manual. To automate:

GitHub Actions workflow on tag push:

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - run: pnpm install
      - run: pnpm --filter @orqestra/installer build:all
      - uses: softprops/action-gh-release@v2
        with:
          files: apps/installer/dist/orqestra-install-*
```

With this, `git push origin v0.2.0` is the entire release flow.

## Versioning of the source vs installer

The installer binary's version is independent of the Orqestra source it clones. The binary clones the repo at the ref the user picks during prompts (defaults to `main`).

That means:

- Releasing a new installer binary doesn't change running deployments.
- Source updates on `main` ship to new installs without a binary release.
- A pinned binary version (`--version v0.1.0`) just defaults to that source ref unless the user overrides.

Update `apps/installer/src/collect-config.ts` `DEFAULT_REF` if you want the installer to default to a stable tag rather than `main`:

```ts
const DEFAULT_REF = "v0.2.0";   // pin source to a stable tag
```
