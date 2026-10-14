---
name: verify
description: Verify the mind-library MCP server by running it and driving its HTTP MCP endpoint (OAuth code flow, then tools/call). Use for changes under mcp-server/src.
---

# Verify: mcp-server over HTTP

No `verifier-*` skill exists in this repo, so this is the recipe that worked. Surface: the HTTP MCP endpoint. `install.sh` is not drivable here (needs root, systemd, cloudflared).

## Build and start

Build: `cd mcp-server && npm run build` (do not run `npm test` as verification).

Start with `exec` so the recorded PID is node's own. `cd x && VAR=... node ... &` backgrounds a subshell, so `kill` misses node and leaves an orphan holding the lock.

```bash
( cd mcp-server && exec env VAULT_DIR="$V" DATA_DIR="$D" JWT_SECRET=dev AUTH_PASSWORD=pw PORT=3931 HOST=127.0.0.1 node dist/index.js ) >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
```

Stop with `kill -TERM "$(cat "$PIDFILE")"`. Confirm the lock is gone: `$D/server.lock`.

## Token (existing OAuth, until the Access spike lands)

1. `POST /authorize` with `password=pw&redirect_uri=http://localhost/cb&state=s`. Read `code=` from the `Location` header.
2. `POST /token` with `grant_type=authorization_code&code=...`. Read `access_token` (15 min TTL).

## Call a tool

`POST /mcp` with `Authorization: Bearer <token>`, `content-type: application/json`, `accept: application/json, text/event-stream`, and a JSON-RPC body `{"method":"tools/call","params":{"name":...,"arguments":{...}}}`. Read `result.content[0].text`. `result.isError` is true on refusals. Set `user-agent` to choose the commit author.

## Worth driving

- create, then overwrite without `expected_revision` (must refuse), then with the current revision
- two parallel overwrites with the same revision: exactly one `ok`
- `delete_file`, then `list_versions`, then `restore_version`
- `.git/config` read refused; write through a dangling symlink refused
- restart keeps history; a second process on the same `DATA_DIR` refuses with FATAL
- compare with `origin/main`: `git archive origin/main mcp-server | tar -x -C scratch`, symlink `node_modules`, `node_modules/.bin/tsc`

## Gotchas

- `wait` with no PIDs also waits on a background server and hangs. Use `wait $p1 $p2`.
- Use a git-initialized vault with a staged user file to check the user's own repo is untouched.
- Leftover servers: `ps -eo pid,args | grep 'node dist/index.js'`.
