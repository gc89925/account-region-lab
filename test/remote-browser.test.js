import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeProfile, LINKS } from '../lib/model.js';
import { createRemoteLauncher } from '../lib/remote-browser.js';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arl-remote-'));
  const calls = [];
  const profile = makeProfile({ label: 'Remote test', country: 'US', proxy: 'socks5://127.0.0.1:18080' });
  const profileDir = path.join(root, profile.id);
  await mkdir(profileDir);
  const launch = (executable, args, options) => {
    const child = new EventEmitter();
    child.pid = 3000 + calls.length;
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      if (child.ignoreTerm && signal === 'SIGTERM') return true;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    calls.push({ executable, args, options, child });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const launcher = createRemoteLauncher({ launch, startupDelay: 5, closeTimeout: 15, killTimeout: 15, ...overrides });
  t.after(async () => { await launcher.closeAll(); await rm(root, { recursive: true, force: true }); });
  return { root, profile, profileDir, calls, launcher, options: { profile, profileDir, browserPath: process.execPath, url: LINKS.signin } };
}

test('remote native launcher keeps its primary child and persistent directory with browser sandbox intact', async t => {
  const f = await fixture(t);
  const result = await f.launcher.open(f.options);
  assert.equal(result.pageLoadVerified, false);
  assert.equal(result.remote, true);
  assert.equal(f.launcher.isActive(f.profile.id), true);
  assert.equal(f.calls[0].options.detached, false);
  assert.equal(f.calls[0].options.shell, false);
  assert.ok(f.calls[0].args.includes(`--user-data-dir=${f.profileDir}`));
  assert.ok(f.calls[0].args.includes('--proxy-server=socks5://127.0.0.1:18080'));
  assert.ok(!f.calls[0].args.some(arg => /no-sandbox|remote-debugging|enable-automation/.test(arg)));
  assert.deepEqual(await f.launcher.close(f.profile.id), { ok: true, closed: true, forced: false });
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.equal(f.launcher.isActive(f.profile.id), false);
});

test('a second profile is refused even while the first browser is starting', async t => {
  const f = await fixture(t, { startupDelay: 30 });
  const pending = f.launcher.open(f.options);
  const other = makeProfile({ label: 'Another', country: 'US', proxy: f.profile.proxy });
  const otherDir = path.join(f.root, other.id);
  await mkdir(otherDir);
  await assert.rejects(f.launcher.open({ ...f.options, profile: other, profileDir: otherDir }), /一次只运行一个/);
  await pending;
  assert.equal(f.calls.length, 1);
});

test('URL handoff helper exit never clears the original active browser', async t => {
  const f = await fixture(t);
  await f.launcher.open(f.options);
  const request = f.launcher.open({ ...f.options, url: LINKS.gmail });
  while (f.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  f.calls[1].child.emit('exit', 0, null);
  await request;
  assert.equal(f.calls[1].args.at(-1), LINKS.gmail);
  assert.equal(f.launcher.isActive(f.profile.id), true);
  f.calls[0].child.emit('exit', 0, null);
  assert.equal(f.launcher.isActive(f.profile.id), false);
});

test('primary startup exit reports failure and releases the single browser slot', async t => {
  const f = await fixture(t, { startupDelay: 30 });
  const request = f.launcher.open(f.options);
  const rejected = assert.rejects(request, /启动后退出/);
  while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  f.calls[0].child.emit('exit', 0, null);
  await rejected;
  assert.equal(f.launcher.isActive(f.profile.id), false);
  assert.equal((await f.launcher.open(f.options)).ok, true);
});

test('close escalates only after SIGTERM grace period and waits for exit', async t => {
  const f = await fixture(t, { closeTimeout: 25 });
  await f.launcher.open(f.options);
  f.calls[0].child.ignoreTerm = true;
  const pending = f.launcher.close(f.profile.id);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.equal((await pending).forced, true);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.launcher.isActive(f.profile.id), false);
});

test('shutdown blocks new requests and invalid targets never spawn a process', async t => {
  const f = await fixture(t);
  await assert.rejects(f.launcher.open({ ...f.options, url: 'https://example.invalid/' }), /仅能打开/);
  await assert.rejects(f.launcher.open({ ...f.options, profileDir: f.root }), /独立浏览器目录/);
  assert.equal(f.calls.length, 0);
  await f.launcher.open(f.options);
  await f.launcher.closeAll();
  await assert.rejects(f.launcher.open(f.options), /正在停止/);
});
