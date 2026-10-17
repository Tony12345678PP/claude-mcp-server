import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Sandbox } from './sandbox.js';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export type Encoding = 'utf8' | 'base64';

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
}

/** Hash of the file's bytes; for UTF-8 text this equals the hash of the string, so text revisions are unchanged. */
export const revisionOf = (content: string | Buffer): string => sha256(content).slice(0, 16);

/** Text only if the bytes survive a UTF-8 round trip and contain no NUL; everything else goes over the wire as base64. */
export function encodingOf(bytes: Buffer): Encoding {
  if (bytes.includes(0)) return 'base64';
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) ? 'utf8' : 'base64';
}

// Highest-precedence attributes for the shadow repo, so a .gitattributes in the vault
// cannot make git EOL-normalize, filter (e.g. LFS) or re-encode what it stores.
const SHADOW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n';

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Every mutation runs under one lock so concurrent MCP clients are serialized:
 * a revision check and the write that follows it cannot interleave with another write.
 * Version history lives in a shadow git repo (DATA_DIR/shadow.git) whose work tree is the vault,
 * so the user's own .git is never touched.
 */
export class Vault {
  readonly sandbox: Sandbox;
  private readonly root: string;
  private readonly gitDir: string;
  private readonly lock = new Mutex();

  constructor(root: string, dataDir: string) {
    this.sandbox = new Sandbox(root);
    this.root = this.sandbox.root;
    fsSync.mkdirSync(dataDir, { recursive: true });
    const dataReal = fsSync.realpathSync(dataDir);
    if (dataReal === this.root || dataReal.startsWith(this.root + path.sep)) {
      throw new Error('DATA_DIR must not be inside VAULT_DIR');
    }
    this.gitDir = path.join(dataReal, 'shadow.git');
    if (!fsSync.existsSync(path.join(this.gitDir, 'HEAD'))) this.initShadow();
    fsSync.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
    fsSync.writeFileSync(path.join(this.gitDir, 'info', 'attributes'), SHADOW_ATTRIBUTES);
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_LITERAL_PATHSPECS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
  }

  private identityArgs(actor: string): string[] {
    return ['-c', `user.name=${actor}`, '-c', 'user.email=mcp@localhost', '-c', 'commit.gpgsign=false'];
  }

  private async git(args: string[], actor = 'mcp'): Promise<string> {
    const { stdout } = await execFileAsync('git', [...this.identityArgs(actor), ...args], {
      cwd: this.root,
      env: this.gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  }

  private async gitBytes(args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync('git', [...this.identityArgs('mcp'), ...args], {
      cwd: this.root,
      env: this.gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'buffer',
    });
    return stdout;
  }

  private initShadow(): void {
    fsSync.mkdirSync(this.gitDir, { recursive: true });
    const env = this.gitEnv();
    execFileSync('git', ['init', '--quiet'], { cwd: this.root, env });
    execFileSync('git', ['config', 'core.bare', 'false'], { cwd: this.root, env });
    execFileSync('git', [...this.identityArgs('mcp'), 'commit', '--quiet', '--allow-empty', '-m', 'init'], { cwd: this.root, env });
  }

  private relOf(rel: string): string {
    return this.sandbox.toRelative(this.sandbox.resolve(rel));
  }

  private async hasHistory(relPath: string): Promise<boolean> {
    return (await this.git(['log', '-n', '1', '--format=%H', '--', relPath])).trim() !== '';
  }

  /** Records the file's current on-disk content as history before the first MCP change to it. */
  private async ensureBaseline(relPath: string, actor: string): Promise<void> {
    if (await this.hasHistory(relPath)) return;
    await this.commitPath(relPath, `baseline ${relPath}`, actor);
  }

  private async commitPath(relPath: string, subject: string, actor: string): Promise<void> {
    await this.git(['add', '-A', '-f', '--', relPath], actor);
    await this.git(['commit', '--quiet', '--only', '-m', `${subject}\n\nClient: ${actor}`, '--', relPath], actor);
  }

  async read(rel: string): Promise<{ content: string; encoding: Encoding; revision: string; mtime: string }> {
    return this.lock.run(async () => {
      const abs = this.sandbox.resolve(rel);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new Error(`File not found: ${rel}`);
      const bytes = await fs.readFile(abs);
      const encoding = encodingOf(bytes);
      return { content: bytes.toString(encoding), encoding, revision: revisionOf(bytes), mtime: stat.mtime.toISOString() };
    });
  }

  async list(rel: string): Promise<string[]> {
    const abs = rel ? this.sandbox.resolve(rel) : this.root;
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new Error(`Not found: ${rel}`);
    if (stat.isFile()) return [this.sandbox.toRelative(abs)];
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(this.sandbox.toRelative(full));
      }
    };
    await walk(abs);
    return out.sort();
  }

  async write(
    rel: string,
    content: string | Buffer,
    actor: string,
    expectedRevision?: string,
    encoding: Encoding = 'utf8',
  ): Promise<{ revision: string; created: boolean }> {
    const bytes = typeof content === 'string' ? Buffer.from(content, encoding) : content;
    return this.lock.run(async () => {
      const abs = this.sandbox.resolve(rel);
      const relPath = this.sandbox.toRelative(abs);
      const prev = await fs.readFile(abs).catch(() => null);
      if (prev === null && expectedRevision !== undefined) {
        throw new Error(`File does not exist: ${rel}. Omit expected_revision when creating a file.`);
      }
      if (prev !== null) {
        if (expectedRevision === undefined) {
          throw new Error(`File exists: ${rel}. Read it first and pass its revision as expected_revision.`);
        }
        const current = revisionOf(prev);
        if (current !== expectedRevision) {
          throw new Error(`Revision conflict: expected ${expectedRevision}, current is ${current}. Re-read the file and merge your changes.`);
        }
      }
      const revision = revisionOf(bytes);
      if (prev?.equals(bytes)) return { revision, created: false };
      if (prev !== null) await this.ensureBaseline(relPath, actor);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      await this.commitPath(relPath, `${prev === null ? 'create' : 'write'} ${relPath}`, actor);
      return { revision, created: prev === null };
    });
  }

  async del(rel: string, actor: string): Promise<{ deleted: string }> {
    return this.lock.run(async () => {
      const abs = this.sandbox.resolve(rel);
      const relPath = this.sandbox.toRelative(abs);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new Error(`File not found: ${rel}`);
      await this.ensureBaseline(relPath, actor);
      await fs.unlink(abs);
      await this.commitPath(relPath, `delete ${relPath}`, actor);
      return { deleted: relPath };
    });
  }

  async versions(rel: string): Promise<{ commit: string; date: string; subject: string; revision: string | null }[]> {
    return this.lock.run(async () => {
      const relPath = this.relOf(rel);
      const log = await this.git(['log', '-n', '50', '--format=%H%x09%cI%x09%s', '--', relPath]);
      const rows = log.split('\n').filter(Boolean).map(line => {
        const [commit, date, ...subject] = line.split('\t');
        return { commit, date, subject: subject.join('\t') };
      });
      const out: { commit: string; date: string; subject: string; revision: string | null }[] = [];
      for (const row of rows) {
        const content = await this.gitBytes(['show', `${row.commit}:${relPath}`]).catch(() => null);
        out.push({ ...row, revision: content === null ? null : revisionOf(content) });
      }
      return out;
    });
  }

  async restore(rel: string, commit: string, actor: string, expectedRevision?: string): Promise<{ revision: string; created: boolean }> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('Invalid version id');
    const relPath = this.relOf(rel);
    const content = await this.gitBytes(['show', `${commit}:${relPath}`]).catch(() => {
      throw new Error(`Version not found: ${commit}`);
    });
    return this.write(rel, content, actor, expectedRevision);
  }
}

export function registerVaultTools(server: McpServer, vault: Vault, actor: string): void {
  const p = z.string().describe('Vault-relative path, e.g. "notes/idea.md"');
  const expectedRevision = z.string().optional().describe('Revision from read_file. Required when the file already exists.');

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
    description: 'Read a file from the mind library. Returns content and a revision hash. Binary files (images, PDFs) are returned as base64 with "Encoding: base64".',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const r = await vault.read(rel);
    return { content: [{ type: 'text', text: `Revision: ${r.revision}\nEncoding: ${r.encoding}\n\n${r.content}` }] };
  });

  server.registerTool('write_file', {
    title: 'Write file',
    description: 'Create a file, or overwrite an existing one. Overwriting REQUIRES expected_revision from read_file; a stale revision fails with a conflict. Pass encoding "base64" to write binary content.',
    inputSchema: {
      path: p,
      content: z.string().describe('Full file content'),
      expected_revision: expectedRevision,
      encoding: z.enum(['utf8', 'base64']).optional().describe('How content is encoded; defaults to utf8'),
    },
  }, async ({ path: rel, content, expected_revision, encoding }) => {
    const r = await vault.write(rel, content, actor, expected_revision, encoding);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
  });

  server.registerTool('delete_file', {
    title: 'Delete file',
    description: 'Delete a file. The deletion is recorded in git history and can be undone with restore_version.',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const r = await vault.del(rel, actor);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
  });

  server.registerTool('list_versions', {
    title: 'List versions',
    description: 'List the change history of a file, newest first. Each entry has a commit id usable with restore_version.',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const vs = await vault.versions(rel);
    return { content: [{ type: 'text', text: JSON.stringify({ versions: vs }, null, 2) }] };
  });

  server.registerTool('restore_version', {
    title: 'Restore version',
    description: 'Restore a file to the content of a commit from list_versions. Overwrites the current file, so expected_revision is required if it exists.',
    inputSchema: { path: p, version: z.string().describe('Commit id from list_versions'), expected_revision: expectedRevision },
  }, async ({ path: rel, version, expected_revision }) => {
    const r = await vault.restore(rel, version, actor, expected_revision);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
  });
}
