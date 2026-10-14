import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
process.env.AUTH_PASSWORD = 'pw';
process.env.JWT_SECRET = 'test-secret';
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_URL = 'http://127.0.0.1';

const { authRouter } = await import('../dist/auth.js');
const express = (await import('express')).default;

const app = express();
app.use('/', authRouter);

let server;
let base;
before(async () => {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const noRedirect = { redirect: 'manual' };

const authorize = (params) => fetch(`${base}/authorize`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params),
  ...noRedirect,
});

const codeFrom = (res) => new URL(res.headers.get('location')).searchParams.get('code');

const exchange = (body) => fetch(`${base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

const jwtPayload = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

test('GET /authorize refuses an arbitrary redirect_uri', async () => {
  const res = await fetch(`${base}/authorize?redirect_uri=${encodeURIComponent('https://evil.example/cb')}&state=s`);
  assert.equal(res.status, 400);
});

test('GET /authorize accepts the Claude callback', async () => {
  const res = await fetch(`${base}/authorize?redirect_uri=${encodeURIComponent(CLAUDE_CB)}&state=s`);
  assert.equal(res.status, 200);
});

test('POST /authorize refuses an arbitrary redirect_uri even with the right password', async () => {
  const res = await authorize({ password: 'pw', redirect_uri: 'https://evil.example/cb', state: 's' });
  assert.equal(res.status, 400);
});

test('POST /authorize refuses a malformed redirect_uri with 400, not 500', async () => {
  const res = await authorize({ password: 'pw', redirect_uri: 'not a url', state: 's' });
  assert.equal(res.status, 400);
});

test('authorization code is single use', async () => {
  const issued = await authorize({ password: 'pw', redirect_uri: CLAUDE_CB, state: 's' });
  assert.equal(issued.status, 302);
  const code = codeFrom(issued);
  const first = await exchange({ grant_type: 'authorization_code', code });
  assert.equal(first.status, 200);
  const second = await exchange({ grant_type: 'authorization_code', code });
  assert.equal(second.status, 400);
});

test('refresh keeps the subject of the original client', async () => {
  const issued = await authorize({ password: 'pw', redirect_uri: CLAUDE_CB, state: 's', client_id: 'custom-agent-1' });
  const first = await (await exchange({ grant_type: 'authorization_code', code: codeFrom(issued) })).json();
  assert.equal(jwtPayload(first.access_token).sub, 'custom-agent-1');
  const refreshed = await (await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).json();
  assert.equal(jwtPayload(refreshed.access_token).sub, 'custom-agent-1');
});

test('refresh token is single use', async () => {
  const issued = await authorize({ password: 'pw', redirect_uri: CLAUDE_CB, state: 's' });
  const first = await (await exchange({ grant_type: 'authorization_code', code: codeFrom(issued) })).json();
  const ok = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
  assert.equal(ok.status, 200);
  const replay = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
  assert.equal(replay.status, 400);
});
