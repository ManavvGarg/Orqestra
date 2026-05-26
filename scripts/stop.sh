#!/usr/bin/env bash
# Orqestra stop — bring down all services.
#
# Usage:
#   bash stop.sh
#   bash stop.sh --dir /opt/orqestra
#   bash stop.sh --volumes          # also delete postgres + redis data volumes
#
# Flags:
#   --dir     <path>    Install directory (default /opt/orqestra or ~/orqestra)
#   --volumes           Pass -v to docker compose down (DELETES all data)
#   --sudo auto|guide   Privileged-command behavior

set -Eeuo pipefail

DIR="${ORQESTRA_INSTALL_DIR:-}"
SUDO_MODE="${ORQESTRA_SUDO_MODE:-}"
VOLUMES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     DIR="$2"; shift 2 ;;
    --sudo)    SUDO_MODE="$2"; shift 2 ;;
    --volumes) VOLUMES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ----- Output helpers ---------------------------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_BOLD=$(tput bold); C_RESET=$(tput sgr0)
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_ERR=$(tput setaf 1); C_INFO=$(tput setaf 6)
else
  C_BOLD=; C_RESET=; C_OK=; C_WARN=; C_ERR=; C_INFO=
fi

ok()    { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
err()   { printf '  %s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
fatal() { err "$*"; exit 1; }

trap 'err "Aborted at line $LINENO (exit $?)"' ERR

# ----- Helpers ----------------------------------------------------------------
is_root()  { [ "$(id -u)" -eq 0 ]; }
sudo_run() { is_root && "$@" || sudo "$@"; }

# ----- Resolve install dir ----------------------------------------------------
if [ -z "$DIR" ]; then
  if is_root; then DIR="/opt/orqestra"; else DIR="$HOME/orqestra"; fi
fi
case "$DIR" in "~"*) DIR="$HOME${DIR#~}";; esac
[ -d "$DIR" ] || fatal "Install directory not found: $DIR"
[ -f "$DIR/docker-compose.yml" ] || fatal "docker-compose.yml missing in $DIR"

printf '\n%s▲ Orqestra stop%s\n' "$C_BOLD" "$C_RESET"

# Safety warning before --volumes
if [ "$VOLUMES" -eq 1 ]; then
  printf '\n'
  warn "WARNING: --volumes will permanently delete all postgres + redis data. This cannot be undone."
  printf '\n'
  if [ -t 0 ]; then
    printf '  Continue? [y/N]: '
    IFS= read -r reply || reply=""
    case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 0 ;; esac
  fi
fi

DOWN_FLAGS="--remove-orphans"
[ "$VOLUMES" -eq 1 ] && DOWN_FLAGS="$DOWN_FLAGS -v"

( cd "$DIR" && sudo_run docker compose down $DOWN_FLAGS )

if [ "$VOLUMES" -eq 1 ]; then
  ok "all services stopped + data volumes deleted"
else
  ok "all services stopped"
fi

printf '\n'
echo "    Start:   bash $DIR/scripts/start.sh"
echo "    Reinstall: bash $DIR/scripts/install.sh"
printf '\n'
