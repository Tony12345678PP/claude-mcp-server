import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Sandbox } from './sandbox.js';
import { Audit } from './audit.js';

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export class Vault {
  readonly sandbox: Sandbox;
  readonly audit: Audit;
  private readonly versionsDir: string;
  private readonly trashDir: string;

  constructor(root: string, dataDir: string) {
    this.sandbox = new Sandbox(root);
    this.audit = new Audit(path.join(dataDir, 'audit.log'));
    this.versionsDir = path.join(dataDir, 'versions');
    this.trashDir = path.join(dataDir, 'trash');
    fsSync.mkdirSync(this.versionsDir, { recursive: true });
    fsSync.mkdirSync(this.trashDir, { recursive: true });
  }

  revisionOf(content: string): string {
    return sha256(content).slice(0, 16);
  }

  async read(rel: string): Promise<{ content: string; revision: string; mtime: string }> {
    const abs = this.sandbox.resolve(rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new Error(`File not found: ${rel}`);
    const content = await fs.readFile(abs, 'utf8');
    return { content, revision: this.revisionOf(content), mtime: stat.mtime.toISOString() };
  }

  async list(rel: string): Promise<string[]> {
    const abs = this.sandbox.resolve(rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new Error(`Not found: ${rel}`);
    if (stat.isFile()) return [this.sandbox.toRelative(abs)];
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(this.sandbox.toRelative(full));
      }
    };
    await walk(abs);
    return out.sort();
  }

  async write(rel: string, content: string, expectedRevision?: string): Promise<{ revision: string; created: boolean }> {
    const abs = this.sandbox.resolve(rel);
    const prev = await fs.readFile(abs, 'utf8').catch(() => null);
    if (prev !== null && expectedRevision !== undefined) {
      if (this.revisionOf(prev) !== expectedRevision) {
        throw new Error(
          `Revision conflict: expected ${expectedRevision}, current is ${this.revisionOf(prev)}. Re-read the file and merge your changes.`
        );
      }
    }
    if (prev !== null && prev !== content) {
      await this.snapshot(rel, prev);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const revision = this.revisionOf(content);
    this.audit.log({ op: 'write', path: rel, revision, conflictChecked: expectedRevision !== undefined });
    return { revision, created: prev === null };
  }

  async del(rel: string): Promise<{ trashedTo: string }> {
    const abs = this.sandbox.resolve(rel);
    const content = await fs.readFile(abs, 'utf8').catch(() => {
      throw new Error(`File not found: ${rel}`);
    });
    await this.snapshot(rel, content);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const trashed = path.join(this.trashDir, `${ts}__${sha256(rel).slice(0, 8)}__${path.basename(rel)}`);
    await fs.copyFile(abs, trashed);
    await fs.unlink(abs);
    this.audit.log({ op: 'delete', path: rel });
    return { trashedTo: this.sandbox.toRelative(trashed) };
  }

  private async snapshot(rel: string, content: string): Promise<void> {
    const dir = path.join(this.versionsDir, sha256(rel).slice(0, 24));
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, ts), content, 'utf8');
  }

  async versions(rel: string): Promise<{ version: string; revision: string }[]> {
    const dir = path.join(this.versionsDir, sha256(rel).slice(0, 24));
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: { version: string; revision: string }[] = [];
    for (const name of names.sort().reverse()) {
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      out.push({ version: name, revision: this.revisionOf(content) });
    }
    return out;
  }

  async restore(rel: string, version: string): Promise<{ revision: string }> {
    const dir = path.join(this.versionsDir, sha256(rel).slice(0, 24));
    const versionPath = path.join(dir, path.basename(version));
    const content = await fs.readFile(versionPath, 'utf8').catch(() => {
      throw new Error(`Version not found: ${version}`);
    });
    return this.write(rel, content);
  }
}

export function registerVaultTools(server: McpServer, vault: Vault): void {
  const p = z.string().describe('Vault-relative path, e.g. "notes/idea.md"');

  server.registerTool('list_files', {
    title: 'List files',
    description: 'List all files under a directory (or the whole vault) inside the mind library.',
    inputSchema: { dir: z.string().optional().describe('Optional sub-directory; defaults to vault root') },
  }, async ({ dir }) => {
    const files = await vault.list(dir ?? '');
    return { content: [{ type: 'text', text: JSON.stringify({ files }, null, 2) }] };
  });

  server.registerTool('read_file', {
    title: 'Read file',
    description: 'Read a file from the mind library. Returns content and a revision hash.',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const r = await vault.read(rel);
    return { content: [{ type: 'text', text: `Revision: ${r.revision}\n\n${r.content}` }] };
  });

  server.registerTool('write_file', {
    title: 'Write file',
    description: 'Create or overwrite a file. Pass expected_revision to fail on conflict (recommended when editing).',
    inputSchema: { path: p, content: z.string().describe('Full file content'), expected_revision: z.string().optional().describe('Revision previously returned by read_file') },
  }, async ({ path: rel, content, expected_revision }) => {
    const r = await vault.write(rel, content, expected_revision);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
  });

  server.registerTool('delete_file', {
    title: 'Delete file (soft)',
    description: 'Soft-delete a file: current content is snapshotted, then the file is moved to trash. Recoverable via restore_version.',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const r = await vault.del(rel);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
  });

  server.registerTool('list_versions', {
    title: 'List versions',
    description: 'List saved versions (write/delete history) of a file.',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const vs = await vault.versions(rel);
    return { content: [{ type: 'text', text: JSON.stringify({ versions: vs }, null, 2) }] };
  });

  server.registerTool('restore_version', {
    title: 'Restore version',
    description: 'Restore a file from a previous version (from list_versions).',
    inputSchema: { path: p, version: z.string().describe('Version name from list_versions') },
  }, async ({ path: rel, version }) => {
    const r = await vault.restore(rel, version);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
  });
}
