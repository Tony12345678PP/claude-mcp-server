#!/usr/bin/env bash
# ============================================================================
#  Mind Library MCP Server — 無腦一鍵安裝嚮導
#  用法:複製整個 repo 到機器上,然後執行:
#      sudo bash install.sh
#  接下來所有步驟都會在畫面上一步步引導,不需要先讀任何文件。
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/mcp-vault"
SERVICE_USER="mcp-vault"
ENV_FILE="/etc/mcp-vault.env"
SCRIPTS_URL_HINT="https://one.dash.cloudflare.com"

# ---------- 樣式 ----------
C_G="\033[1;32m"; C_Y="\033[1;33m"; C_B="\033[1;36m"; C_R="\033[1;31m"; C_0="\033[0m"
step()  { printf "\n${C_B}==== %s ====${C_0}\n" "$1"; }
log()   { printf "${C_G}  [✓]${C_0} %s\n" "$1"; }
info()  { printf "  %s\n" "$1"; }
warn()  { printf "${C_Y}  [!]${C_0} %s\n" "$1"; }
fail()  { printf "${C_R}  [✗] %s${C_0}\n" "$1" >&2; exit 1; }
ask()   { printf "${C_Y}  ▶ %s${C_0}" "$1"; }

banner() {
printf '${C_B}'
cat <<'EOF'
==============================================
   Mind Library MCP Server — 一鍵安裝
   Editor ↔ AI 思維庫同步伺服器
==============================================
EOF
printf '${C_0}'
}

banner

# ---------- 0. 權限 ----------
if [[ $EUID -ne 0 ]]; then
  warn "需要 root 權限,正在自動切換到 sudo..."
  exec sudo bash "$0" "$@"
fi

# ---------- 1. Vault 位置 ----------
step "步驟 1/6:思維庫(Vault)位置"
info "這是 AI 可讀寫的資料夾,所有操作都被沙箱限制在此資料夾內。"
info "直接按 Enter 使用預設值 /srv/mind-vault;或貼上你自己的資料夾路徑。"
VAULT_DIR="/srv/mind-vault"
ask "Vault 資料夾 [預設: /srv/mind-vault]: "
read -r REPLY
[[ -n "${REPLY}" ]] && VAULT_DIR="$REPLY"
mkdir -p "$VAULT_DIR"
log "Vault 位置: $VAULT_DIR"

# ---------- 2. 閘門密碼 ----------
step "步驟 2/6:設定閘門密碼"
info "之後 client 連線時會出現一個密碼頁,輸入這組密碼才能授權存取。"
while true; do
  ask "請設定密碼(輸入不會顯示): "
  read -rs AUTH_PASSWORD
  echo
  ask "再輸入一次確認: "
  read -rs AUTH_PASSWORD2
  echo
  if [[ -z "$AUTH_PASSWORD" ]]; then
    warn "密碼不可空白,請重試。"
  elif [[ "$AUTH_PASSWORD" != "$AUTH_PASSWORD2" ]]; then
    warn "兩次輸入不一致,請重試。"
  else
    break
  fi
done
log "密碼已設定。"

# ---------- 3. Node.js ----------
step "步驟 3/6:安裝 Node.js(需要 20 版以上)"
if command -v node >/dev/null && [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge 20 ]]; then
  log "已偵測到 Node.js $(node -v),跳過安裝。"
else
  info "正在自動安裝 Node.js 20.x(需要一兩分鐘)..."
  if command -v apt-get >/dev/null; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    fail "不支援的套件管理器。請手動安裝 Node.js >= 20 後重新執行本腳本。"
  fi
  log "Node.js $(node -v) 安裝完成。"
fi

# ---------- 4. Cloudflare Tunnel ----------
step "步驟 4/6:Cloudflare Tunnel(解決埠/對外連線的問題)"
info "你的機器不會開任何對外埠,流量經由 Cloudflare Tunnel 進來,一律走 HTTPS。"
info "請選擇你的情況:"
info "  1) 我已經有 tunnel token(貼上即可)
  2) 我有 Cloudflare 帳號,但還沒建立 tunnel → 教你在瀏覽器操作
  3) 先跳過,之後再設定(只會裝好本機服務)
"
TUNNEL_TOKEN=""
TUNNEL_GUIDED=0
while true; do
  ask "請輸入 1 / 2 / 3: "
  read -r REPLY
  case "$REPLY" in
    1)
      info "Tunnel token 會在 Cloudflare 後台這個位置:"
      info "  $SCRIPTS_URL_HINT → 左側選「Networks」→「Tunnels」"
      info "  → 點你的 tunnel →「...」→ 可在頁面找到 token(一段很長的英數字)"
      ask "在此貼上你的 tunnel token: "
      read -r TUNNEL_TOKEN
      [[ -n "$TUNNEL_TOKEN" ]] && break || warn "token 不可空白。"
      ;;
    2)
      TUNNEL_GUIDED=1
      break
      ;;
    3)
      warn "已選擇跳過。安裝完成後,隨時重跑本腳本補上 tunnel。"
      break
      ;;
    *)
      warn "請輸入 1、2 或 3。"
      ;;
  esac
done

if [[ $TUNNEL_GUIDED -eq 1 ]]; then
  step "步驟 4:在瀏覽器建立 Tunnel(跟著做即可)"
  info "打開瀏覽器,前往: $SCRIPTS_URL_HINT"
  info "
  1. 用你的 Cloudflare 帳號登入(沒有就免費註冊一個)
  2. 左側選單:「Networks」→「Tunnels」
  3. 點「Create a tunnel」→ 選「Cloudflared」→ 取個名字(例如 mind-library)→ Save
  4. 到「Public hostname」頁籤:
       Subdomain: mcp(或你喜歡的)  Domain: 選你已綁定的網域
       Service:  Type 選 HTTP、URL 填 localhost:3000
     (沒有綁定網域?回到 tunnel 頁籤先複製 token,之後可以用 quick tunnel 測試)
  5. 回到 tunnel 概覽頁,找到你的 tunnel,點「...」→「Copy token」
"
  while true; do
    ask "做好之後,在此貼上你的 tunnel token: "
    read -r TUNNEL_TOKEN
    [[ -n "$TUNNEL_TOKEN" ]] && break || warn "token 不可空白。"
  done
  log "Token 已收到。"
fi

# ---------- 5. 安裝本體 ----------
step "步驟 5/6:安裝服務本體"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$INSTALL_DIR"
cp -r "$REPO_DIR/mcp-server/." "$INSTALL_DIR/"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR" "$VAULT_DIR"
info "安裝依賴並建置中(需要一兩分鐘)..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && npm ci --loglevel=error && npm run build"
log "建置完成。"

JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cat > "$ENV_FILE" <<EOF
PORT=3000
HOST=127.0.0.1
VAULT_DIR=$VAULT_DIR
DATA_DIR=$INSTALL_DIR/data
JWT_SECRET=$JWT_SECRET
AUTH_PASSWORD=$AUTH_PASSWORD
EOF
chmod 600 "$ENV_FILE"
log "已產生設定檔 $ENV_FILE(含隨機產生的 JWT 金鑰)。"

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
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$VAULT_DIR $INSTALL_DIR/data

[Install]
WantedBy=multi-user.target
EOF

if [[ -n "$TUNNEL_TOKEN" ]]; then
  if ! command -v cloudflared >/dev/null; then
    info "下載 cloudflared..."
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
  systemctl enable --now mcp-vault.service cloudflared.service >/dev/null 2>&1
  log "已啟動服務:mcp-vault(127.0.0.1:3000)與 cloudflared(自動重啟)。"
else
  systemctl daemon-reload
  systemctl enable --now mcp-vault.service >/dev/null 2>&1
  log "已啟動服務:mcp-vault(127.0.0.1:3000)。"
fi

# ---------- 6. 驗證 ----------
step "步驟 6/6:自動驗證"
bash "$REPO_DIR/scripts/verify.sh"

# ---------- 收尾:問公開 URL ----------
printf '\n'
step "完成!最後一步:填入你的公開網址"
if [[ -n "$TUNNEL_TOKEN" ]]; then
  info "你在 Cloudflare 後台為這個 tunnel 設定的公開網址就是 client 之後要連的位址,"
  info "例如:  https://mcp.yourdomain.com"
  ask "在此貼上你的公開網址(https://...): "
  read -r PUBLIC_URL
  if [[ -n "$PUBLIC_URL" ]]; then
    echo "PUBLIC_URL=$PUBLIC_URL" >> "$ENV_FILE"
    systemctl restart mcp-vault
    log "已寫入並重啟服務。"
  else
    warn "略過。之後編輯 $ENV_FILE 加上 PUBLIC_URL=<網址> 再 systemctl restart mcp-vault。"
  fi
else
  warn "尚未設定 tunnel。之後重跑本腳本(sudo bash install.sh)即可補上。"
fi

printf '\n'
printf '${C_G}==============================================\n'
printf '   安裝完成!\n'
printf '==============================================\n${C_0}'
info "你的 MCP 網址: ${PUBLIC_URL:-<設定 tunnel 後會是 https://mcp.你的網域>/mcp}"
info ""
info "之後在 Claude / client 的 MCP 設定貼上:"
info '  {
    "mcpServers": {
      "mind-library": { "type": "http", "url": "<你的網址>/mcp" }
    }
  }'
info ""
info "第一次連線會跳出密碼頁,輸入你剛才設定的閘門密碼即可授權。"
info ""
info "常用指令:"
info "  查看狀態:  systemctl status mcp-vault"
info "  看即時log: journalctl -u mcp-vault -f"
printf '\n'
