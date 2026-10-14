import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vault, revisionOf } from '../dist/vault.js';

const ACTOR = 'tester';

const makeVault = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault');
  fs.mkdirSync(root);
  return { base, root, vault: new Vault(root, path.join(base, 'data')) };
};

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('rejects traversal, absolute paths and .git', async (t) => {
  const { vault } = makeVault(t);
  assert.throws(() => vault.sandbox.resolve('../escape.txt'), /escapes/);
  assert.throws(() => vault.sandbox.resolve('/etc/passwd'), /Absolute/);
  assert.throws(() => vault.sandbox.resolve('.git/config'), /\.git/);
  assert.throws(() => vault.sandbox.resolve('sub/.git/HEAD'), /\.git/);
  await assert.rejects(vault.write('.git/hooks/pre-commit', 'x', ACTOR), /\.git/);
});

test('rejects symlinks that point outside the vault, including dangling ones', async (t) => {
  const { base, root, vault } = makeVault(t);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(path.join(outside, 'missing.txt'), path.join(root, 'dangling.txt'));
  await assert.rejects(vault.read('link.txt'), /outside the vault/);
  await assert.rejects(vault.write('dangling.txt', 'pwned', ACTOR), /cannot be resolved|outside the vault/);
  assert.equal(fs.existsSync(path.join(outside, 'missing.txt')), false);
});

test('overwrite requires the current revision', async (t) => {
  const { vault } = makeVault(t);
  const created = await vault.write('notes/a.md', 'v1', ACTOR);
  assert.equal(created.created, true);
  await assert.rejects(vault.write('notes/a.md', 'v2', ACTOR), /expected_revision/);
  await assert.rejects(vault.write('notes/a.md', 'v2', ACTOR, 'deadbeefdeadbeef'), /Revision conflict/);
  await vault.write('notes/a.md', 'v2', ACTOR, created.revision);
  assert.equal((await vault.read('notes/a.md')).content, 'v2');
});

test('concurrent overwrites with the same revision: exactly one wins', async (t) => {
  const { vault } = makeVault(t);
  const { revision } = await vault.write('a.txt', 'base', ACTOR);
  const results = await Promise.allSettled([
    vault.write('a.txt', 'from A', 'A', revision),
    vault.write('a.txt', 'from B', 'B', revision),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const loser = results.find(r => r.status === 'rejected');
  assert.match(loser.reason.message, /Revision conflict/);
  assert.ok(['from A', 'from B'].includes((await vault.read('a.txt')).content));
});

test('parallel writes to different files all land', async (t) => {
  const { vault } = makeVault(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => vault.write(`n/${i}.md`, `body ${i}`, ACTOR)));
  assert.equal((await vault.list('')).length, 8);
});

test('first MCP overwrite of a pre-existing file keeps the original in history', async (t) => {
  const { root, vault } = makeVault(t);
  fs.writeFileSync(path.join(root, 'code.ts'), 'original');
  const { revision } = await vault.read('code.ts');
  await vault.write('code.ts', 'changed', ACTOR, revision);
  const versions = await vault.versions('code.ts');
  const original = versions.find(v => v.revision === revisionOf('original'));
  assert.ok(original, 'baseline version is recorded');
  await vault.restore('code.ts', original.commit, ACTOR, revisionOf('changed'));
  assert.equal((await vault.read('code.ts')).content, 'original');
});

test('a deleted file can be restored from history', async (t) => {
  const { vault } = makeVault(t);
  const { revision } = await vault.write('keep.md', 'precious', ACTOR);
  await vault.del('keep.md', ACTOR);
  await assert.rejects(vault.read('keep.md'), /not found/);
  const before = (await vault.versions('keep.md')).find(v => v.revision === revision);
  assert.ok(before, 'pre-delete version is recorded');
  await vault.restore('keep.md', before.commit, ACTOR);
  assert.equal((await vault.read('keep.md')).content, 'precious');
});

test('leaves the user repository index and history alone', async (t) => {
  const { root, vault } = makeVault(t);
  git(root, ['init', '--quiet']);
  git(root, ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '--quiet', '--allow-empty', '-m', 'user init']);
  fs.writeFileSync(path.join(root, 'staged-by-user.txt'), 'x');
  git(root, ['add', 'staged-by-user.txt']);
  const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
  const logBefore = git(root, ['rev-list', '--count', 'HEAD']).trim();

  await vault.write('mcp.txt', 'hi', ACTOR);
  const { revision } = await vault.read('mcp.txt');
  await vault.write('mcp.txt', 'hi again', ACTOR, revision);
  await vault.del('mcp.txt', ACTOR);

  assert.equal(git(root, ['diff', '--cached', '--name-only']).trim(), 'staged-by-user.txt');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']).trim(), logBefore);
});

test('records writes to paths the user repository ignores', async (t) => {
  const { root, vault } = makeVault(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'secret-cache.txt\n');
  const { revision } = await vault.write('secret-cache.txt', 'v1', ACTOR);
  await vault.write('secret-cache.txt', 'v2', ACTOR, revision);
  assert.equal((await vault.versions('secret-cache.txt')).length, 2);
});

test('refuses a DATA_DIR inside the vault', (t) => {
  const { root } = makeVault(t);
  assert.throws(() => new Vault(root, path.join(root, 'data')), /DATA_DIR must not be inside VAULT_DIR/);
});

test('lists files without exposing .git, and lists the root with no argument', async (t) => {
  const { root, vault } = makeVault(t);
  git(root, ['init', '--quiet']);
  await vault.write('a/b.md', 'x', ACTOR);
  assert.deepEqual(await vault.list(''), ['a/b.md']);
});
