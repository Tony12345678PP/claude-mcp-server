# claude-mcp-server
自用
Claude MCP Server for **Mind Library Sync** — 讓 AI 與你的編輯器共用同一個思維庫(vault):AI 可建立、調用、編輯、刪除、整理文件,並透過 Cloudflare Tunnel 在網頁端與桌面 client 皆可用。原生 Linux 與 **WSL** 皆可部署。

## 架構(Phase 1)

```
Claude / Web client ──HTTPS──> Cloudflare Tunnel ──> cloudflared ──> 127.0.0.1:3000 MCP server (OAuth + sandbox + versioning)
```

- **Transport**: Streamable HTTP(無狀態模式),瀏覽器與桌面 client 皆可用
- **認證**: 兩層。(1) 設定 `ACCESS_TEAM_DOMAIN` 與 `ACCESS_AUD` 後，每個 `/mcp` 請求都必須帶 Cloudflare Access 的 `Cf-Access-Jwt-Assertion`，以 JWKS 驗證簽章、issuer、audience，commit 作者取自驗證後的 email。(2) 內建單人 OAuth 2.0：密碼閘門頁(`/authorize`)→ 授權碼（單次使用）→ 自簽 HS256 JWT(15 分鐘)+ refresh token 單次輪替（保留原 client 的 subject）
- **路徑沙箱**: 所有工具操作被限制在 `VAULT_DIR` 內,realpath 驗證擋掉 symlink 逃逸與 `..` 穿越
- **衝突防護**: `read_file` 回傳 revision(內容雜湊)。覆寫既有檔案必須帶 `expected_revision`，否則被拒絕；所有寫入經同一把鎖序列化，同一 revision 的並發寫入只有一個成功
- **版本歷史(git)**: 每次寫入/刪除都是 `DATA_DIR/shadow.git` 裡的一筆 commit，只提交被改的那個檔案。第一次覆寫既有檔案前會先記錄原內容（baseline）。`delete_file` 之後可用 `restore_version` 還原
- **審計**: git log 即審計紀錄。作者為驗證後的 Access email（有設定 Access 時）或 User-Agent（未設定時，為自稱，不可信）

## MCP 工具

| 工具 | 說明 |
|---|---|
| `list_files` | 列出思維庫內檔案 |
| `read_file` | 讀取檔案 + revision |
| `write_file` | 建立；覆寫既有檔案必須帶 `expected_revision` |
| `delete_file` | 刪除（可用 `restore_version` 還原）|
| `list_versions` | 檔案變更歷史（git commit，新到舊）|
| `restore_version` | 以指定 commit 的內容覆寫檔案（需 `expected_revision`）|

## 前置條件（開始前先準備）

安裝腳本會自動處理 Node.js、git、cloudflared。下列項目需要你在網頁後台自己完成，腳本無法代勞：

1. **機器**：Linux 或 WSL，可 sudo，常開機，可對外連 443。
2. **網域**：已在 Cloudflare DNS（已完成）。
3. **Zero Trust 團隊**：到 <https://one.dash.cloudflare.com> 建立團隊（免費方案），記下 `<team>.cloudflareaccess.com`。
4. **Tunnel**：Networks → Tunnels → Create，複製 token（安裝時貼上）。Public hostname 設為 `mcp.<你的網域>`，Service 為 `http://localhost:3000`。
5. **Access 應用程式**：Access → Applications → Add → Self-hosted，Domain 填 `mcp.<你的網域>`。Policy 設為 Allow，Include → Emails → 你自己的 email。記下 **Application Audience (AUD) tag**。
6. **寫入 Access 設定**：在環境檔（`/etc/mcp-vault.env`）加入下列兩行，然後重啟服務（`sudo systemctl restart mcp-vault`，或 nohup 模式用 `sudo mcp-vault-ctl stop && sudo mcp-vault-ctl start`）。啟動 log 應顯示 `access: enforced`。
   ```
   ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   ACCESS_AUD=<AUD tag>
   ```
7. **claude.ai connector**：Settings → Connectors → Add custom connector，URL 填 `https://mcp.<你的網域>/mcp`。

> **尚未驗證**：Access 能否作為 claude.ai connector 的 OAuth 授權端（Managed OAuth 與 Dynamic Client Registration）。若第 7 步無法完成授權，請回報結果，接著會改用內建 OAuth 作為主要認證。Access 的 JWT issuer 格式也需以第一次實際請求的 token 確認。

## 版本歷史與你自己的 git

`VAULT_DIR` 可以直接是你的程式碼 repo。MCP 的寫入記在 `DATA_DIR/shadow.git`，不會進你的 `.git`，也不會出現在你的 `git status` 或 commit 裡。查看 Claude 改過的紀錄：

```bash
git --git-dir=<DATA_DIR>/shadow.git --work-tree=<VAULT_DIR> log --oneline -- <path>
```

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
- 未設定 Access 時，任何能通過密碼閘門的人都能寫入 vault。強烈建議完成上方的 Access 設定，並在 Cloudflare 開啟 Block AI bots 與 rate limiting（含 `/authorize`）
- `shadow.git` 會隨寫入持續增長，目前沒有 gc 機制（待辦）
- 雙向編輯器同步(編輯器擴充套件 + 推播)屬 Phase 2

## Roadmap

- Phase 1:Streamable HTTP MCP + 沙箱化 CRUD + 寫入鎖與 revision 衝突檢查 + git 版本歷史（shadow repo）+ Access JWT 驗證（可選）+ 互動式一鍵部署(Linux / WSL)
- Phase 2:編輯器擴充套件雙向同步、shadow.git gc、Access 設定自動化、Managed OAuth 驗證結果落地
