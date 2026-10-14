import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVaultTools, Vault } from './vault.js';
import { authRouter, requireAuth } from './auth.js';
import { accessConfigFromEnv, requireAccess } from './access.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1'; // never expose directly; cloudflared is the gatekeeper
const VAULT_DIR = process.env.VAULT_DIR;
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

if (!VAULT_DIR) {
  console.error('FATAL: VAULT_DIR must be set to the mind-library root directory.');
  process.exit(1);
}

if (path.resolve(DATA_DIR).startsWith(path.resolve(VAULT_DIR) + path.sep)) {
  console.error('FATAL: DATA_DIR must not be inside VAULT_DIR.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const acquireLock = (lockFile: string): void => {
  for (;;) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      process.on('exit', () => fs.rmSync(lockFile, { force: true }));
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => process.exit(0));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number(fs.readFileSync(lockFile, 'utf8'));
      try {
        process.kill(owner, 0);
      } catch {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      console.error(`FATAL: another server (pid ${owner}) already uses ${DATA_DIR}. Two processes would bypass the write lock.`);
      process.exit(1);
    }
  }
};

acquireLock(path.join(DATA_DIR, 'server.lock'));

const vault = new Vault(VAULT_DIR, DATA_DIR);

const accessCfg = accessConfigFromEnv(process.env);
const mcpGates: express.RequestHandler[] = [...(accessCfg ? [requireAccess(accessCfg)] : []), requireAuth];

const actorOf = (req: express.Request, res: express.Response): string => {
  const who = (res.locals.actor as string | undefined) ?? req.header('user-agent') ?? 'unknown-client';
  return who.replace(/[<>\r\n]/g, '').slice(0, 120) || 'unknown-client';
};

const newServer = (actor: string): McpServer => {
  const server = new McpServer(
    { name: 'mind-library-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  registerVaultTools(server, vault, actor);
  return server;
};

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mind-library-mcp' }));
app.use('/', authRouter);

const handleMcp = async (req: express.Request, res: express.Response) => {
  // Stateless mode: one server + transport per request
  try {
    const server = newServer(actorOf(req, res));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
};

app.post('/mcp', mcpGates, handleMcp);
const methodNotAllowed = (_req: express.Request, res: express.Response) => res.status(405).json({ error: 'Method not allowed (stateless server)' });
app.get('/mcp', mcpGates, methodNotAllowed);
app.delete('/mcp', mcpGates, methodNotAllowed);

app.listen(PORT, HOST, () => {
  console.log(`mind-library-mcp listening on http://${HOST}:${PORT}`);
  console.log(`  vault:  ${VAULT_DIR}`);
  console.log(`  public: ${process.env.PUBLIC_URL ?? 'not set (set PUBLIC_URL to the tunnel URL)'}`);
  console.log(accessCfg
    ? `  access: enforced (issuer ${accessCfg.issuer}, aud ${accessCfg.audience})`
    : '  access: NOT enforced (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)');
});
