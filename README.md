# claude-mcp-server
自用
Claude MCP Server for **Mind Library Sync** — 讓 AI 與你的編輯器共用同一個思維庫(vault):AI 可建立、調用、編輯、刪除、整理文件,並透過 Cloudflare Tunnel 在網頁端與桌面 client 皆可用。原生 Linux、**WSL** 與 **Windows 原生**皆可部署。

## 架構(Phase 1)

```
Claude / Web client ──HTTPS──> Cloudflare Tunnel ──> cloudflared ──> 127.0.0.1:3000 MCP server (OAuth + sandbox + versioning)
```

- **Transport**: Streamable HTTP(無狀態模式),瀏覽器與桌面 client 皆可用
- **認證**: 單人簡化版 OAuth 2.0 — 密碼閘門頁(`/authorize`)→ 授權碼 → 自簽 HS256 JWT(15 分鐘)+ refresh token 單次輪替、雜湊落盤
- **路徑沙箱**: 所有工具操作被限制在 `VAULT_DIR` 內,realpath 驗證擋掉 symlink 逃逸與 `..` 穿越
- **衝突防護**: `read_file` 回傳 revision(內容雜湊),`write_file` 可帶 `expected_revision`,衝突時明確失敗而非覆蓋
- **軟刪除 + 版本歷史**: 每次寫入/刪除前快照舊內容,`delete_file` 可恢復,`list_versions` / `restore_version` 隨時回滾
- **審計**: 所有變更寫入 JSONL audit log

## MCP 工具

| 工具 | 說明 |
|---|---|
| `list_files` | 列出思維庫內檔案 |
| `read_file` | 讀取檔案 + revision |
| `write_file` | 建立/覆寫(帶 revision 衝突檢查)|
| `delete_file` | 軟刪除(快照後進 trash)|
| `list_versions` | 檔案歷史版本 |
| `restore_version` | 回滾到指定版本 |

## 一鍵部署(最無腦版,Linux / WSL 通用)

在你要部署的機器上(WSL 也一樣):

```bash
git clone https://github.com/Tony12345678PP/claude-mcp-server.git
cd claude-mcp-server
sudo bash install.sh
```

就這樣。接下來**全部在畫面上互動完成**,不需要先讀任何文件:

1. 問你思維庫要放哪(直接 Enter 用預設)
2. 要你設定閘門密碼(輸入兩次,不顯示)
3. 自動裝 Node.js 20(已有則跳過)
4. 問你 Cloudflare 的情況:
   - **有 token** → 螢幕上告訴你 token 在後台哪個位置,「在此貼上你的 tunnel token」
   - **沒有 tunnel** → 逐步教你開 [Zero Trust 後台](https://one.dash.cloudflare.com)、建立 tunnel、設定 hostname 指向 `localhost:3000`、複製 token 貼上
   - **想晚點再設** → 選 3 跳過,之後重跑腳本即可補上(token 會存起來,不用重貼)
5. 自動建置、產生金鑰、建立服務(只綁 **127.0.0.1:3000**,絕不直接對外;`cloudflared` 交給 Cloudflare 處理所有埠/HTTPS 的問題)
6. 自動跑驗證(health / OAuth metadata / 未授權請求 401)
7. 最後問你「在此貼上你的公開網址」,寫入設定並重啟,然後**直接印出**你 client 要貼的 MCP 設定 JSON

## 在 WSL 上部署

腳本會自動偵測 WSL 並處理兩種狀況:

**狀況 A — WSL 已啟用 systemd(新版 Windows 11 / WSL 2 預設):**
與原生 Linux 完全相同,自動建 systemd 服務、開機自啟、故障自動重啟。

**狀況 B — systemd 尚未啟用:**
安裝腳本會問你要不要啟用:

- 選 **1(建議)** → 腳本自動改好 `/etc/wsl.conf`,然後告訴你:
  在 PowerShell 執行 `wsl --shutdown`,重開 WSL 視窗,再跑一次 `sudo bash install.sh`(進度保留,不會重裝)。之後就跟原生 Linux 一樣。
- 選 **2** → 使用背景程序模式(nohup):照常安裝與啟動,並提供管理指令:
  ```bash
  sudo mcp-vault-ctl start    # 每次開機後執行一次
  sudo mcp-vault-ctl status
  sudo mcp-vault-ctl stop
  tail -f /var/log/mcp-vault/server.log
  ```
  想全自動的話,在 Windows「工作排程器」加一筆開機工作執行:
  `wsl -u root -- mcp-vault-ctl start`

Cloudflare Tunnel 在 WSL 上完全沒問題:tunnel 是**向外**建立的連線,不需要開任何 inbound 埠。

vault 若放在 `/mnt/c/...`(Windows 看得到)也可用,但存取效能比放在 Linux 檔案系統內慢。

## 在 Windows 原生部署(不經 WSL)

`install.sh` 只支援 Linux / WSL;Windows 上可以直接用 Node 跑伺服器,cloudflared 裝成 Windows 服務。

1. **Cloudflare 後台**:在 [Zero Trust](https://one.dash.cloudflare.com) → Networks → Tunnels 建立 tunnel,Public Hostname 設成你的網域(例如 `mcp.example.com`)→ `HTTP` `localhost:3000`。在 Install connector 畫面複製 token。

2. **安裝 cloudflared 服務**(系統管理員 PowerShell):

   ```powershell
   winget install --id Cloudflare.cloudflared
   cloudflared.exe service install <你的 tunnel token>
   sc query cloudflared   # 應為 RUNNING
   ```

   服務會開機自啟。後端還沒啟動時,公開網址回 502 是正常的。

3. **設定與建置伺服器**:在 `mcp-server\` 建立 `.env`(已被 `.gitignore` 排除):

   ```ini
   VAULT_DIR=C:/Users/<你>/mind-vault
   DATA_DIR=C:/Users/<你>/mind-vault-data
   JWT_SECRET=<一串長亂數>
   AUTH_PASSWORD=<閘門密碼>
   PUBLIC_URL=https://mcp.example.com
   HOST=127.0.0.1
   PORT=3000
   ```

   `DATA_DIR` 不要放在 `VAULT_DIR` 裡面。產生亂數可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。

   ```powershell
   cd mcp-server
   npm install
   npm run build
   node --env-file=.env dist/index.js
   ```

4. **驗證**(從任何能上網的機器):

   ```powershell
   curl.exe https://mcp.example.com/health                                 # 200 {"ok":true,...}
   curl.exe https://mcp.example.com/.well-known/oauth-authorization-server # 200 metadata
   curl.exe -s -o NUL -w "%{http_code}" -X POST https://mcp.example.com/mcp -H "content-type: application/json" -d "{}"   # 401
   ```

5. **開機自動啟動**:上面的 `node` 是前景程序,登出或重開機就會停,公開網址會變回 502。要常駐可用「工作排程器」建立登入/開機時執行 `node --env-file=.env dist\index.js`(起始位置設成 `mcp-server` 資料夾),或用 NSSM 包成 Windows 服務。

## 連接 client

安裝結束時畫面會直接印出你的設定,長這樣(Streamable HTTP):

```json
{
  "mcpServers": {
    "mind-library": {
      "type": "http",
      "url": "https://<你的網域>/mcp"
    }
  }
}
```

第一次連線會導向 `/authorize` 密碼頁,輸入你安裝時設定的閘門密碼即可。

## 手動開發執行

```bash
cd mcp-server
npm ci && npm run build
VAULT_DIR=/tmp/vault DATA_DIR=/tmp/vault-data JWT_SECRET=dev AUTH_PASSWORD=dev PORT=3000 node dist/index.js
```

## 安全性須知

- 這台常開機器就是可用性上限(WSL 還多一層:Windows 本身要保持開機,且 WSL 服務要記得啟動)
- OAuth 密碼頁是最低門檻;生產建議在 Cloudflare Access 再疊一層 email OTP,並開啟 Block AI bots 與 rate limiting
- trash/versions 目錄尚無清理機制——空間會緩慢增長,屬 Phase 2 待辦
- 雙向編輯器同步(編輯器擴充套件 + 推播)屬 Phase 2

## Roadmap

- Phase 1(本 PR):Streamable HTTP MCP + 單人 OAuth + 沙箱化 CRUD + 軟刪除/版本歷史 + 互動式一鍵部署(Linux / WSL)
- Phase 2:編輯器擴充套件雙向同步、trash/versions 自動清理、Cloudflare Access 一鍵設定
