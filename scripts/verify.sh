#!/usr/bin/env bash
# Post-install verification for the mind-library MCP server.
set -euo pipefail
URL="${MCP_URL:-http://127.0.0.1:3000}"

fail() { printf '\033[1;31m[verify] FAIL:\033[0m %s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[1;32m[verify] OK:\033[0m %s\n' "$1"; }

sleep 2

curl -fsS "$URL/health" | grep -q '"ok":true' && ok "health endpoint" || fail "health endpoint unreachable - is mcp-vault running?"

meta="$(curl -fsS "$URL/.well-known/oauth-authorization-server")"
echo "$meta" | grep -q '"authorization_endpoint"' && ok "OAuth metadata served" || fail "OAuth metadata missing"

code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}')"
[[ "$code" == "401" ]] && ok "MCP endpoint rejects unauthenticated requests" || fail "MCP endpoint returned $code without a token (expected 401)"

echo
echo "All checks passed. Connect your client to the tunnel URL and authorize with the vault password."
