import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVaultTools, Vault } from './vault.js';
import { authRouter, requireAuth } from './auth.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1'; // never expose directly; cloudflared is the gatekeeper
const VAULT_DIR = process.env.VAULT_DIR;
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

if (!VAULT_DIR) {
  console.error('FATAL: VAULT_DIR must be set to the mind-library root directory.');
  process.exit(1);
}

const vault = new Vault(VAULT_DIR, DATA_DIR);

const newServer = (): McpServer => {
  const server = new McpServer(
    { name: 'mind-library-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  registerVaultTools(server, vault);
  return server;
};

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mind-library-mcp' }));
app.use('/', authRouter);

const handleMcp = async (req: express.Request, res: express.Response) => {
  // Stateless mode: one server + transport per request
  try {
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
};

app.post('/mcp', requireAuth, handleMcp);
app.get('/mcp', requireAuth, (_req, res) => res.status(405).json({ error: 'Method not allowed (stateless server)' }));
app.delete('/mcp', requireAuth, (_req, res) => res.status(405).json({ error: 'Method not allowed (stateless server)' }));

app.listen(PORT, HOST, () => {
  console.log(`mind-library-mcp listening on http://${HOST}:${PORT}`);
  console.log(`  vault:  ${VAULT_DIR}`);
  console.log(`  public: ${process.env.PUBLIC_URL ?? 'not set (set PUBLIC_URL to the tunnel URL)'}`);
});
