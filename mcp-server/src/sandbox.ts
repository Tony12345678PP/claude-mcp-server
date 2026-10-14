import path from 'node:path';
import fs from 'node:fs';

const contains = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * Path sandbox: every operation must stay inside the root.
 * Returns the realpath-resolved path so callers act on the verified location,
 * never on a path that still contains a symlink.
 */
export class Sandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(root);
  }

  resolve(relPath: string): string {
    if (!relPath || relPath.includes('\0')) throw new Error('Invalid path');
    if (path.isAbsolute(relPath)) throw new Error('Absolute paths are not allowed');
    const normalized = path.normalize(path.join(this.root, relPath));
    if (!contains(this.root, normalized)) throw new Error('Path escapes the vault');

    let probe = normalized;
    while (fs.lstatSync(probe, { throwIfNoEntry: false }) === undefined) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    let real: string;
    try {
      real = fs.realpathSync(probe);
    } catch {
      throw new Error('Path cannot be resolved inside the vault');
    }
    const resolved = path.join(real, path.relative(probe, normalized));
    if (!contains(this.root, resolved)) throw new Error('Path resolves outside the vault');
    if (path.relative(this.root, resolved).split(path.sep).some(seg => seg.toLowerCase() === '.git')) {
      throw new Error('Access to .git is not allowed');
    }
    return resolved;
  }

  toRelative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }
}
