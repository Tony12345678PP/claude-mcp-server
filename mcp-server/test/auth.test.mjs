import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

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
const LOCAL_CB = 'http://localhost:8765/callback';

const form = (params) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params),
  redirect: 'manual',
});

const register = (redirect_uris) => fetch(`${base}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'test', redirect_uris, token_endpoint_auth_method: 'none' }),
});

const newPkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
};

const registerClient = async (redirect_uris = [CLAUDE_CB]) => {
  const res = await register(redirect_uris);
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
};

const authorizeParams = (client_id, challenge, redirect_uri = CLAUDE_CB) => ({
  password: 'pw',
  client_id,
  redirect_uri,
  state: 's',
  code_challenge: challenge,
  code_challenge_method: 'S256',
});

const codeFrom = (res) => new URL(res.headers.get('location')).searchParams.get('code');

const exchange = (body) => fetch(`${base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

const jwtPayload = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

const issueCode = async () => {
  const client_id = await registerClient();
  const { verifier, challenge } = newPkce();
  const issued = await fetch(`${base}/authorize`, form(authorizeParams(client_id, challenge)));
  assert.equal(issued.status, 302);
  return { client_id, verifier, code: codeFrom(issued) };
};

test('metadata advertises S256 PKCE and the registration endpoint', async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.equal(meta.registration_endpoint, 'http://127.0.0.1/register');
});

test('register accepts the Claude and localhost callbacks and returns a public client', async () => {
  const res = await register([CLAUDE_CB, LOCAL_CB]);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.client_id);
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.deepEqual(body.redirect_uris, [CLAUDE_CB, LOCAL_CB]);
});

test('register refuses arbitrary redirect URIs', async () => {
  assert.equal((await register(['https://evil.example/cb'])).status, 400);
  assert.equal((await register([])).status, 400);
});

test('register refuses confidential clients', async () => {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: 'client_secret_basic' }),
  });
  assert.equal(res.status, 400);
});

test('GET /authorize refuses an unregistered client', async () => {
  const { challenge } = newPkce();
  const q = new URLSearchParams({ client_id: 'nope', redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal((await fetch(`${base}/authorize?${q}`)).status, 400);
});

test('GET /authorize refuses a redirect URI the client did not register', async () => {
  const client_id = await registerClient([CLAUDE_CB]);
  const { challenge } = newPkce();
  const q = new URLSearchParams({ client_id, redirect_uri: LOCAL_CB, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal((await fetch(`${base}/authorize?${q}`)).status, 400);
});

test('GET /authorize refuses a request without PKCE', async () => {
  const client_id = await registerClient();
  const q = new URLSearchParams({ client_id, redirect_uri: CLAUDE_CB });
  assert.equal((await fetch(`${base}/authorize?${q}`)).status, 400);
});

test('GET /authorize serves the password page for a valid request', async () => {
  const client_id = await registerClient();
  const { challenge } = newPkce();
  const q = new URLSearchParams({ client_id, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal((await fetch(`${base}/authorize?${q}`)).status, 200);
});

test('POST /authorize refuses the wrong password and keeps the OAuth parameters', async () => {
  const client_id = await registerClient();
  const { challenge } = newPkce();
  const res = await fetch(`${base}/authorize`, form({ ...authorizeParams(client_id, challenge), password: 'wrong' }));
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, new RegExp(`name="client_id" value="${client_id}"`));
  assert.match(html, new RegExp(`name="code_challenge" value="${challenge}"`));
});

test('POST /authorize refuses an unregistered redirect URI even with the right password', async () => {
  const client_id = await registerClient([CLAUDE_CB]);
  const { challenge } = newPkce();
  const res = await fetch(`${base}/authorize`, form(authorizeParams(client_id, challenge, 'https://evil.example/cb')));
  assert.equal(res.status, 400);
});

test('full flow: register, authorize with PKCE, exchange, subject is the client_id', async () => {
  const { client_id, verifier, code } = await issueCode();
  const tokens = await (await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id })).json();
  assert.equal(jwtPayload(tokens.access_token).sub, client_id);
});

test('token exchange refuses a wrong or missing code_verifier', async () => {
  const { client_id, code } = await issueCode();
  const wrong = await exchange({ grant_type: 'authorization_code', code, code_verifier: crypto.randomBytes(48).toString('base64url'), redirect_uri: CLAUDE_CB, client_id });
  assert.equal(wrong.status, 400);
  const { client_id: c2, code: code2 } = await issueCode();
  const missing = await exchange({ grant_type: 'authorization_code', code: code2, redirect_uri: CLAUDE_CB, client_id: c2 });
  assert.equal(missing.status, 400);
});

test('token exchange refuses a redirect_uri that differs from the authorization request', async () => {
  const { client_id, verifier, code } = await issueCode();
  const res = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: LOCAL_CB, client_id });
  assert.equal(res.status, 400);
});

test('authorization code is single use', async () => {
  const { client_id, verifier, code } = await issueCode();
  const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id };
  assert.equal((await exchange(body)).status, 200);
  assert.equal((await exchange(body)).status, 400);
});

test('refresh keeps the subject of the original client', async () => {
  const { client_id, verifier, code } = await issueCode();
  const first = await (await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id })).json();
  assert.equal(jwtPayload(first.access_token).sub, client_id);
  const refreshed = await (await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).json();
  assert.equal(jwtPayload(refreshed.access_token).sub, client_id);
});

test('refresh token is single use', async () => {
  const { client_id, verifier, code } = await issueCode();
  const first = await (await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id })).json();
  const ok = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
  assert.equal(ok.status, 200);
  const replay = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
  assert.equal(replay.status, 400);
});
