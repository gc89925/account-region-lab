import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, curlArgs } from '../lib/runtime.js';

test('proxy probe disables curl configuration and environment bypasses and resolves SOCKS DNS through the proxy', () => {
  for (const proxy of ['http://127.0.0.1:18080', 'socks5://127.0.0.1:1080']) {
    const args = curlArgs(proxy);
    assert.equal(args[0], '--disable', 'curl must ignore user .curlrc before reading any other argument');
    assert.equal(args[args.indexOf('--noproxy') + 1], '', 'Even inherited NO_PROXY must not bypass the selected proxy');
    assert.equal(args[args.indexOf('--proxy') + 1], proxy.replace(/^socks5:/, 'socks5h:'));
    assert.equal(args.filter(argument => argument.startsWith('https://')).length, 1);
    assert.equal(args[args.indexOf('--proto') + 1], '=https');
    assert.ok(!args.includes('--location'), 'The probe must not follow arbitrary redirects');
    assert.ok(!args.some(argument => argument.includes('direct://')), 'No direct connection fallback may be configured');
    assert.ok(Number(args[args.indexOf('--max-time') + 1]) > 0);
  }
  assert.throws(() => curlArgs(''));
  assert.throws(() => curlArgs('http://user:password@localhost:1080'));
});

test('a data directory has one active writer and can be reopened after its lock is released', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'account-region-lab-lock-test-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const release = acquireLock(dataDir);
  try { assert.throws(() => acquireLock(dataDir)); } finally { release(); }
  const releaseAgain = acquireLock(dataDir);
  releaseAgain();
});
