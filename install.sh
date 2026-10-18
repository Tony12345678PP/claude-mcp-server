#!/usr/bin/env bash
# ============================================================================
#  Mind Library MCP Server — 無腦一鍵安裝嚮導
#  用法:複製整個 repo 到機器上(Linux 或 WSL 都可以),然後執行:
#      sudo bash install.sh
#  接下來所有步驟都會在畫面上一步步引導,不需要先讀任何文件。
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/mcp-vault"
SERVICE_USER="mcp-vault"
ENV_FILE="/etc/mcp-vault.env"
CF_DASH="https://one.dash.cloudflare.com"

# ---------- 樣式 ----------
C_G="\033[1;32m"; C_Y="\033[1;33m"; C_B="\033[1;36m"; C_R="\033[1;31m"; C_0="\033[0m"
step()  { printf "\n${C_B}==== %s ====${C_0}\n" "$1"; }
log()   { printf "${C_G}  [✓]${C_0} %s\n" "$1"; }
info()  { printf "  %s\n" "$1"; }
warn()  { printf "${C_Y}  [!]${C_0} %s\n" "$1"; }
fail()  { printf "${C_R}  [✗] %s${C_0}\n" "$1" >&2; exit 1; }
ask()   { printf "${C_Y}  ▶ %s${C_0}" "$1"; }

# cloudflared release 檔名用 amd64 / arm64 / arm / 386,dpkg 與 uname -m 的命名不同,要先換算
cloudflared_arch() {
  local m
  m="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$m" in
    amd64|x86_64)        echo amd64 ;;
    arm64|aarch64)       echo arm64 ;;
    armhf|armv7l|armv7*) echo armhf ;;
    armel|armv6l|arm)    echo arm ;;
    i386|i686|386)       echo 386 ;;
    *) return 1 ;;
  esac
}

banner() {
printf '%b' "$C_B"
cat <<'EOF'
==============================================
   Mind Library MCP Server — 一鍵安裝
   Editor ↔ AI 思維庫同步伺服器
==============================================
EOF
printf '%b' "$C_0"
}

banner

# ---------- 0. 權限 ----------
if [[ $EUID -ne 0 ]]; then
  warn "需要 root 權限,正在自動切換到 sudo..."
  exec sudo bash "$0" "$@"
fi

# ---------- 0.5 偵測環境:WSL?systemd? ----------
IS_WSL=0
if grep -qi microsoft /proc/version 2>/dev/null || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  IS_WSL=1
fi
RUNTIME="systemd"
if [[ $IS_WSL -eq 1 && ! -d /run/systemd/system ]]; then
  step "偵測到 WSL,但 systemd 尚未啟用"
  info "WSL 上有兩種執行方式,建議啟用 systemd(服務會自動重啟、開機自啟):"
  info "  1) 幫我啟用 systemd → 腳本自動改好設定,你只需要重啟一次 WSL
  2) 不要 systemd → 用背景程序模式(nohup),一切照常運作
"
  while true; do
    ask "請輸入 1 / 2 [預設: 1]: "
    read -r REPLY
    REPLY="${REPLY:-1}"
    if [[ "$REPLY" == "1" ]]; then
      # 在 /etc/wsl.conf 啟用 systemd(保留既有內容)
      touch /etc/wsl.conf
      if ! grep -q '^\[boot\]' /etc/wsl.conf; then
        printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
      else
        sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
      fi
      printf '%b' "$C_Y"
      cat <<'EOF'
  [!] 已在 /etc/wsl.conf 啟用 systemd。
      現在請做這一件事(只需要一次):
        1. 打開 Windows 的 PowerShell
        2. 輸入:  wsl --shutdown
        3. 等待 10 秒後,重新打開此 WSL 視窗
        4. 重新執行:  sudo bash install.sh
      (原本的進度都會保留,不會重裝)
EOF
      printf '%b' "$C_0"
      exit 0
    elif [[ "$REPLY" == "2" ]]; then
      RUNTIME="wsl-nosystemd"
      warn "使用背景程序模式。服務不會在 Windows 重開機後自動啟動,"
      warn "每次開機後需要執行一次:  sudo mcp-vault-ctl start"
      break
    else
      warn "請輸入 1 或 2。"
    fi
  done
elif [[ $IS_WSL -eq 1 ]]; then
  log "偵測到 WSL,且 systemd 已啟用 — 一切照常,與原生 Linux 相同。"
fi
export RUNTIME

# ---------- 1. Vault 位置 ----------
step "步驟 1/6:思維庫(Vault)位置"
info "這是 AI 可讀寫的資料夾,所有操作都被沙箱限制在此資料夾內。"
if [[ $IS_WSL -eq 1 ]]; then
  info "提示:想讓 Windows 端也看得到檔案,可放在 /mnt/c/... 之下,"
  info "     但效能會比放在 Linux 檔案系統(如預設值)慢。"
fi
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

if ! command -v git >/dev/null; then
  info "正在安裝 git..."
  if command -v apt-get >/dev/null; then
    apt-get update -y && apt-get install -y git
  elif command -v dnf >/dev/null; then
    dnf install -y git
  else
    fail "找不到 git,請手動安裝後重新執行本腳本。"
  fi
fi
log "git $(git --version | awk '{print $3}') 已就緒。"

# ---------- 4. Cloudflare Tunnel ----------
step "步驟 4/6:Cloudflare Tunnel(解決埠/對外連線的問題)"
info "你的機器不會開任何對外埠,流量經由 Cloudflare Tunnel「主動向外連」的方式進來。"
if [[ $IS_WSL -eq 1 ]]; then
  info "這在 WSL 上完全沒問題:tunnel 是向外建立的連線,WSL 不需要任何 inbound 埠。"
fi
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
      info "  $CF_DASH → 左側選「Networks」→「Tunnels」"
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
  info "打開瀏覽器(Windows 上開即可),前往: $CF_DASH"
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
mkdir -p "$INSTALL_DIR" /var/log/mcp-vault
cp -r "$REPO_DIR/mcp-server/." "$INSTALL_DIR/"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR" "$VAULT_DIR"
info "安裝依賴並建置中(需要一兩分鐘)..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && npm ci --loglevel=error && npm run build"
log "建置完成。"

JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
if [[ ! -f "$ENV_FILE" ]]; then
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
else
log "沿用已有的設定檔 $ENV_FILE。"
fi

if [[ -n "$TUNNEL_TOKEN" ]] && ! command -v cloudflared >/dev/null; then
  info "下載 cloudflared..."
  ARCH="$(cloudflared_arch)" || fail "不支援的 CPU 架構:$(uname -m)。請手動安裝 cloudflared 後重跑本腳本。"
  curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
  chmod +x /usr/local/bin/cloudflared
  log "cloudflared 安裝完成。"
fi
# 把 token 存進只有 root 可讀的環境變數檔,重跑腳本不用再貼一次。
# cloudflared 從 TUNNEL_TOKEN 環境變數讀 token,所以 token 不會出現在
# 程序參數(ps、/proc/*/cmdline)或 systemd unit 檔裡。
TUNNEL_ENV_FILE="/etc/mcp-vault.tunnel.env"
LEGACY_TOKEN_FILE="/etc/mcp-vault.tunnel-token"
if [[ -z "$TUNNEL_TOKEN" && ! -f "$TUNNEL_ENV_FILE" && -f "$LEGACY_TOKEN_FILE" ]]; then
  TUNNEL_TOKEN="$(cat "$LEGACY_TOKEN_FILE")"
fi
if [[ -n "$TUNNEL_TOKEN" ]]; then
  (umask 077; printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" > "$TUNNEL_ENV_FILE")
  chmod 600 "$TUNNEL_ENV_FILE"
fi
rm -f "$LEGACY_TOKEN_FILE"
TUNNEL_TOKEN_FILE=""
[[ -f "$TUNNEL_ENV_FILE" ]] && TUNNEL_TOKEN_FILE="$TUNNEL_ENV_FILE"

# ---------- 5b. 依執行模式啟動服務 ----------
if [[ "$RUNTIME" == "systemd" ]]; then
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

  if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
    cat > /etc/systemd/system/cloudflared.service <<EOF
[Unit]
Description=cloudflared tunnel for mind-library MCP
After=network-online.target mcp-vault.service

[Service]
EnvironmentFile=$TUNNEL_TOKEN_FILE
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run
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
else
  # WSL 無 systemd:提供 ctl 腳本 + nohup 背景程序
  # 設定值在安裝時寫進檔頭;本體用 quoted heredoc,變數到執行時才展開
  cat > /usr/local/bin/mcp-vault-ctl <<EOF
#!/usr/bin/env bash
# WSL 模式服務管理:start / stop / restart / status
set -u
ENV_FILE="$ENV_FILE"
INSTALL_DIR="$INSTALL_DIR"
LOG_DIR="/var/log/mcp-vault"
TOKEN_FILE="$TUNNEL_TOKEN_FILE"
EOF
  cat >> /usr/local/bin/mcp-vault-ctl <<'EOF'

is_up()  { pgrep -f 'dist/index.js' >/dev/null; }
cf_up()  { pgrep -f 'cloudflared tunnel' >/dev/null; }

start() {
  if is_up; then echo "[✓] mcp-vault 已在執行中"; else
    # 密碼與 JWT 金鑰以環境變數傳遞,不放進程序參數;setpriv 直接 exec,不留帶參數的父程序
    mapfile -t ENV_KV < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
    ( export "${ENV_KV[@]}"; exec nohup setpriv --reuid=mcp-vault --regid=mcp-vault --init-groups node $INSTALL_DIR/dist/index.js >> $LOG_DIR/server.log 2>&1 ) &
    sleep 1
    is_up && echo "[✓] mcp-vault 已啟動(log: $LOG_DIR/server.log)" || { echo "[✗] 啟動失敗,看 log: tail -50 $LOG_DIR/server.log"; exit 1; }
  fi
  if [[ -n "$TOKEN_FILE" ]] && ! cf_up; then
    TUNNEL_TOKEN="$(sed -n 's/^TUNNEL_TOKEN=//p' "$TOKEN_FILE")" nohup /usr/local/bin/cloudflared tunnel --no-autoupdate run >> $LOG_DIR/cloudflared.log 2>&1 &
    sleep 2
    cf_up && echo "[✓] cloudflared 已啟動(log: $LOG_DIR/cloudflared.log)" || echo "[!] cloudflared 似乎沒起來,看 log: tail -50 $LOG_DIR/cloudflared.log"
  fi
}
stop() {
  pkill -f 'dist/index.js' 2>/dev/null && echo "[✓] mcp-vault 已停止" || echo "[✓] mcp-vault 本來就沒在執行"
  pkill -f 'cloudflared tunnel' 2>/dev/null && echo "[✓] cloudflared 已停止" || true
}
status() {
  is_up && echo "[✓] mcp-vault 執行中" || echo "[✗] mcp-vault 未執行"
  [[ -n "$TOKEN_FILE" ]] && { cf_up && echo "[✓] cloudflared 執行中" || echo "[✗] cloudflared 未執行"; }
}
case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status|"" ) status ;;
  *) echo "用法: mcp-vault-ctl start|stop|restart|status"; exit 1 ;;
esac
EOF
  chmod +x /usr/local/bin/mcp-vault-ctl
  /usr/local/bin/mcp-vault-ctl start
  log "已用背景程序模式啟動。之後可用 mcp-vault-ctl start/stop/status 管理。"
fi

# ---------- 6. 驗證 ----------
step "步驟 6/6:自動驗證"
bash "$REPO_DIR/scripts/verify.sh"

# ---------- 收尾:問公開 URL ----------
printf '\n'
step "完成!最後一步:填入你的公開網址"
if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
  info "你在 Cloudflare 後台為這個 tunnel 設定的公開網址就是 client 之後要連的位址,"
  info "例如:  https://mcp.yourdomain.com"
  ask "在此貼上你的公開網址(https://...): "
  read -r PUBLIC_URL
  if [[ -n "$PUBLIC_URL" ]]; then
    sed -i '/^PUBLIC_URL=/d' "$ENV_FILE"
    echo "PUBLIC_URL=$PUBLIC_URL" >> "$ENV_FILE"
    if [[ "$RUNTIME" == "systemd" ]]; then
      systemctl restart mcp-vault
    else
      pkill -f 'dist/index.js' 2>/dev/null || true
      sleep 1
      /usr/local/bin/mcp-vault-ctl start
    fi
    log "已寫入並重啟服務。"
  else
    warn "略過。之後編輯 $ENV_FILE 加上 PUBLIC_URL=<網址> 再重啟服務即可。"
  fi
else
  warn "尚未設定 tunnel。之後重跑本腳本(sudo bash install.sh)即可補上。"
fi

printf '\n'
printf '%b' "$C_G"
printf '==============================================\n'
printf '   安裝完成!\n'
printf '==============================================\n'
printf '%b' "$C_0"
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
if [[ "$RUNTIME" == "systemd" ]]; then
  info "常用指令:"
  info "  查看狀態:  systemctl status mcp-vault"
  info "  看即時log: journalctl -u mcp-vault -f"
else
  info "WSL 模式常用指令:"
  info "  查看狀態:  sudo mcp-vault-ctl status"
  info "  啟動/停止: sudo mcp-vault-ctl start / stop"
  info "  看log:     tail -f /var/log/mcp-vault/server.log"
  if [[ $IS_WSL -eq 1 ]]; then
    info ""
    warn "注意:WSL 在 Windows 關機/重開機後不會自動啟動服務。"
    info "每次開機後到 WSL 裡執行一次:"
    info "  sudo mcp-vault-ctl start"
    info "若想全自動,可在 Windows 工作排程器加一筆開機工作執行:"
    info "  wsl -u root -- mcp-vault-ctl start"
  fi
fi
printf '\n'
