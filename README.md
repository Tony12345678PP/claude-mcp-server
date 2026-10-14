# claude-mcp-server

Claude MCP Server for **Mind Library Sync** — 讓 AI 與你的編輯器共用同一個思維庫(vault):AI 可建立、調用、編輯、刪除、整理文件,並透過 Cloudflare Tunnel 在網頁端與桌面 client 皆可用。

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

## 一鍵部署(Linux + systemd)

```bash
git clone <this-repo> && cd claude-mcp-server
sudo TUNNEL_TOKEN=<cloudflare-tunnel-token> ./install.sh /srv/mind-vault
```

安裝腳本會:

1. 安裝/檢查 Node.js 20+
2. 建立 `mcp-vault` 系統使用者與服務目錄 `/opt/mcp-vault`
3. 安裝依賴並建置 TypeScript
4. 產生 `/etc/mcp-vault.env`(隨機 JWT_SECRET、你設定的閘門密碼)
5. 安裝並啟用 systemd 服務:`mcp-vault`(綁定 **127.0.0.1:3000**,絕不直接對外)與 `cloudflared`(自動重啟)
6. 執行 `scripts/verify.sh` 驗證:health、OAuth metadata、未授權請求回 401

沒有 tunnel token 也能裝(先起 server,之後補 cloudflared;測試可參照 [deploy/cloudflared-config-template.yml](deploy/cloudflared-config-template.yml))。

## Cloudflare 端設定

1. 在 Zero Trust 建立 named tunnel,public hostname 指向 `http://localhost:3000`
2. 取得 token 後帶入安裝腳本(或之後啟用 `cloudflared.service`)
3. **將最終公開 URL 寫入 `/etc/mcp-vault.env` 的 `PUBLIC_URL`**(OAuth metadata 依此簽發),然後 `systemctl restart mcp-vault`
4. 建議:在 tunnel hostname 前再加一層 Cloudflare Access(email OTP),並開啟 Block AI bots 與 rate limiting

## 連接 client

Client 的 MCP 設定(Streamable HTTP):

```json
{
  "mcpServers": {
    "mind-library": {
      "type": "http",
      "url": "https://<your-tunnel-host>/mcp"
    }
  }
}
```

第一次連線會導向 `/authorize` 密碼頁,授權後 client 以 bearer JWT 呼叫工具。

## 手動開發執行

```bash
cd mcp-server
npm ci && npm run build
VAULT_DIR=/tmp/vault DATA_DIR=/tmp/vault-data JWT_SECRET=dev AUTH_PASSWORD=dev PORT=3000 node dist/index.js
```

## 安全性須知

- 這台常開機器就是可用性上限(重開機後 systemd 自動拉起;停機期間 client 會收到明確 401/離線錯誤)
- OAuth 密碼頁是最低門檻;生產建議疊加 Cloudflare Access
- trash/versions 目錄尚無清理機制——空間會緩慢增長,屬 Phase 2 待辦
- 雙向編輯器同步(編輯器擴充套件 + 推播)屬 Phase 2

## Roadmap

- Phase 1(本 PR):Streamable HTTP MCP + 單人 OAuth + 沙箱化 CRUD + 軟刪除/版本歷史 + 一鍵部署
- Phase 2:編輯器擴充套件雙向同步、trash/versions 自動清理、Cloudflare Access 一鍵設定
