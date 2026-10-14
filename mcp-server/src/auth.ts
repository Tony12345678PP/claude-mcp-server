import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/**
 * Single-user OAuth 2.0 authorization server, simplified:
 *  - GET  /.well-known/oauth-authorization-server  (metadata)
 *  - GET/POST /authorize  (password gate page)
 *  - POST /token         (authorization_code + refresh_token with rotation)
 *  - POST /revoke
 * Access tokens are self-signed HS256 JWTs (15 min). Refresh tokens are
 * single-use, rotated on every refresh, persisted hashed (sha256) on disk.
 */
const PASSWORD = process.env.AUTH_PASSWORD ?? '';
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? '');
const BASE_URL = (process.env.PUBLIC_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const REFRESH_FILE = path.join(DATA_DIR, 'refresh_tokens.json');
const ACCESS_TTL = 15 * 60; // seconds
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

if (!PASSWORD || !process.env.JWT_SECRET) {
  console.error('FATAL: AUTH_PASSWORD and JWT_SECRET must be set. Aborting.');
  process.exit(1);
}

const sha256hex = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

type RefreshRecord = { hash: string; created: number; sub: string };
const loadRefresh = (): RefreshRecord[] => {
  try { return JSON.parse(fs.readFileSync(REFRESH_FILE, 'utf8')); } catch { return []; }
};
const saveRefresh = (list: RefreshRecord[]) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REFRESH_FILE, JSON.stringify(list.filter(r => Date.now() - r.created < REFRESH_TTL_MS), null, 2));
};

const issueTokens = async (sub: string) => {
  const access = await new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(BASE_URL)
    .setAudience('mcp-client')
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .sign(SECRET);
  const refresh = crypto.randomBytes(48).toString('hex');
  const list = loadRefresh();
  list.push({ hash: sha256hex(refresh), created: Date.now(), sub });
  saveRefresh(list);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh };
};

// --- in-memory authorization codes (10 min TTL, single use) ---
const codes = new Map<string, { sub: string; expires: number }>();
const pruneCodes = () => {
  const now = Date.now();
  for (const [code, rec] of codes) if (rec.expires < now) codes.delete(code);
};
const ALLOWED_REDIRECTS = [
  /^https:\/\/claude\.ai\/(api\/mcp\/auth_callback|oauth\/callback)$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
];
const isAllowedRedirect = (u: string) => ALLOWED_REDIRECTS.some(re => re.test(u));

const metadata = {
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/authorize`,
  token_endpoint: `${BASE_URL}/token`,
  revocation_endpoint: `${BASE_URL}/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: [],
  token_endpoint_auth_methods_supported: ['none'],
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const passwordPage = (query: URLSearchParams) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize MCP access</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;padding-top:10vh;background:#111;color:#eee}
form{background:#1e1e1e;padding:2rem;border-radius:12px;display:flex;flex-direction:column;gap:1rem;width:20rem}
input{padding:.6rem;border-radius:6px;border:1px solid #444;background:#2a2a2a;color:#eee}
button{padding:.6rem;border:0;border-radius:6px;background:#7c5cff;color:#fff;cursor:pointer;font-weight:600}</style></head>
<body><form method="POST" action="/authorize">
<b>Mind Library MCP Server</b>
<p style="font-size:.85rem;color:#aaa">Enter the vault password to authorize this client.</p>
<input type="password" name="password" placeholder="Password" autofocus required>
<button type="submit">Authorize</button>
${[...query.entries()].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n')}
</form></body></html>`;

export const authRouter = express.Router();

authRouter.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));
authRouter.get('/.well-known/oauth-protected-resource', (_req, res) =>
  res.json({ resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL] }));

authRouter.get('/authorize', (req, res) => {
  const q = new URLSearchParams(req.query as Record<string, string>);
  if (!isAllowedRedirect(q.get('redirect_uri') ?? '')) return res.status(400).send('redirect_uri not allowed');
  res.type('html').send(passwordPage(q));
});

authRouter.post('/authorize', express.urlencoded({ extended: false }), (req, res) => {
  const { password, redirect_uri, state, client_id } = req.body as Record<string, string>;
  if (!isAllowedRedirect(redirect_uri ?? '')) return res.status(400).send('redirect_uri not allowed');
  if (password !== PASSWORD) {
    return res.status(401).type('html').send(passwordPage(new URLSearchParams({ redirect_uri, state: state ?? '' })));
  }
  pruneCodes();
  const code = crypto.randomBytes(24).toString('hex');
  codes.set(code, { sub: client_id ?? 'claude-client', expires: Date.now() + 10 * 60 * 1000 });
  const u = new URL(redirect_uri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  res.redirect(302, u.toString());
});

authRouter.post('/token', express.urlencoded({ extended: false }), async (req, res) => {
  const b = req.body as Record<string, string>;
  try {
    if (b.grant_type === 'authorization_code') {
      const rec = codes.get(b.code ?? '');
      codes.delete(b.code ?? '');
      if (!rec || rec.expires < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
      return res.json(await issueTokens(rec.sub));
    }
    if (b.grant_type === 'refresh_token') {
      const list = loadRefresh();
      const hash = sha256hex(b.refresh_token ?? '');
      const idx = list.findIndex(r => r.hash === hash);
      if (idx === -1) return res.status(400).json({ error: 'invalid_grant' });
      const [old] = list.splice(idx, 1); // rotation: single use
      saveRefresh(list);
      return res.json(await issueTokens(old.sub));
    }
    return res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

authRouter.post('/revoke', express.urlencoded({ extended: false }), (req, res) => {
  const list = loadRefresh();
  const hash = sha256hex((req.body as Record<string, string>).token ?? '');
  saveRefresh(list.filter(r => r.hash !== hash));
  return res.json({ ok: true });
});

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized', hint: 'GET /.well-known/oauth-authorization-server for metadata' });
  try {
    await jwtVerify(token, SECRET, { issuer: BASE_URL, audience: 'mcp-client' });
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
};
