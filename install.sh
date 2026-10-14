#!/usr/bin/env bash
# One-click installer for mind-library MCP server (Phase 1).
# Usage: sudo ./install.sh [VAULT_DIR]
#   or:  sudo TUNNEL_TOKEN=<cloudflare-tunnel-token> ./install.sh [VAULT_DIR]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/mcp-vault"
SERVICE_USER="mcp-vault"
ENV_FILE="/etc/mcp-vault.env"
VAULT_DIR="${1:-/srv/mind-vault}"
TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"

log() { printf '\033[1;32m[install]\033[0m %s\n' "$1"; }
err() { printf '\033[1;31m[install]\033[0m %s\n' "$1" >&2; }

[[ $EUID -eq 0 ]] || { err "Please run as root (sudo ./install.sh)"; exit 1; }

# --- 1. Node.js 20+ -------------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
  log "Installing Node.js 20.x ..."
  if command -v apt-get >/dev/null; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    err "Unsupported package manager. Install Node.js >= 20 manually and re-run."; exit 1
  fi
fi
log "Node.js $(node -v)"

# --- 2. Service user + directories ----------------------------------------
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$VAULT_DIR" "$INSTALL_DIR"
cp -r "$REPO_DIR/mcp-server/." "$INSTALL_DIR/"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR" "$VAULT_DIR"

# --- 3. Build --------------------------------------------------------------
log "Installing dependencies and building ..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && npm ci && npm run build"

# --- 4. Environment / secrets ---------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  read -r -p "Set the vault password (gate for the OAuth authorize page): " AUTH_PASSWORD
  [[ -n "$AUTH_PASSWORD" ]] || { err "Password cannot be empty"; exit 1; }
  cat > "$ENV_FILE" <<EOF
PORT=3000
HOST=127.0.0.1
VAULT_DIR=$VAULT_DIR
DATA_DIR=$INSTALL_DIR/data
JWT_SECRET=$JWT_SECRET
AUTH_PASSWORD=$AUTH_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
  log "Wrote $ENV_FILE"
fi

# --- 5. systemd: server ----------------------------------------------------
cat > /etc/systemd/system/mcp-vault.service <<EOF
[Unit]
Description=Mind Library MCP Server
After=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $INSTALL_DIR/dist/index.js
Restart=always
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$VAULT_DIR $INSTALL_DIR/data

[Install]
WantedBy=multi-user.target
EOF

# --- 6. cloudflared ---------------------------------------------------------
if [[ -n "$TUNNEL_TOKEN" ]]; then
  if ! command -v cloudflared >/dev/null; then
    log "Installing cloudflared ..."
    ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
    curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
    chmod +x /usr/local/bin/cloudflared
  fi
  cat > /etc/systemd/system/cloudflared.service <<EOF
[Unit]
Description=cloudflared tunnel for mind-library MCP
After=network-online.target mcp-vault.service

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token $TUNNEL_TOKEN
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now mcp-vault.service cloudflared.service
  log "Server binds to 127.0.0.1:3000 only; traffic arrives through your Cloudflare tunnel."
  log "TIP: point the tunnel at http://localhost:3000, then add the public URL as PUBLIC_URL in $ENV_FILE (for OAuth metadata correctness) and restart mcp-vault."
else
  systemctl daemon-reload
  systemctl enable --now mcp-vault.service
  log "cloudflared not configured (pass TUNNEL_TOKEN=<token> or see deploy/cloudflared-config-template.yml)."
fi

# --- 7. Verify ---------------------------------------------------------------
log "Running verification ..."
bash "$REPO_DIR/scripts/verify.sh" || err "Verification failed - check: journalctl -u mcp-vault -e"

log "Done. Service: systemctl status mcp-vault"
log "Logs: journalctl -u mcp-vault -f"
