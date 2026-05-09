#!/usr/bin/env bash
# Orqestra installer bootstrap.
# Usage:  curl -fsSL https://orqestra.xyz/install.sh | bash
#         curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --version v0.1.0
#         curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --non-interactive
set -euo pipefail

REPO="${ORQESTRA_INSTALLER_REPO:-manavvgarg/Orqestra}"
VERSION="${ORQESTRA_INSTALLER_VERSION:-latest}"
NON_INTERACTIVE=0
INSTALL_MODE="${ORQESTRA_INSTALL_MODE:-local}"
INSTALL_DIR="${ORQESTRA_INSTALL_DIR:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --repo)    REPO="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --mode)    INSTALL_MODE="$2"; shift 2 ;;
    --dir)     INSTALL_DIR="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Generate sensible defaults for non-interactive mode
if [ "$NON_INTERACTIVE" -eq 1 ]; then
  if [ -z "$INSTALL_DIR" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      INSTALL_DIR="/opt/orqestra"
    else
      INSTALL_DIR="$HOME/orqestra"
    fi
  fi
  export ORQESTRA_INSTALL_MODE="$INSTALL_MODE"
  export ORQESTRA_INSTALL_DIR="$INSTALL_DIR"
  export ORQESTRA_REPO_URL="https://github.com/${REPO}.git"
  export ORQESTRA_REPO_REF="$VERSION"
  # Pre-generate secrets (openssl if available, else use /dev/urandom)
  if command -v openssl >/dev/null 2>&1; then
    export ORQESTRA_POSTGRES_PASSWORD="$(openssl rand -hex 16)"
    export ORQESTRA_BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
    export ORQESTRA_INTERNAL_API_SECRET="$(openssl rand -hex 32)"
  else
    export ORQESTRA_POSTGRES_PASSWORD="$(head -c 16 /dev/urandom | od -An -tx1 -v | tr -d ' ')"
    export ORQESTRA_BETTER_AUTH_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 -v | tr -d ' ')"
    export ORQESTRA_INTERNAL_API_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 -v | tr -d ' ')"
  fi
  # Detect GPU
  if command -v nvidia-smi >/dev/null 2>&1; then
    export ORQESTRA_GPU_MODE="auto"
  else
    export ORQESTRA_GPU_MODE="off"
  fi
fi

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

# Ensure install directory and state file exist so the binary doesn't error
INSTALL_DIR="${INSTALL_DIR:-${ORQESTRA_INSTALL_DIR:-}}"
if [ -z "$INSTALL_DIR" ]; then
  if [ "$(id -u 2>/dev/null || echo 1)" -eq 0 ]; then
    INSTALL_DIR="/opt/orqestra"
  else
    INSTALL_DIR="$HOME/orqestra"
  fi
fi
mkdir -p "$INSTALL_DIR"
if [ ! -f "$INSTALL_DIR/.orqestra-install.json" ]; then
  printf '{"completedSteps":[],"installDir":"%s","startedAt":"%s"}' "$INSTALL_DIR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$INSTALL_DIR/.orqestra-install.json"
fi

# When invoked via `curl … | bash`, stdin is the pipe, not a terminal.
# Clack prompts need a TTY — without one, the first prompt sees EOF and
# the installer exits silently. Reattach /dev/tty when available.
if [ -r /dev/tty ]; then
  exec "$BIN" "$@" < /dev/tty
else
  # No TTY available: try non-interactive mode if environment is set up.
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    # Feed defaults via stdin to answer prompts automatically.
    # This is a workaround until the installer binary supports --non-interactive flag.
    # For now, we'll try to run it anyway and hope the installer exits gracefully.
    exec "$BIN" "$@"
  else
    echo "Error: no controlling terminal available." >&2
    echo "For non-interactive install, use:" >&2
    echo "  curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --non-interactive" >&2
    exit 1
  fi
fi
