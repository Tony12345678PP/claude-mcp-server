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

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export const revisionOf = (content: string): string => sha256(content).slice(0, 16);

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

  async read(rel: string): Promise<{ content: string; revision: string; mtime: string }> {
    return this.lock.run(async () => {
      const abs = this.sandbox.resolve(rel);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new Error(`File not found: ${rel}`);
      const content = await fs.readFile(abs, 'utf8');
      return { content, revision: revisionOf(content), mtime: stat.mtime.toISOString() };
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

  async write(rel: string, content: string, actor: string, expectedRevision?: string): Promise<{ revision: string; created: boolean }> {
    return this.lock.run(async () => {
      const abs = this.sandbox.resolve(rel);
      const relPath = this.sandbox.toRelative(abs);
      const prev = await fs.readFile(abs, 'utf8').catch(() => null);
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
      const revision = revisionOf(content);
      if (prev === content) return { revision, created: false };
      if (prev !== null) await this.ensureBaseline(relPath, actor);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
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
        const content = await this.git(['show', `${row.commit}:${relPath}`]).catch(() => null);
        out.push({ ...row, revision: content === null ? null : revisionOf(content) });
      }
      return out;
    });
  }

  async restore(rel: string, commit: string, actor: string, expectedRevision?: string): Promise<{ revision: string; created: boolean }> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('Invalid version id');
    const relPath = this.relOf(rel);
    const content = await this.git(['show', `${commit}:${relPath}`]).catch(() => {
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
    description: 'Read a file from the mind library. Returns content and a revision hash.',
    inputSchema: { path: p },
  }, async ({ path: rel }) => {
    const r = await vault.read(rel);
    return { content: [{ type: 'text', text: `Revision: ${r.revision}\n\n${r.content}` }] };
  });

  server.registerTool('write_file', {
    title: 'Write file',
    description: 'Create a file, or overwrite an existing one. Overwriting REQUIRES expected_revision from read_file; a stale revision fails with a conflict.',
    inputSchema: { path: p, content: z.string().describe('Full file content'), expected_revision: expectedRevision },
  }, async ({ path: rel, content, expected_revision }) => {
    const r = await vault.write(rel, content, actor, expected_revision);
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
