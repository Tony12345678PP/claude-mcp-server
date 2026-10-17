import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installSh = fs.readFileSync(fileURLToPath(new URL('../../install.sh', import.meta.url)), 'utf8');

// Pull a top-level shell function out of install.sh so it can run in isolation.
const shellFunction = (name) => {
  const m = installSh.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `${name}() not found in install.sh`);
  return m[0];
};

// Run cloudflared_arch with dpkg and uname stubbed; dpkg = null means "not installed".
const archFor = ({ dpkg, uname }) => {
  const stubs = [
    dpkg === null ? 'dpkg() { return 127; }' : `dpkg() { echo ${dpkg}; }`,
    `uname() { echo ${uname}; }`,
  ].join('\n');
  try {
    return execFileSync('bash', ['-c', `${stubs}\n${shellFunction('cloudflared_arch')}\ncloudflared_arch`], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

test('cloudflared_arch maps uname -m names to cloudflared release names on non-Debian systems', () => {
  assert.equal(archFor({ dpkg: null, uname: 'x86_64' }), 'amd64');
  assert.equal(archFor({ dpkg: null, uname: 'aarch64' }), 'arm64');
  assert.equal(archFor({ dpkg: null, uname: 'armv7l' }), 'armhf');
  assert.equal(archFor({ dpkg: null, uname: 'i686' }), '386');
});

test('cloudflared_arch maps dpkg architecture names', () => {
  assert.equal(archFor({ dpkg: 'amd64', uname: 'x86_64' }), 'amd64');
  assert.equal(archFor({ dpkg: 'arm64', uname: 'aarch64' }), 'arm64');
  assert.equal(archFor({ dpkg: 'i386', uname: 'i686' }), '386');
});

test('cloudflared_arch fails on an unknown architecture instead of guessing a URL', () => {
  assert.equal(archFor({ dpkg: null, uname: 'riscv64' }), null);
});

test('the tunnel token is never passed on a command line', () => {
  assert.doesNotMatch(installSh, /--token\b/);
  assert.match(installSh, /EnvironmentFile=\$TUNNEL_TOKEN_FILE/);
});

test('colour codes are printed, not echoed as literal ${C_*} text', () => {
  assert.doesNotMatch(installSh, /printf '[^']*\$\{C_/);
});

// Render the generated mcp-vault-ctl the way install.sh writes it, with fake paths.
const renderCtl = () => {
  const m = installSh.match(/  cat > \/usr\/local\/bin\/mcp-vault-ctl <<EOF\n[\s\S]*?\nEOF\n  cat >> \/usr\/local\/bin\/mcp-vault-ctl <<'EOF'\n[\s\S]*?\nEOF\n/);
  assert.ok(m, 'mcp-vault-ctl heredocs not found');
  const script = m[0].replaceAll('/usr/local/bin/mcp-vault-ctl', '"$OUT"');
  return execFileSync('bash', ['-euc', `ENV_FILE=/etc/x.env INSTALL_DIR=/opt/x TUNNEL_TOKEN_FILE=/etc/x.tunnel.env\n${script}\ncat "$OUT"`], {
    encoding: 'utf8',
    env: { ...process.env, OUT: `${fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'))}/ctl` },
  });
};

test('mcp-vault-ctl renders under set -u and keeps its runtime variables unexpanded', () => {
  const ctl = renderCtl();
  assert.match(ctl, /^TOKEN_FILE="\/etc\/x\.tunnel\.env"$/m);
  assert.match(ctl, /export "\$\{ENV_KV\[@\]\}"/);
  assert.match(ctl, /TUNNEL_TOKEN="\$\(sed -n 's\/\^TUNNEL_TOKEN=\/\/p' "\$TOKEN_FILE"\)" nohup/);
  assert.doesNotMatch(ctl, /sudo -u mcp-vault env/);
  execFileSync('bash', ['-n'], { input: ctl });
});
