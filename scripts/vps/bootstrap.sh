#!/usr/bin/env bash
# Take a fresh Ubuntu droplet from SSH access to a running, TLS-terminated
# gateway with a stable URL.
#
# On the droplet (as root):
#   apt-get update && apt-get install -y git
#   git clone https://github.com/natask/chief-moa.git /opt/chief-moa/app
#   /opt/chief-moa/app/scripts/vps/bootstrap.sh --domain api.example.com --email you@example.com
#
# Prerequisite: a DNS A record for --domain pointing at this droplet's IP
# (Cloudflare proxied is fine) BEFORE running, so Let's Encrypt issuance
# succeeds on first boot.
#
# The script is idempotent: rerunning updates the checkout and restarts the
# stack without touching the data volumes or an existing env file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

REPO_URL="${MOA_REPO_URL:-https://github.com/natask/chief-moa.git}"
REF="${MOA_REF:-master}"
DOMAIN=""
EMAIL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$ENV_FILE" ] && { [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; }; then
  echo "First run needs --domain api.example.com and --email you@example.com" >&2
  exit 1
fi

# 1. Docker Engine + compose plugin.
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin missing; install docker-compose-plugin" >&2
  exit 1
fi

# 2. Checkout under /opt/chief-moa/app.
mkdir -p "$MOA_ROOT"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
git -C "$APP_DIR" fetch origin
git -C "$APP_DIR" checkout --detach "origin/$REF" 2>/dev/null \
  || git -C "$APP_DIR" checkout --detach "$REF"

# 3. Env file with generated secrets. Existing env files are never rewritten.
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/gateway/deploy/vps/gateway.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  token="$(openssl rand -hex 32)"
  pg_password="$(openssl rand -hex 32)"
  sed -i \
    -e "s|^MOA_GATEWAY_TOKEN=.*|MOA_GATEWAY_TOKEN=$token|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pg_password|" \
    -e "s|^MOA_DOMAIN=.*|MOA_DOMAIN=$DOMAIN|" \
    -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$EMAIL|" \
    -e "s|^PUBLIC_GATEWAY_URL=.*|PUBLIC_GATEWAY_URL=https://$DOMAIN|" \
    "$ENV_FILE"
  echo "Wrote $ENV_FILE with a generated gateway token and Postgres password."
fi

# 4. Firewall: if ufw is active, allow SSH + HTTP(S). Never auto-enables ufw.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# 5. Build and launch.
cd "$APP_DIR"
compose up -d --build

domain="$(env_value MOA_DOMAIN)"
port="$(env_value GATEWAY_PORT)"
port="${port:-8787}"
echo "Waiting for the gateway to pass its healthcheck..."
wait_for_gateway_health "http://127.0.0.1:$port/health" 45

cat <<DONE

Gateway is up.

  Stable URL:   https://$domain
  Health:       https://$domain/health
  Voice WS:     wss://$domain/v1/voice/sessions
  Token:        MOA_GATEWAY_TOKEN in $ENV_FILE
  Update:       $APP_DIR/scripts/vps/update.sh
  Backup:       $APP_DIR/scripts/vps/backup.sh
  Backup timers: $APP_DIR/scripts/vps/install-backup-timers.sh --install

Point clients (Android app, browser extension) at https://$domain with the
token above. TLS certificates are issued automatically; the first HTTPS
request can take up to a minute while Let's Encrypt completes.
DONE
