import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManagedLauncher, DIAGNOSTICS_URL } from '../lib/managed.js';

const ID = '21ff9d0b-68ad-4d73-856e-10303b0f207a';
async function fixture(t, behavior = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'account-region-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileDir = path.join(root, ID); await mkdir(profileDir);
  const browserPath = path.join(root, 'browser.exe'); await writeFile(browserPath, 'test stub');
  const calls = []; const contexts = [];
  const chromium = { async launchPersistentContext(directory, options) {
    calls.push({ directory, options });
    if (behavior.launchError) throw new Error('secret proxy http://user:credential@private.test');
    const context = new EventEmitter();
    context.pages = [];
    context.newPage = async () => {
      const page = { closed: false, async goto(url) { page.url = url; if (behavior.navigationError) throw new Error('proxy credential'); }, async close() { page.closed = true; } };
      context.pages.push(page); return page;
    };
    context.close = async () => { context.closed = true; context.emit('close'); };
    contexts.push(context); return context;
  } };
  const launcher = createManagedLauncher({ chromium });
  const options = { profile: { id: ID, country: 'NG', proxy: 'socks5://127.0.0.1:1080', environment: { engine: 'managed' } }, profileDir, browserPath, url: 'https://mail.google.com/' };
  return { launcher, options, calls, contexts, behavior };
}

test('managed profiles apply declared settings without stealth and concurrent opens share one context', async t => {
  const { launcher, options, calls, contexts } = await fixture(t);
  assert.deepEqual(await Promise.all([launcher.open(options), launcher.open(options)]), [{ ok: true }, { ok: true }]);
  assert.equal(calls.length, 1); assert.equal(contexts[0].pages.length, 2); assert.equal(launcher.isActive(ID), true);
  const config = calls[0].options;
  assert.equal(config.locale, 'en-NG'); assert.equal(config.timezoneId, 'Africa/Lagos');
  assert.deepEqual(config.viewport, { width: 1365, height: 900 });
  assert.deepEqual(config.proxy, { server: options.profile.proxy }); assert.deepEqual(config.permissions, []);
  assert.equal(config.headless, false); assert.equal(config.chromiumSandbox, true);
  assert.equal(config.downloadsPath, path.join(options.profileDir, 'Downloads'));
  assert.equal(config.ignoreDefaultArgs, undefined); assert.equal(config.userAgent, undefined);
  assert.ok(config.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(config.args.includes('--proxy-bypass-list=<-loopback>'));
  await assert.rejects(launcher.open({ ...options, profile: { ...options.profile, environment: { engine: 'managed', locale: 'en-US' } } }));
  assert.deepEqual(await launcher.close(ID), { ok: true, closed: true });
  assert.equal(launcher.isActive(ID), false);
});

test('failed navigation is not a successful login and retains the reusable context', async t => {
  const { launcher, options, contexts, behavior } = await fixture(t, { navigationError: true });
  const result = await launcher.open(options);
  assert.equal(result.ok, false); assert.equal(result.code, 'NAVIGATION_FAILED'); assert.equal(result.active, true);
  assert.equal(contexts[0].pages[0].closed, false); assert.equal(launcher.isActive(ID), true);
  assert.ok(!JSON.stringify(result).includes('credential'));
  behavior.navigationError = false;
  assert.deepEqual(await launcher.open({ ...options, url: DIAGNOSTICS_URL + '#' + encodeURIComponent(JSON.stringify({ engine: 'managed' })) }), { ok: true });
  contexts[0].emit('close'); assert.equal(launcher.isActive(ID), false);
});

test('failed starts are sanitized and release the active slot for retry', async t => {
  const { launcher, options, behavior } = await fixture(t, { launchError: true });
  const result = await launcher.open(options);
  assert.equal(result.code, 'BROWSER_START_FAILED'); assert.equal(result.active, false);
  assert.ok(!JSON.stringify(result).includes('credential')); assert.equal(launcher.isActive(ID), false);
  behavior.launchError = false; assert.deepEqual(await launcher.open(options), { ok: true });
  await launcher.closeAll(); assert.equal(launcher.isActive(ID), false);
});

test('managed launcher rejects traversal, missing profiles, arbitrary URLs and credential URLs', async t => {
  const { launcher, options, calls } = await fixture(t);
  for (const invalid of [
    { ...options, profile: { ...options.profile, id: '../escape' } },
    { ...options, profileDir: path.dirname(options.profileDir) },
    { ...options, profileDir: path.join(path.dirname(options.profileDir), 'missing', ID) },
    { ...options, browserPath: 'relative.exe' },
    { ...options, profile: { ...options.profile, proxy: '' } },
    { ...options, profile: { ...options.profile, proxy: 'http://user:credential@private.test:80' } },
    { ...options, url: 'https://example.com/' },
    { ...options, url: 'https://user:credential@mail.google.com/' },
    { ...options, url: 'file:///etc/passwd' },
    { ...options, url: 'http://mail.google.com/' },
  ]) await assert.rejects(launcher.open(invalid), error => !error.message.includes('credential'));
  assert.equal(calls.length, 0);
});
