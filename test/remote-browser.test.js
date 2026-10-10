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
  const desktopCalls = [];
  const desktopEntries = new Map();
  let generation = 0;
  const desktops = {
    async open(id) {
      const sequence = generation++;
      let resolveExit;
      const runtime = { port: 6101 + sequence % 5, generation: sequence.toString(16).padStart(32, '0'),
        env: { DISPLAY: `:${200 + sequence % 5}`, XAUTHORITY: path.join(root, `${id}.Xauthority`) },
        exited: new Promise(resolve => { resolveExit = resolve; }), resolveExit: () => resolveExit() };
      desktopEntries.set(id, runtime);
      desktopCalls.push({ action: 'open', id });
      return runtime;
    },
    async close(id) {
      desktopCalls.push({ action: 'close', id });
      const runtime = desktopEntries.get(id);
      runtime?.resolveExit();
      desktopEntries.delete(id);
      return { ok: true, closed: !!runtime, forced: false };
    },
    get: id => desktopEntries.get(id) || null,
  };
  const profile = makeProfile({ label: 'Remote test', country: 'US', proxy: 'socks5://127.0.0.1:18080' });
  const profileDir = path.join(root, profile.id);
  await mkdir(profileDir);
  const launch = (executable, args, options) => {
    const child = new EventEmitter();
    child.pid = 3000 + calls.length;
    child.signals = [];
    child.signalTimes = [];
    child.kill = signal => {
      child.signals.push(signal);
      child.signalTimes.push(Date.now());
      if (child.ignoreAll || (child.ignoreTerm && signal === 'SIGTERM')) return true;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    calls.push({ executable, args, options, child });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const launcher = createRemoteLauncher({ desktops, launch, startupDelay: 5, closeTimeout: 15, killTimeout: 15, ...overrides });
  t.after(async () => { calls.forEach(({ child }) => { child.ignoreAll = false; }); await launcher.closeAll(); await rm(root, { recursive: true, force: true }); });
  const options = { profile, profileDir, browserPath: process.execPath, url: LINKS.signin };
  async function another() {
    const other = makeProfile({ label: 'Another', country: 'JP', proxy: profile.proxy });
    const otherDir = path.join(root, other.id);
    await mkdir(otherDir);
    return { ...options, profile: other, profileDir: otherDir };
  }
  return { root, profile, profileDir, calls, desktopCalls, desktops, desktopEntries, launcher, options, another };
}

async function until(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('remote native launcher keeps its primary child and persistent directory with browser sandbox intact', async t => {
  const f = await fixture(t);
  const result = await f.launcher.open(f.options);
  assert.equal(result.pageLoadVerified, false);
  assert.equal(result.remote, true);
  assert.equal(f.launcher.isActive(f.profile.id), true);
  assert.equal(f.calls[0].options.detached, false);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.env.DISPLAY, ':200');
  assert.equal(f.calls[0].options.env.XAUTHORITY, path.join(f.root, `${f.profile.id}.Xauthority`));
  assert.deepEqual(f.launcher.getDesktop(f.profile.id), { port: 6101, generation: '0'.repeat(32) });
  assert.ok(f.calls[0].args.includes(`--user-data-dir=${f.profileDir}`));
  assert.ok(f.calls[0].args.includes('--proxy-server=socks5://127.0.0.1:18080'));
  assert.ok(!f.calls[0].args.some(arg => /no-sandbox|remote-debugging|enable-automation/.test(arg)));
  assert.deepEqual(await f.launcher.close(f.profile.id), { ok: true, closed: true, forced: false });
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.equal(f.launcher.isActive(f.profile.id), false);
});

test('five different environments have independent displays and starting entries reserve all slots', async t => {
  const f = await fixture(t, { startupDelay: 100 });
  const options = [f.options, ...await Promise.all(Array.from({ length: 5 }, () => f.another()))];
  const pending = options.slice(0, 5).map(option => f.launcher.open(option));
  await until(() => f.calls.length === 5);
  assert.equal(f.launcher.getDesktop(f.profile.id), null);
  await assert.rejects(f.launcher.open(options[5]), /最多同时运行 5/);
  await Promise.all(pending);
  assert.equal(new Set(f.calls.map(call => call.options.env.DISPLAY)).size, 5);
  assert.equal(new Set(f.calls.map(call => call.options.env.XAUTHORITY)).size, 5);
  await f.launcher.close(f.profile.id);
  assert.equal(f.launcher.isActive(options[1].profile.id), true);
  assert.equal(f.calls[1].child.signals.length, 0);
  await f.launcher.open(options[5]);
  assert.equal(f.launcher.isActive(options[5].profile.id), true);
});

test('URL handoff adds a tab without forcing another window or clearing the original browser', async t => {
  const f = await fixture(t);
  await f.launcher.open(f.options);
  const request = f.launcher.open({ ...f.options, url: LINKS.gmail });
  while (f.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  f.calls[1].child.emit('exit', 0, null);
  await request;
  assert.ok(f.calls[0].args.includes('--new-window'));
  assert.ok(!f.calls[1].args.includes('--new-window'));
  assert.equal(f.calls[1].args.find(arg => arg.startsWith('--user-data-dir=')), `--user-data-dir=${f.profileDir}`);
  assert.equal(f.calls[1].args.find(arg => arg.startsWith('--proxy-server=')), '--proxy-server=socks5://127.0.0.1:18080');
  assert.equal(f.calls[1].args.at(-1), LINKS.gmail);
  assert.equal(f.launcher.isActive(f.profile.id), true);
  f.calls[0].child.emit('exit', 0, null);
  await until(() => !f.launcher.isActive(f.profile.id));
  assert.equal(f.launcher.isActive(f.profile.id), false);
});

test('lean windows fit the configured desktop while keeping separate profiles and proxies', async t => {
  const f = await fixture(t, { resourceMode: 'lean', desktopGeometry: '1024x768' });
  const other = await f.another();
  other.profile.proxy = 'socks5://127.0.0.1:18081';
  other.profile.environment.viewport = { width: 800, height: 600 };
  await f.launcher.open(f.options);
  await f.launcher.open(other);
  await f.launcher.open({ ...f.options, url: LINKS.gmail });
  assert.ok(f.calls[0].args.includes('--window-size=1024,768'));
  assert.ok(f.calls[1].args.includes('--window-size=800,600'));
  assert.ok(f.calls[2].args.includes('--window-size=1024,768'));
  assert.ok(f.calls[0].args.includes('--new-window'));
  assert.ok(!f.calls[2].args.includes('--new-window'));
  assert.ok(f.calls[0].args.includes(`--user-data-dir=${f.profileDir}`));
  assert.ok(f.calls[1].args.includes(`--user-data-dir=${other.profileDir}`));
  assert.ok(f.calls[0].args.includes('--proxy-server=socks5://127.0.0.1:18080'));
  assert.ok(f.calls[1].args.includes('--proxy-server=socks5://127.0.0.1:18081'));
  assert.ok(f.calls[2].args.includes('--proxy-server=socks5://127.0.0.1:18080'));
  assert.ok(f.calls.every(({ args }) => !args.some(arg => /no-sandbox|disable-site-isolation|remote-debugging/.test(arg))));
  assert.deepEqual(f.profile.environment.viewport, { width: 1365, height: 900 });
});

test('standard mode retains configured window size and lean mode rejects invalid geometry', async t => {
  const f = await fixture(t, { resourceMode: 'standard', desktopGeometry: '1024x768' });
  await f.launcher.open(f.options);
  assert.ok(f.calls[0].args.includes('--window-size=1365,900'));
  for (const desktopGeometry of ['1024x768;touch /tmp/unwanted', '1x1', '9999x9999', null]) {
    assert.throws(() => createRemoteLauncher({ resourceMode: 'lean', desktopGeometry }), /桌面尺寸/);
  }
});

test('primary startup exit reports failure and releases its desktop only after cleanup', async t => {
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
  await until(() => f.calls[0].child.signals.length > 0);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.equal((await pending).forced, true);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(f.calls[0].child.signalTimes[1] - f.calls[0].child.signalTimes[0] >= 25);
  assert.equal(f.launcher.isActive(f.profile.id), false);
});

test('closing during browser startup cancels the launch and preserves other environments', async t => {
  const f = await fixture(t, { startupDelay: 100 });
  const other = await f.another();
  await f.launcher.open(other);
  const request = f.launcher.open(f.options);
  const rejected = assert.rejects(request, /退出|取消|关闭/);
  await until(() => f.calls.length === 2);
  const result = await f.launcher.close(f.profile.id);
  await rejected;
  assert.equal(result.ok, true);
  assert.equal(f.launcher.isActive(f.profile.id), false);
  assert.equal(f.launcher.isActive(other.profile.id), true);
  assert.equal(f.calls[0].child.signals.length, 0);
});

test('unexpected desktop exit shuts down only its browser, and reopening changes its generation', async t => {
  const f = await fixture(t);
  await f.launcher.open(f.options);
  const previous = f.launcher.getDesktop(f.profile.id).generation;
  const other = await f.another();
  await f.launcher.open(other);
  f.desktopEntries.get(f.profile.id).resolveExit();
  await until(() => !f.launcher.isActive(f.profile.id));
  assert.equal(f.launcher.isActive(other.profile.id), true);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  await f.launcher.open(f.options);
  assert.notEqual(f.launcher.getDesktop(f.profile.id).generation, previous);
});

test('failed browser termination keeps its desktop and capacity reservation until a retry succeeds', async t => {
  const f = await fixture(t, { maxEnvironments: 1 });
  await f.launcher.open(f.options);
  f.calls[0].child.ignoreAll = true;
  assert.equal((await f.launcher.close(f.profile.id)).ok, false);
  assert.equal(f.launcher.isActive(f.profile.id), true);
  assert.ok(f.desktopEntries.has(f.profile.id));
  assert.equal(f.launcher.getDesktop(f.profile.id), null);
  await assert.rejects(f.launcher.open(await f.another()), /最多同时运行 1/);
  f.calls[0].child.ignoreAll = false;
  assert.equal((await f.launcher.close(f.profile.id)).ok, true);
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
