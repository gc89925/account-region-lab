import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublicFile, checkTrackedPublicFiles, formatPublicFindings } from '../scripts/check-public-files.mjs';

test('runtime files, browser databases and credential keys cannot be published', () => {
  for (const file of ['data/state.json', 'Profiles/account/Preferences', 'access.json', 'nested/proxy-vault.key', '.env.production', 'id_ed25519', 'certificate.pem', 'backup.tar.gz', 'debug.log', 'Default/Network/Cookies', 'Default/Login Data', 'Local State', 'work/report.txt']) {
    assert.ok(inspectPublicFile(file, '{}').length, file);
  }
  for (const file of ['deploy/linux/account-region-lab.env.example', '.env.example', 'README.md', 'test/proxy-auth.test.js']) {
    assert.deepEqual(inspectPublicFile(file, 'synthetic example'), [], file);
  }
});

test('keys and API tokens are rejected even in tests and are never included in reports', () => {
  const privateMarker = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('');
  const fakeToken = 'github_pat_' + 'T'.repeat(60);
  for (const file of ['config.txt', 'test/fixture.txt']) {
    const findings = inspectPublicFile(file, privateMarker + '\n' + fakeToken);
    assert.ok(findings.some(item => item.type === 'private key material'));
    assert.ok(findings.some(item => item.type === 'possible API credential'));
    const report = formatPublicFindings(findings);
    assert.ok(!report.includes(fakeToken));
    assert.ok(!report.includes(privateMarker));
    assert.deepEqual(Object.keys(findings[0]).sort(), ['file', 'type']);
  }
  assert.ok(inspectPublicFile('config.txt', Buffer.from('\ufeff' + privateMarker, 'utf16le')).length);
});

test('proxy credentials are rejected in published examples while public provider endpoints remain allowed', () => {
  const uri = ['socks5://', 'demo-user:demo-password', '@proxy.example:1080'].join('');
  const providerLine = ['proxy.example:12321:', 'demo-user:demo-password'].join('');
  for (const contents of [uri, providerLine]) {
    assert.ok(inspectPublicFile('docs/example.md', contents).some(item => item.type === 'literal proxy or URL credentials'));
    assert.deepEqual(inspectPublicFile('test/parser.test.js', contents), []);
  }
  assert.deepEqual(inspectPublicFile('docs/example.md', 'socks5://geo.iproyal.com:12321'), []);
  assert.deepEqual(inspectPublicFile('docs/example.md', 'socks5://用户名:密码@主机:端口'), []);
  assert.deepEqual(inspectPublicFile('docs/example.md', 'socks5://USERNAME:PASSWORD@HOST:PORT'), []);
});

test('tracked file audit checks staged and working contents, omits untracked files and exits without revealing credentials', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'arl-public-check-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  const fakeToken = 'ghp_' + 'Q'.repeat(40);
  writeFileSync(join(cwd, 'staged.txt'), fakeToken);
  writeFileSync(join(cwd, 'working.txt'), 'safe');
  git('add', 'staged.txt', 'working.txt');
  writeFileSync(join(cwd, 'staged.txt'), 'safe');
  writeFileSync(join(cwd, 'working.txt'), fakeToken);
  writeFileSync(join(cwd, 'untracked.txt'), fakeToken);
  const result = checkTrackedPublicFiles(cwd);
  assert.equal(result.files, 2);
  assert.deepEqual(result.findings.map(item => item.file).sort(), ['staged.txt', 'working.txt']);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-public-files.mjs', import.meta.url))], { cwd, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /possible API credential/);
  assert.ok(!cli.stderr.includes(fakeToken));
  assert.ok(!cli.stdout.includes(fakeToken));
});
