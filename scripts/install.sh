#!/usr/bin/env bash
# Orqestra installer bootstrap.
# Usage:  curl -fsSL https://orqestra.xyz/install.sh | bash
#         curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --version v0.1.0
set -euo pipefail

REPO="${ORQESTRA_INSTALLER_REPO:-manavvgarg/Orqestra}"
VERSION="${ORQESTRA_INSTALLER_VERSION:-latest}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --repo)    REPO="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# OS guard — Windows is unsupported.
case "$(uname -s)" in
  Linux*|Darwin*) ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "Windows is not supported. Use WSL2 (Linux) or run on a Linux/macOS host." >&2
    exit 1 ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1 ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Linux*)  PLATFORM=linux ;;
  Darwin*) PLATFORM=darwin ;;
esac

ASSET="orqestra-install-${PLATFORM}-${ARCH}"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/orqestra-install"

echo "▲ Orqestra installer"
echo "  Downloading $ASSET ($VERSION)…"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$BIN"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$BIN"
else
  echo "Need curl or wget." >&2
  exit 1
fi

chmod +x "$BIN"
echo "  Launching installer…"
echo

# When invoked via `curl … | bash`, stdin is the pipe, not a terminal.
# Clack prompts need a TTY — without one, the first prompt sees EOF and
# the installer exits silently. Reattach /dev/tty when available.
if [ -r /dev/tty ]; then
  exec "$BIN" "$@" < /dev/tty
else
  echo "Error: no controlling terminal available." >&2
  echo "Run the installer in an interactive shell, e.g.:" >&2
  echo "  bash <(curl -fsSL https://orqestra.xyz/install.sh)" >&2
  exit 1
fi
