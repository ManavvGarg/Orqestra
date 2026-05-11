#!/usr/bin/env bash
# Orqestra installer — single bash script, no binaries.
#
# Usage:
#   curl -fsSL https://orqestra.xyz/install.sh | bash
#   curl -fsSL https://orqestra.xyz/install.sh | bash -s -- --non-interactive
#   bash <(curl -fsSL https://orqestra.xyz/install.sh) --mode server --domain orq.example.com
#
# Flags (all optional — installer prompts otherwise):
#   --mode local|server         Install profile
#   --dir <path>                Install directory (default /opt/orqestra or ~/orqestra)
#   --repo <url>                Source repo URL
#   --ref  <branch|tag>         Source ref
#   --domain <fqdn>             Public domain (server mode)
#   --le-email <addr>           Let's Encrypt email (server mode)
#   --cf-token <token>          Cloudflare DNS API token (server mode)
#   --public-ip <ipv4>          Public IP for wildcard A record (server mode)
#   --gpu auto|off              GPU support
#   --sudo auto|guide           Privileged-command behavior
#   --skip-build                Stop after .env + network; don't build/boot
#   --non-interactive           Refuse to prompt; use defaults + env vars
#
# Environment overrides (same as flags):
#   ORQESTRA_INSTALL_MODE, ORQESTRA_INSTALL_DIR, ORQESTRA_REPO_URL, ORQESTRA_REPO_REF,
#   ORQESTRA_SITE_DOMAIN, ORQESTRA_LETS_ENCRYPT_EMAIL, ORQESTRA_CF_DNS_TOKEN,
#   ORQESTRA_SERVER_PUBLIC_IP, ORQESTRA_GPU_MODE, ORQESTRA_SUDO_MODE,
#   ORQESTRA_POSTGRES_PASSWORD, ORQESTRA_BETTER_AUTH_SECRET, ORQESTRA_INTERNAL_API_SECRET,
#   ORQESTRA_SKIP_BUILD

set -Eeuo pipefail

# NOTE: do NOT touch stdin at top level. When invoked as `curl ... | bash`, the
# script body itself streams in over stdin; reattaching /dev/tty here truncates
# the script. TTY reattach happens inside main() after the pipe has drained.

# ----- Defaults / flags -------------------------------------------------------
MODE="${ORQESTRA_INSTALL_MODE:-}"
DIR="${ORQESTRA_INSTALL_DIR:-}"
REPO="${ORQESTRA_REPO_URL:-https://github.com/manavvgarg/Orqestra.git}"
REF="${ORQESTRA_REPO_REF:-main}"
DOMAIN="${ORQESTRA_SITE_DOMAIN:-}"
LE_EMAIL="${ORQESTRA_LETS_ENCRYPT_EMAIL:-}"
CF_TOKEN="${ORQESTRA_CF_DNS_TOKEN:-}"
PUBLIC_IP="${ORQESTRA_SERVER_PUBLIC_IP:-}"
GPU_MODE="${ORQESTRA_GPU_MODE:-}"
SUDO_MODE="${ORQESTRA_SUDO_MODE:-}"
SKIP_BUILD="${ORQESTRA_SKIP_BUILD:-0}"
NON_INTERACTIVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)            MODE="$2"; shift 2 ;;
    --dir)             DIR="$2"; shift 2 ;;
    --repo)            REPO="$2"; shift 2 ;;
    --ref)             REF="$2"; shift 2 ;;
    --domain)          DOMAIN="$2"; shift 2 ;;
    --le-email)        LE_EMAIL="$2"; shift 2 ;;
    --cf-token)        CF_TOKEN="$2"; shift 2 ;;
    --public-ip)       PUBLIC_IP="$2"; shift 2 ;;
    --gpu)             GPU_MODE="$2"; shift 2 ;;
    --sudo)            SUDO_MODE="$2"; shift 2 ;;
    --skip-build)      SKIP_BUILD=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help)         sed -n '2,30p' "$0"; exit 0 ;;
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

banner()  { printf '\n%s▲ Orqestra installer%s\n\n' "$C_BOLD" "$C_RESET"; }
section() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
info()    { printf '  %s•%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()      { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn()    { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
err()     { printf '  %s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
fatal()   { err "$*"; exit 1; }

STEP_N=0
step() {
  STEP_N=$((STEP_N + 1))
  printf '\n%s[%d]%s %s\n' "$C_BOLD" "$STEP_N" "$C_RESET" "$*"
}

trap 'err "Aborted at line $LINENO (exit $?)"' ERR

# ----- Prompt helpers ---------------------------------------------------------
prompt() {
  # prompt "label" "default" -> echoes value
  local label="$1" default="${2:-}" reply
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
    echo "$default"; return
  fi
  if [ -n "$default" ]; then
    printf '  %s? %s%s [%s]: ' "$C_BOLD" "$label" "$C_RESET" "$default" >&2
  else
    printf '  %s? %s%s: ' "$C_BOLD" "$label" "$C_RESET" >&2
  fi
  IFS= read -r reply || reply=""
  echo "${reply:-$default}"
}

prompt_secret() {
  local label="$1" reply
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then echo ""; return; fi
  printf '  %s? %s%s: ' "$C_BOLD" "$label" "$C_RESET" >&2
  IFS= read -rs reply || reply=""
  echo >&2
  echo "$reply"
}

prompt_yn() {
  # prompt_yn "label" "y|n default" -> echoes y or n
  local label="$1" default="${2:-y}" reply hint
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then echo "$default"; return; fi
  if [ "$default" = "y" ]; then hint="Y/n"; else hint="y/N"; fi
  printf '  %s? %s%s [%s]: ' "$C_BOLD" "$label" "$C_RESET" "$hint" >&2
  IFS= read -r reply || reply=""
  reply="${reply:-$default}"
  case "$reply" in [yY]*) echo y ;; *) echo n ;; esac
}

prompt_choice() {
  # prompt_choice "label" "default" "opt1|opt2|..." -> echoes choice
  local label="$1" default="$2" opts="$3" reply
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then echo "$default"; return; fi
  printf '  %s? %s%s [%s] (%s): ' "$C_BOLD" "$label" "$C_RESET" "$default" "$opts" >&2
  IFS= read -r reply || reply=""
  echo "${reply:-$default}"
}

# ----- Sudo wrapper -----------------------------------------------------------
is_root() { [ "$(id -u)" -eq 0 ]; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

sudo_available() {
  is_root && return 0
  have_cmd sudo
}

sudo_passwordless() {
  is_root && return 0
  sudo -n true 2>/dev/null
}

# Run a command with elevation when EUID != 0. Inherits stdio so password
# prompts are visible.
sudo_run() {
  if is_root; then
    "$@"
  else
    sudo "$@"
  fi
}

# Run a sh -c "..." string with elevation.
sudo_sh() {
  if is_root; then
    bash -c "$1"
  else
    sudo bash -c "$1"
  fi
}

print_guide() {
  local header="$1"; shift
  warn "$header"
  printf '\n'
  for cmd in "$@"; do printf '    %s%s%s\n' "$C_DIM" "$cmd" "$C_RESET"; done
  printf '\n'
}

# ----- OS detect --------------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Linux*)  PLATFORM=linux ;;
    Darwin*) PLATFORM=darwin ;;
    CYGWIN*|MINGW*|MSYS*) fatal "Windows is not supported. Use WSL2 (Linux) or run on a Linux/macOS host." ;;
    *) fatal "Unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) fatal "Unsupported architecture: $(uname -m)" ;;
  esac
}

distro_pretty() {
  if [ -r /etc/os-release ]; then
    awk -F= '/^PRETTY_NAME=/ { gsub(/"/, "", $2); print $2; exit }' /etc/os-release
  elif [ "$PLATFORM" = "darwin" ]; then
    echo "macOS $(sw_vers -productVersion 2>/dev/null || echo)"
  else
    uname -s
  fi
}

# ----- Resource probes --------------------------------------------------------
disk_free_gb() {
  # GB available at the given path (block size 1G). Fall back to /.
  local path="${1:-/}"
  df -BG "$path" 2>/dev/null | awk 'NR==2 {sub(/G/,"",$4); print $4}' || \
    df -g "$path" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0
}

total_ram_gb() {
  if [ "$PLATFORM" = "linux" ] && [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ {printf "%d\n", $2/1024/1024}' /proc/meminfo
  elif [ "$PLATFORM" = "darwin" ]; then
    sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d\n", $1/1024/1024/1024}'
  else
    echo 0
  fi
}

port_in_use() {
  local p="$1"
  if have_cmd ss; then
    ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq ":${p}$"
  elif have_cmd lsof; then
    lsof -i ":$p" -sTCP:LISTEN -P -n 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

detect_gpu() { have_cmd nvidia-smi; }

detect_public_ip() {
  if have_cmd curl; then
    curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || true
  fi
}

rand_hex() {
  local bytes="$1"
  if have_cmd openssl; then
    openssl rand -hex "$bytes"
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 -v | tr -d ' \n'
  fi
}

# ----- Steps ------------------------------------------------------------------
step_check_os() {
  step "Check OS"
  ok "$(distro_pretty) ($PLATFORM/$ARCH)"
}

step_preflight() {
  step "Pre-flight (disk + RAM + ports)"
  local probe_path="/" free ram
  [ -d /var/lib/docker ] && probe_path="/var/lib/docker"
  free="$(disk_free_gb "$probe_path")"
  ram="$(total_ram_gb)"

  local errors=()
  [ "$free" -lt 20 ] 2>/dev/null && errors+=("Only ${free} GB free at ${probe_path}; need ≥ 20 GB.")
  [ "$ram" -lt 4 ]  2>/dev/null && errors+=("Host has ${ram} GB RAM; need ≥ 4 GB.")

  if [ "$MODE" = "server" ]; then
    for p in 80 443; do
      if port_in_use "$p"; then errors+=("Port $p already bound; Traefik needs it free."); fi
    done
  fi

  if [ "${#errors[@]}" -gt 0 ]; then
    for e in "${errors[@]}"; do err "$e"; done
    fatal "Preflight failed."
  fi
  ok "disk ${free} GB free, ${ram} GB RAM"
}

step_check_tools() {
  step "Check tools (git, curl, openssl)"
  local missing=()
  for t in git curl openssl; do have_cmd "$t" || missing+=("$t"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    err "Missing: ${missing[*]}"
    case "$PLATFORM" in
      linux)  warn "Install with: sudo apt install -y ${missing[*]}   (or your distro's equivalent)" ;;
      darwin) warn "Install with: brew install ${missing[*]}" ;;
    esac
    fatal "Required tools missing."
  fi
  ok "git, curl, openssl present"
}

step_install_docker() {
  step "Ensure Docker + compose plugin"
  local need_docker=0 need_compose=0
  have_cmd docker || need_docker=1
  if [ "$need_docker" -eq 0 ]; then
    docker compose version --short >/dev/null 2>&1 || need_compose=1
  else
    need_compose=1
  fi

  if [ "$need_docker" -eq 0 ] && [ "$need_compose" -eq 0 ]; then
    ok "already installed"
    return
  fi

  if [ "$SUDO_MODE" = "auto" ] && sudo_available; then
    if [ "$need_docker" -eq 1 ]; then
      info "Installing Docker via get.docker.com…"
      sudo_sh "curl -fsSL https://get.docker.com | sh"
    fi
    if [ "$need_compose" -eq 1 ]; then
      info "Installing docker-compose-plugin…"
      sudo_sh "apt-get install -y docker-compose-plugin 2>/dev/null \
            || dnf install -y docker-compose-plugin 2>/dev/null \
            || pacman -S --noconfirm docker-compose 2>/dev/null \
            || true"
    fi
    local target_user="${SUDO_USER:-$USER}"
    if [ -n "$target_user" ] && [ "$target_user" != "root" ]; then
      sudo_run usermod -aG docker "$target_user" 2>/dev/null || true
      warn "Added $target_user to docker group. Re-login or run \`newgrp docker\` to apply."
    fi
    ok "docker + compose installed"
  else
    print_guide "Docker missing — run these in another terminal then re-run install.sh:" \
      "curl -fsSL https://get.docker.com | sudo sh" \
      "sudo apt-get install -y docker-compose-plugin" \
      "sudo usermod -aG docker \$USER" \
      "newgrp docker"
    fatal "Install Docker, then re-run."
  fi
}

step_install_nvidia() {
  [ "$GPU_MODE" = "auto" ] || return 0
  step "NVIDIA Container Toolkit"
  if ! detect_gpu; then
    warn "nvidia-smi not found — skipping toolkit install."
    return
  fi
  if have_cmd nvidia-ctk && sudo_run docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
    ok "toolkit already wired"
    return
  fi
  if [ "$SUDO_MODE" != "auto" ] || ! sudo_available; then
    print_guide "Install NVIDIA Container Toolkit manually:" \
      "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg" \
      "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list" \
      "sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit" \
      "sudo nvidia-ctk runtime configure --runtime=docker" \
      "sudo systemctl restart docker"
    fatal "Install toolkit, then re-run."
  fi
  info "Installing NVIDIA Container Toolkit…"
  sudo_sh '
set -e
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker
'
  ok "toolkit configured"
}

step_firewall() {
  [ "$MODE" = "server" ] || return 0
  step "Open ports 80 + 443 (ufw)"
  if ! have_cmd ufw; then ok "no ufw — assuming open"; return; fi
  if ! sudo_run ufw status 2>/dev/null | grep -q "Status: active"; then
    ok "ufw inactive — assuming open"; return
  fi
  if [ "$SUDO_MODE" = "auto" ] && sudo_available; then
    sudo_run ufw allow 80/tcp >/dev/null
    sudo_run ufw allow 443/tcp >/dev/null
    sudo_run ufw reload >/dev/null
    ok "80 + 443 open"
  else
    print_guide "ufw active — open ports manually:" \
      "sudo ufw allow 80/tcp" "sudo ufw allow 443/tcp" "sudo ufw reload"
    fatal "Open ports, then re-run."
  fi
}

step_clone_repo() {
  step "Fetch Orqestra source"
  mkdir -p "$(dirname "$DIR")"
  if [ -d "$DIR/.git" ]; then
    info "Updating existing checkout in $DIR"
    git -C "$DIR" fetch --tags --quiet
    git -C "$DIR" checkout "$REF" >/dev/null 2>&1 || git -C "$DIR" checkout "$REF"
    git -C "$DIR" pull --ff-only --quiet 2>/dev/null || true
    ok "updated to $REF"
  elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    fatal "$DIR exists and is not empty. Pick a clean directory or rm it first."
  else
    git clone --branch "$REF" --depth 1 "$REPO" "$DIR"
    ok "cloned $REPO@$REF"
  fi
}

write_env_file() {
  local target="$DIR/.env"
  local is_local="true"
  [ "$MODE" = "server" ] && is_local="false"

  local pg="${ORQESTRA_POSTGRES_PASSWORD:-$(rand_hex 16)}"
  local ba="${ORQESTRA_BETTER_AUTH_SECRET:-$(rand_hex 32)}"
  local ia="${ORQESTRA_INTERNAL_API_SECRET:-$(rand_hex 32)}"

  local db_url="postgresql://orqestra:${pg}@postgres:5432/orqestra"
  local redis_url="redis://redis:6379"
  local auth_url next_api next_ws
  if [ "$is_local" = "true" ]; then
    auth_url="http://localhost:4000"
    next_api="http://localhost:4000"
    next_ws="ws://localhost:4001"
  else
    auth_url="https://api.${DOMAIN}"
    next_api="https://api.${DOMAIN}"
    next_ws="wss://ws.${DOMAIN}"
  fi

  # Use heredoc to write canonical .env; prefer matching .env.example structure
  # but values are authoritative below.
  {
    echo "# Generated by install.sh — mode: $MODE"
    echo "POSTGRES_PASSWORD=$pg"
    echo "DATABASE_URL=$db_url"
    echo
    echo "REDIS_URL=$redis_url"
    echo
    echo "BETTER_AUTH_SECRET=$ba"
    echo "INTERNAL_API_SECRET=$ia"
    echo "BETTER_AUTH_URL=$auth_url"
    echo
    echo "ORCHESTRATOR_JUPYTER_URL=http://orchestrator-jupyter:8080"
    echo "ORCHESTRATOR_HOSTING_URL=http://orchestrator-hosting:8081"
    echo
    echo "SITE_DOMAIN=${DOMAIN:-localhost}"
    echo "CF_DNS_API_TOKEN=${CF_TOKEN}"
    [ -n "$LE_EMAIL" ] && echo "LETSENCRYPT_EMAIL=$LE_EMAIL"
    echo
    echo "LOCAL_BIND_IP="
    echo "LOCAL_PUBLIC_HOST="
    echo "RESERVED_RAM_MB=2048"
    echo
    echo "NEXT_PUBLIC_API_URL=$next_api"
    echo "NEXT_PUBLIC_WS_URL=$next_ws"
  } > "$target"
  chmod 600 "$target"
  echo "$target"
}

step_write_env() {
  step "Write .env"
  local p
  p=$(write_env_file)
  ok "$p"
}

step_dns() {
  [ "$MODE" = "server" ] || return 0
  step "Wildcard DNS for *.$DOMAIN"
  if [ -n "$CF_TOKEN" ]; then
    cloudflare_create_record || dns_manual_guide
  else
    dns_manual_guide
  fi
}

apex_of() {
  local d="$1"
  awk -F. '{ if (NF<=2) print $0; else printf "%s.%s\n", $(NF-1), $NF }' <<< "$d"
}

cf_api() {
  # cf_api METHOD PATH [BODY] -> response body
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsSL -X "$method" "https://api.cloudflare.com/client/v4$path" \
      -H "Authorization: Bearer $CF_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -fsSL -X "$method" "https://api.cloudflare.com/client/v4$path" \
      -H "Authorization: Bearer $CF_TOKEN"
  fi
}

cloudflare_create_record() {
  have_cmd curl || { warn "curl missing"; return 1; }
  local apex name zone_resp zone_id existing_resp existing_id body
  apex=$(apex_of "$DOMAIN")
  name="*.${DOMAIN}"

  zone_resp=$(cf_api GET "/zones?name=$apex") || { warn "Cloudflare API error"; return 1; }
  # Parse zone id without jq: assume JSON shape {"result":[{"id":"...",...}]}
  zone_id=$(printf '%s' "$zone_resp" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -n1)
  if [ -z "$zone_id" ]; then
    warn "Cloudflare zone for $apex not found on this token."
    return 1
  fi

  body=$(printf '{"type":"A","name":"%s","content":"%s","ttl":1,"proxied":false,"comment":"orqestra installer"}' "$name" "$PUBLIC_IP")
  existing_resp=$(cf_api GET "/zones/$zone_id/dns_records?type=A&name=$name") || true
  existing_id=$(printf '%s' "$existing_resp" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -n1)

  if [ -n "$existing_id" ]; then
    cf_api PUT "/zones/$zone_id/dns_records/$existing_id" "$body" >/dev/null \
      || { warn "Cloudflare PUT failed"; return 1; }
    ok "updated A record $name → $PUBLIC_IP"
  else
    cf_api POST "/zones/$zone_id/dns_records" "$body" >/dev/null \
      || { warn "Cloudflare POST failed"; return 1; }
    ok "created A record $name → $PUBLIC_IP"
  fi
}

dns_manual_guide() {
  printf '\n  Add this DNS record at your provider:\n\n'
  printf '    %sType   Name              Value          TTL   Proxy%s\n' "$C_BOLD" "$C_RESET"
  printf '    A      *.%-16s %-14s auto  off (DNS-only)\n' "$DOMAIN" "${PUBLIC_IP:-<your-ip>}"
  printf '\n  Cloudflare proxy MUST be off (grey cloud). Orange cloud breaks DNS-01 ACME and WebSockets.\n\n'
  if [ "$NON_INTERACTIVE" -ne 1 ]; then
    local done
    done=$(prompt_yn "DNS record saved + propagated?" n)
    [ "$done" = "y" ] || fatal "DNS not configured."
  fi
  ok "DNS guide acknowledged"
}

step_network() {
  step "Create docker proxy network"
  if sudo_run docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx proxy; then
    ok "exists"
  else
    sudo_run docker network create proxy >/dev/null
    ok "created"
  fi
}

step_build_images() {
  [ "$SKIP_BUILD" -eq 1 ] && { warn "Skipping build (--skip-build)"; return; }
  step "Build Docker images (slow first time)"
  ( cd "$DIR" && sudo_run docker compose build )
  ok "images built"
}

step_boot_infra() {
  [ "$SKIP_BUILD" -eq 1 ] && return 0
  step "Boot infra (postgres, redis$([ "$MODE" = "server" ] && echo ", traefik"))"
  local services="postgres redis"
  [ "$MODE" = "server" ] && services="postgres redis traefik"
  ( cd "$DIR" && sudo_run docker compose up -d $services )
  # Wait for healthy
  local i healthy lines
  for i in $(seq 1 30); do
    lines=$(cd "$DIR" && sudo_run docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | grep -E 'postgres|redis' || true)
    healthy=$(printf '%s\n' "$lines" | grep -c healthy || true)
    if [ "$healthy" -ge 2 ]; then ok "postgres + redis healthy"; return; fi
    sleep 1
  done
  fatal "postgres/redis did not become healthy in 30s"
}

step_db_push() {
  [ "$SKIP_BUILD" -eq 1 ] && return 0
  step "Push DB schema (drizzle-kit)"
  ( cd "$DIR" && sudo_run docker compose run --rm api sh -lc \
      'cd /repo/packages/db && (bunx drizzle-kit push --force --config drizzle.config.ts || pnpm drizzle-kit push --force)' )
  ok "schema pushed"
}

step_boot_apps() {
  [ "$SKIP_BUILD" -eq 1 ] && return 0
  step "Boot app services"
  ( cd "$DIR" && sudo_run docker compose up -d )
  ok "all services up"
}

step_verify() {
  [ "$SKIP_BUILD" -eq 1 ] && return 0
  step "Verify health"
  local targets failed=() t url i
  if [ "$MODE" = "local" ]; then
    targets="api|http://localhost:4000/health ws|http://localhost:4001/health web|http://localhost:3000"
  else
    targets="api|https://api.$DOMAIN/health ws|https://ws.$DOMAIN/health web|https://$DOMAIN"
  fi
  for entry in $targets; do
    t="${entry%%|*}"; url="${entry#*|}"
    local ok_t=0
    for i in $(seq 1 30); do
      if curl -fsSL --max-time 5 -o /dev/null "$url" 2>/dev/null; then ok_t=1; break; fi
      sleep 2
    done
    if [ "$ok_t" -eq 1 ]; then ok "$t healthy"; else failed+=("$t"); err "$t did not respond at $url"; fi
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    warn "Some services unhealthy: ${failed[*]}"
    ( cd "$DIR" && sudo_run docker compose logs --tail=80 ${failed[*]} ) || true
    fatal "Verification failed."
  fi
}

# ----- Config collection ------------------------------------------------------
collect_config() {
  banner

  # Mode
  if [ -z "$MODE" ]; then
    section "1. Where are we installing?"
    MODE=$(prompt_choice "Install mode" "local" "local|server")
  fi
  case "$MODE" in local|server) ;; *) fatal "Invalid --mode: $MODE";; esac
  ok "Mode: $MODE"

  # Install dir
  if [ -z "$DIR" ]; then
    local default_dir
    if is_root; then default_dir="/opt/orqestra"; else default_dir="$HOME/orqestra"; fi
    DIR=$(prompt "Install directory" "$default_dir")
  fi
  # Expand ~
  case "$DIR" in "~"*) DIR="$HOME${DIR#~}";; esac
  [ "${DIR:0:1}" = "/" ] || fatal "--dir must be absolute (got: $DIR)"
  ok "Install dir: $DIR"

  # Repo + ref
  REPO=$(prompt "Source repo URL" "$REPO")
  REF=$(prompt "Branch / tag" "$REF")

  # Sudo
  if [ -z "$SUDO_MODE" ]; then
    if is_root; then
      SUDO_MODE="auto"
      ok "Running as root — system installs run automatically"
    elif sudo_available; then
      if sudo_passwordless; then ok "Passwordless sudo detected"; else info "sudo will prompt for password"; fi
      local ans
      ans=$(prompt_yn "Allow installer to run privileged commands via sudo?" y)
      [ "$ans" = "y" ] && SUDO_MODE="auto" || SUDO_MODE="guide"
    else
      warn "sudo not found — installer prints manual commands"
      SUDO_MODE="guide"
    fi
  fi

  # GPU
  if [ -z "$GPU_MODE" ]; then
    if detect_gpu; then
      ok "NVIDIA GPU detected"
      local ans
      ans=$(prompt_yn "Enable GPU support (installs nvidia-container-toolkit)?" y)
      [ "$ans" = "y" ] && GPU_MODE="auto" || GPU_MODE="off"
    else
      GPU_MODE="off"
      info "No NVIDIA GPU detected — CPU only"
    fi
  fi

  # Server-only inputs
  if [ "$MODE" = "server" ]; then
    section "Domain + TLS"
    [ -n "$DOMAIN" ] || DOMAIN=$(prompt "Public domain (e.g. orqestra.example.com)" "")
    [ -n "$DOMAIN" ] || fatal "Domain required for server mode"
    [ -n "$LE_EMAIL" ] || LE_EMAIL=$(prompt "Let's Encrypt email" "")
    if [ -z "$PUBLIC_IP" ]; then
      local detected
      detected=$(detect_public_ip)
      PUBLIC_IP=$(prompt "Public IP for *.$DOMAIN wildcard" "$detected")
    fi
    [ -n "$PUBLIC_IP" ] || fatal "Public IP required for server mode"
    if [ -z "$CF_TOKEN" ]; then
      local ans
      ans=$(prompt_yn "Have a Cloudflare API token (Zone.DNS:Edit + Zone.Zone:Read)?" n)
      if [ "$ans" = "y" ]; then
        CF_TOKEN=$(prompt_secret "Cloudflare API token")
      fi
    fi
  else
    DOMAIN="localhost"
  fi
}

# ----- Main -------------------------------------------------------------------
main() {
  # Safe to reattach /dev/tty now — bash has read the whole script body before
  # invoking main. When piped via `curl | bash`, stdin was the pipe; replace it
  # with the controlling terminal so interactive prompts work. Skip cleanly
  # when /dev/tty is unavailable (CI / sandboxes).
  if [ ! -t 0 ]; then
    if ( : < /dev/tty ) 2>/dev/null; then
      exec < /dev/tty
    fi
  fi

  detect_os
  collect_config

  STEP_N=0

  step_check_os
  step_preflight
  step_check_tools
  step_install_docker
  step_install_nvidia
  step_firewall
  step_clone_repo
  step_write_env
  step_dns
  step_network
  step_build_images
  step_boot_infra
  step_db_push
  step_boot_apps
  step_verify

  print_success
}

print_success() {
  printf '\n%s✓ Orqestra is installed.%s\n\n' "$C_OK$C_BOLD" "$C_RESET"
  printf '  %sURLs%s\n' "$C_BOLD" "$C_RESET"
  if [ "$MODE" = "local" ]; then
    echo "    Web:       http://localhost:3000"
    echo "    API:       http://localhost:4000"
    echo "    WebSocket: ws://localhost:4001"
  else
    echo "    Web:       https://$DOMAIN"
    echo "    API:       https://api.$DOMAIN"
    echo "    WebSocket: wss://ws.$DOMAIN"
    echo
    printf '    %sFirst HTTPS request triggers Let'\''s Encrypt cert issuance via DNS-01 (~30-60s).%s\n' "$C_DIM" "$C_RESET"
  fi
  echo
  if [ "$SKIP_BUILD" -eq 1 ]; then
    printf '  %sNext (manual)%s\n' "$C_BOLD" "$C_RESET"
    echo "    cd $DIR"
    echo "    set -a; source .env; set +a"
    echo "    sudo docker network create proxy   # if not already"
    echo "    sudo docker compose up -d"
  else
    printf '  %sManage%s\n' "$C_BOLD" "$C_RESET"
    echo "    sudo docker compose -f $DIR/docker-compose.yml ps"
    echo "    sudo docker compose -f $DIR/docker-compose.yml logs -f"
    echo "    sudo docker compose -f $DIR/docker-compose.yml down       # stop"
    echo "    sudo docker compose -f $DIR/docker-compose.yml down -v    # stop + DELETE data"
  fi
  echo
}

main "$@"
