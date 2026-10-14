import path from 'node:path';
import fs from 'node:fs';

/**
 * Path sandbox: every operation must stay inside the vault root.
 * Uses realpath to defeat symlink escapes, and rejects traversal.
 */
export class Sandbox {
  private readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(root);
  }

  /** Resolve a vault-relative path and verify it stays inside the root. */
  resolve(relPath: string): string {
    if (!relPath || relPath.includes('\0')) throw new Error('Invalid path');
    if (path.isAbsolute(relPath)) throw new Error('Absolute paths are not allowed');
    const normalized = path.normalize(path.join(this.root, relPath));
    if (normalized !== this.root && !normalized.startsWith(this.root + path.sep)) {
      throw new Error('Path escapes the vault');
    }
    // realpath check: walk up to the nearest existing ancestor and realpath it
    let probe = normalized;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      throw new Error('Path resolves outside the vault');
    }
    return normalized;
  }

  toRelative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }
}
