#!/usr/bin/env bash
# Orqestra start — bring up all services without reinstalling.
#
# Usage:
#   bash start.sh
#   bash start.sh --dir /opt/orqestra
#   bash start.sh --dir ~/orqestra --sudo auto
#
# Flags:
#   --dir  <path>       Install directory (default /opt/orqestra or ~/orqestra)
#   --sudo auto|guide   Privileged-command behavior (default: auto if sudo available)

set -Eeuo pipefail

DIR="${ORQESTRA_INSTALL_DIR:-}"
SUDO_MODE="${ORQESTRA_SUDO_MODE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)  DIR="$2"; shift 2 ;;
    --sudo) SUDO_MODE="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ----- Output helpers ---------------------------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_BOLD=$(tput bold); C_DIM=$(tput dim); C_RESET=$(tput sgr0)
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_ERR=$(tput setaf 1); C_INFO=$(tput setaf 6)
else
  C_BOLD=; C_DIM=; C_RESET=; C_OK=; C_WARN=; C_ERR=; C_INFO=
fi

info()  { printf '  %s•%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()    { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
err()   { printf '  %s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
fatal() { err "$*"; exit 1; }

STEP_N=0
step() { STEP_N=$((STEP_N + 1)); printf '\n%s[%d]%s %s\n' "$C_BOLD" "$STEP_N" "$C_RESET" "$*"; }

trap 'err "Aborted at line $LINENO (exit $?)"' ERR

# ----- Helpers ----------------------------------------------------------------
is_root()  { [ "$(id -u)" -eq 0 ]; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

sudo_run() { is_root && "$@" || sudo "$@"; }

# ----- Resolve install dir ----------------------------------------------------
if [ -z "$DIR" ]; then
  if is_root; then DIR="/opt/orqestra"; else DIR="$HOME/orqestra"; fi
fi
case "$DIR" in "~"*) DIR="$HOME${DIR#~}";; esac
[ -d "$DIR" ] || fatal "Install directory not found: $DIR — run install.sh first."
[ -f "$DIR/.env" ] || fatal ".env missing in $DIR — run install.sh first."
[ -f "$DIR/docker-compose.yml" ] || fatal "docker-compose.yml missing in $DIR — run install.sh first."

# Detect mode from .env
MODE="local"
if grep -q "^SITE_DOMAIN=" "$DIR/.env" && \
   ! grep -q "^SITE_DOMAIN=localhost" "$DIR/.env" && \
   ! grep -q "^SITE_DOMAIN=$" "$DIR/.env"; then
  MODE="server"
fi

# Auto sudo mode
if [ -z "$SUDO_MODE" ]; then
  is_root && SUDO_MODE="auto" || { sudo -n true 2>/dev/null && SUDO_MODE="auto" || SUDO_MODE="auto"; }
fi

printf '\n%s▲ Orqestra start%s\n' "$C_BOLD" "$C_RESET"
info "dir: $DIR | mode: $MODE"

# ----- Ensure proxy network ---------------------------------------------------
step "Docker proxy network"
if sudo_run docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx proxy; then
  ok "exists"
else
  sudo_run docker network create proxy >/dev/null
  ok "created"
fi

# ----- Boot infra -------------------------------------------------------------
step "Boot infra (postgres, redis$([ "$MODE" = "server" ] && echo ", traefik" || echo ""))"
local_services="postgres redis"
[ "$MODE" = "server" ] && local_services="postgres redis traefik"
( cd "$DIR" && sudo_run docker compose up -d $local_services )

# Wait for postgres + redis healthy
info "Waiting for postgres + redis…"
for i in $(seq 1 30); do
  lines=$(cd "$DIR" && sudo_run docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | grep -E 'postgres|redis' || true)
  healthy=$(printf '%s\n' "$lines" | grep -c healthy || true)
  if [ "$healthy" -ge 2 ]; then ok "postgres + redis healthy"; break; fi
  if [ "$i" -eq 30 ]; then fatal "postgres/redis did not become healthy in 30s"; fi
  sleep 1
done

# ----- Boot all app services --------------------------------------------------
step "Boot all services"
( cd "$DIR" && sudo_run docker compose up -d )
ok "all services up"

# ----- Verify -----------------------------------------------------------------
step "Verify health"
failed=()
if [ "$MODE" = "local" ]; then
  targets="api|http://localhost:4000/health ws|http://localhost:4001/health web|http://localhost:3000"
else
  DOMAIN=$(grep "^SITE_DOMAIN=" "$DIR/.env" | cut -d= -f2-)
  targets="api|https://api.$DOMAIN/health ws|https://ws.$DOMAIN/health web|https://$DOMAIN"
fi
for entry in $targets; do
  t="${entry%%|*}"; url="${entry#*|}"
  ok_t=0
  for i in $(seq 1 30); do
    if curl -fsSL --max-time 5 -o /dev/null "$url" 2>/dev/null; then ok_t=1; break; fi
    sleep 2
  done
  if [ "$ok_t" -eq 1 ]; then ok "$t healthy"; else failed+=("$t"); err "$t did not respond at $url"; fi
done
if [ "${#failed[@]}" -gt 0 ]; then
  warn "Some services unhealthy: ${failed[*]}"
  ( cd "$DIR" && sudo_run docker compose logs --tail=80 ${failed[*]} ) || true
  fatal "Start failed."
fi

printf '\n%s✓ Orqestra is running.%s\n\n' "$C_OK$C_BOLD" "$C_RESET"
if [ "$MODE" = "local" ]; then
  echo "    Web:       http://localhost:3000"
  echo "    API:       http://localhost:4000"
  echo "    WebSocket: ws://localhost:4001"
else
  echo "    Web:       https://$DOMAIN"
  echo "    API:       https://api.$DOMAIN"
  echo "    WebSocket: wss://ws.$DOMAIN"
fi
echo
echo "    Logs:  sudo docker compose -f $DIR/docker-compose.yml logs -f"
echo "    Stop:  bash $DIR/scripts/stop.sh"
echo
