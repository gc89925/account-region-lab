import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopManager, trackOwnedProcess, stopOwnedProcess } from '../lib/remote-desktop.js';

async function until(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arl-desktops-'));
  const runtimeRoot = path.join(root, 'desktops');
  const calls = [];
  const control = { ready: true };
  const launch = (executable, args, options) => {
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    child.stdout = new PassThrough();
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      if (!child.ignoreAll) queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    calls.push({ executable, args, options, child });
    if (control.ready) queueMicrotask(() => child.stdout.write('REGION_LAB_DESKTOP_READY\n'));
    return child;
  };
  // Normal cases exercise readiness semantics, not scheduler speed on a busy
  // host. The timeout-specific case below still supplies its own short limit.
  const desktops = createDesktopManager({ launch, runtimeRoot, readyTimeout: 3000, closeTimeout: 15, killTimeout: 15, ...overrides });
  t.after(async () => {
    calls.forEach(({ child }) => { child.ignoreAll = false; });
    await desktops.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtimeRoot, calls, control, desktops };
}

test('five desktops allocate disjoint private directories, displays and loopback ports', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 5 }, randomUUID);
  const runtimes = await Promise.all(ids.map(id => f.desktops.open(id)));
  assert.deepEqual(runtimes.map(runtime => runtime.port).sort(), [6101, 6102, 6103, 6104, 6105]);
  assert.equal(new Set(runtimes.map(runtime => runtime.env.DISPLAY)).size, 5);
  const desktopPorts = new Set(runtimes.map(runtime => runtime.port));
  assert.ok(runtimes.every(runtime => !desktopPorts.has(6000 + Number(runtime.env.DISPLAY.slice(1)))), 'X11 TCP fallback must not reach a noVNC HTTP listener');
  assert.deepEqual(runtimes.map(runtime => runtime.env.DISPLAY).sort(), [':200', ':201', ':202', ':203', ':204']);
  assert.equal(new Set(runtimes.map(runtime => runtime.env.XAUTHORITY)).size, 5);
  assert.ok(runtimes.every(runtime => /^[a-f0-9]{32}$/.test(runtime.generation)));
  assert.ok(f.calls.every(call => call.options.env.NOTIFY_SOCKET === undefined));
  assert.ok(f.calls.every(call => call.options.env.RUNTIME_DIRECTORY === undefined));
  assert.deepEqual(f.calls.map(call => Number(call.options.env.REGION_LAB_VNC_PORT)).sort(), [5902, 5903, 5904, 5905, 5906]);
  assert.ok(f.calls.every(call => call.options.shell === false));
  await assert.rejects(f.desktops.open(randomUUID()), /最多同时运行 5/);
  await f.desktops.close(ids[0]);
  assert.ok(f.desktops.get(ids[1]));
  assert.equal(f.calls.find(call => call.options.env.XAUTHORITY === runtimes[1].env.XAUTHORITY).child.signals.length, 0);
  const reopened = await f.desktops.open(ids[0]);
  assert.equal(reopened.port, runtimes[0].port);
  assert.notEqual(reopened.generation, runtimes[0].generation);
  assert.notEqual(reopened.env.XAUTHORITY, runtimes[0].env.XAUTHORITY);
});

test('starting desktops reserve capacity and only become routable after the exact readiness marker', async t => {
  const f = await fixture(t, { maxEnvironments: 1, readyTimeout: 1000 });
  f.control.ready = false;
  const id = randomUUID();
  const pending = f.desktops.open(id);
  await until(() => f.calls.length === 1);
  assert.equal(f.desktops.get(id), null);
  await assert.rejects(f.desktops.open(randomUUID()), /最多同时运行 1/);
  f.calls[0].child.stdout.write('arbitrary text REGION_LAB_DESKTOP_READY\n');
  assert.equal(f.desktops.get(id), null);
  f.calls[0].child.stdout.write('REGION_LAB_DESKTOP_');
  f.calls[0].child.stdout.write('READY\n');
  const runtime = await pending;
  assert.equal(f.desktops.get(id), runtime);
});

test('desktop launcher inherits the configured backend without changing isolation or readiness', async t => {
  const names = ['REGION_LAB_DESKTOP_BACKEND', 'REGION_LAB_DESKTOP_FRAME_RATE'];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  }));
  process.env.REGION_LAB_DESKTOP_BACKEND = 'tigervnc';
  process.env.REGION_LAB_DESKTOP_FRAME_RATE = '12';
  const f = await fixture(t);
  const runtime = await f.desktops.open(randomUUID());
  assert.equal(f.calls[0].options.env.REGION_LAB_DESKTOP_BACKEND, 'tigervnc');
  assert.equal(f.calls[0].options.env.REGION_LAB_DESKTOP_FRAME_RATE, '12');
  assert.equal(f.calls[0].options.env.XAUTHORITY, runtime.env.XAUTHORITY);
  assert.equal(f.calls[0].options.env.REGION_LAB_VNC_PORT, '5902');
});

test('closing during startup cancels readiness and cleans the owned runtime directory', async t => {
  const f = await fixture(t);
  f.control.ready = false;
  const id = randomUUID();
  const pending = f.desktops.open(id);
  const rejected = assert.rejects(pending, /取消/);
  await until(() => f.calls.length === 1);
  assert.equal((await f.desktops.close(id)).ok, true);
  await rejected;
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.deepEqual(await readdir(f.runtimeRoot), []);
  f.control.ready = true;
  assert.ok(await f.desktops.open(id));
});

test('startup timeout stops the process and frees the slot for a new generation', async t => {
  const f = await fixture(t, { maxEnvironments: 1, readyTimeout: 20 });
  f.control.ready = false;
  await assert.rejects(f.desktops.open(randomUUID()), /超时/);
  assert.deepEqual(f.calls[0].child.signals, ['SIGTERM']);
  assert.deepEqual(await readdir(f.runtimeRoot), []);
  f.control.ready = true;
  assert.equal((await f.desktops.open(randomUUID())).port, 6101);
});

test('unexpected desktop exit invalidates its runtime and keeps another desktop available', async t => {
  const f = await fixture(t);
  const first = randomUUID(), second = randomUUID();
  const [runtime, other] = await Promise.all([f.desktops.open(first), f.desktops.open(second)]);
  // Concurrent filesystem setup does not promise spawn order. Select the owned
  // child by its authority path so this tests the intended environment.
  f.calls.find(call => call.options.env.XAUTHORITY === runtime.env.XAUTHORITY).child.emit('exit', 1, null);
  await runtime.exited;
  await until(() => f.desktops.get(first) === null);
  assert.ok(f.desktops.get(second));
  assert.equal(f.calls.find(call => call.options.env.XAUTHORITY === other.env.XAUTHORITY).child.signals.length, 0);
});

test('a process that refuses termination keeps its slot reserved and cannot be routed', async t => {
  const f = await fixture(t, { maxEnvironments: 1 });
  const id = randomUUID();
  await f.desktops.open(id);
  f.calls[0].child.ignoreAll = true;
  assert.equal((await f.desktops.close(id)).ok, false);
  assert.equal(f.desktops.get(id), null);
  await assert.rejects(f.desktops.open(randomUUID()), /最多同时运行 1/);
  f.calls[0].child.ignoreAll = false;
  assert.equal((await f.desktops.close(id)).ok, true);
  assert.equal((await f.desktops.open(randomUUID())).port, 6101);
});

test('invalid identifiers and shutdown never allocate desktops', async t => {
  const f = await fixture(t);
  await assert.rejects(f.desktops.open('../not-an-environment'), /UUID/);
  assert.equal(f.calls.length, 0);
  await f.desktops.closeAll();
  await assert.rejects(f.desktops.open(randomUUID()), /停止/);
});

test('closing before filesystem preparation finishes never spawns a desktop', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const pending = f.desktops.open(id);
  const rejected = assert.rejects(pending, /取消/);
  const closing = f.desktops.close(id);
  await rejected;
  assert.equal((await closing).ok, true);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.runtimeRoot), []);
});

test('Linux process group cleanup stops an unresponsive parent and descendant before release', { skip: process.platform !== 'linux' }, async t => {
  const code = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {});
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const owned = trackOwnedProcess(child, true);
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const descendant = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Process tree startup timed out')), 5000);
    child.once('error', reject);
    child.stdout.once('data', chunk => { clearTimeout(timeout); resolve(Number(chunk.toString().trim())); });
  });
  assert.ok(descendant > 0);
  assert.equal(owned.alive(), true);
  const result = await stopOwnedProcess(owned, 50, 1500);
  assert.deepEqual(result, { ok: true, forced: true });
  assert.equal(owned.alive(), false);
});

// Exercise the real shell launcher without an installed desktop or external
// sockets. Components record argv and stay alive until the launcher's cleanup.
// Actual rendering and performance require the separate real-browser benchmark.
const skipLauncher = process.platform !== 'linux' || process.getuid?.() === 0;
async function launcherFixture(t, { backend, frameRate } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arl-desktop-shell-'));
  const bin = path.join(root, 'bin'), runtime = path.join(root, 'runtime'), logs = path.join(root, 'logs');
  await Promise.all([bin, runtime, logs].map(directory => mkdir(directory, { mode: 0o700 })));
  const component = path.join(bin, 'component');
  await writeFile(component, `#!/bin/bash
set -eu
name="\${0##*/}"
printf '%s\\0' "$$" "$@" > "$ARL_TEST_LOG/$name"
case "$name" in
  xauth) cat >/dev/null; exit 0 ;;
  mcookie) printf '%s\\n' 0123456789abcdef0123456789abcdef; exit 0 ;;
  xdpyinfo|curl|python3) exit 0 ;;
esac
trap 'exit 0' TERM INT
while true; do sleep 0.1 & wait "$!" || true; done
`);
  await chmod(component, 0o700);
  const binaries = ['Xvfb', 'Xtigervnc', 'x11vnc', 'openbox', 'websockify', 'xauth', 'mcookie', 'xdpyinfo', 'curl', 'python3'];
  await Promise.all(binaries.map(binary => symlink(component, path.join(bin, binary))));
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`,
    REGION_LAB_DISPLAY: ':200', REGION_LAB_VNC_PORT: '5902', REGION_LAB_DESKTOP_PORT: '6101',
    XDG_RUNTIME_DIR: runtime, XAUTHORITY: path.join(runtime, 'Xauthority'),
    ARL_TEST_LOG: logs };
  delete env.REGION_LAB_DESKTOP_BACKEND;
  delete env.REGION_LAB_DESKTOP_FRAME_RATE;
  if (backend !== undefined) env.REGION_LAB_DESKTOP_BACKEND = backend;
  if (frameRate !== undefined) env.REGION_LAB_DESKTOP_FRAME_RATE = frameRate;
  const script = fileURLToPath(new URL('../deploy/linux/start-desktop.sh', import.meta.url));
  const child = spawn('/bin/bash', [script], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const owned = trackOwnedProcess(child, true);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    await stopOwnedProcess(owned, 7000, 2000);
    await rm(root, { recursive: true, force: true });
  });
  return { child, owned, exited, logs, runtime,
    output: () => ({ stdout, stderr }),
    args: async name => (await readFile(path.join(logs, name), 'utf8')).split('\0').slice(1, -1),
    ready: async () => {
      const deadline = Date.now() + 10000;
      while (!stdout.split(/\r?\n/).includes('REGION_LAB_DESKTOP_READY')) {
        if (!owned.alive() || Date.now() > deadline) throw new Error(`Desktop test did not become ready: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
  };
}

test('Linux launcher defaults to the unchanged x11vnc stack and cleans its process group', { skip: skipLauncher }, async t => {
  const f = await launcherFixture(t);
  await f.ready();
  assert.deepEqual(await f.args('Xvfb'), [':200', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', path.join(f.runtime, 'Xauthority'), '-noreset']);
  assert.deepEqual(await f.args('x11vnc'), ['-display', ':200', '-auth', path.join(f.runtime, 'Xauthority'), '-listen', '127.0.0.1', '-rfbport', '5902', '-localhost', '-forever', '-shared', '-nopw', '-noxdamage', '-repeat', '-wait', '50', '-defer', '50']);
  assert.ok(!(await readdir(f.logs)).includes('Xtigervnc'));
  assert.equal((await stopOwnedProcess(f.owned, 7000, 2000)).ok, true);
  assert.equal(f.owned.alive(), false);
});

test('Linux TigerVNC launcher keeps private X auth, loopback RFB and the same readiness contract', { skip: skipLauncher }, async t => {
  const f = await launcherFixture(t, { backend: 'tigervnc' });
  await f.ready();
  assert.deepEqual(await f.args('Xtigervnc'), [':200', '-geometry', '1280x800', '-depth', '24', '-nolisten', 'tcp', '-auth', path.join(f.runtime, 'Xauthority'), '-noreset', '-localhost', '-interface', '127.0.0.1', '-UseIPv6=0', '-rfbport', '5902', '-SecurityTypes', 'None', '-AlwaysShared', '-FrameRate', '20', '-CompareFB', '2']);
  assert.deepEqual(await f.args('websockify'), ['--web', '/usr/share/novnc', '127.0.0.1:6101', '127.0.0.1:5902']);
  assert.deepEqual(await f.args('openbox'), ['--sm-disable']);
  const names = await readdir(f.logs);
  assert.ok(!names.includes('Xvfb') && !names.includes('x11vnc'));
  assert.equal((await stopOwnedProcess(f.owned, 7000, 2000)).ok, true);
  assert.equal(f.owned.alive(), false);
});

test('Linux launcher accepts bounded TigerVNC frame rates', { skip: skipLauncher }, async t => {
  for (const frameRate of ['5', '30']) await t.test(frameRate, async t => {
    const f = await launcherFixture(t, { backend: 'tigervnc', frameRate });
    await f.ready();
    const args = await f.args('Xtigervnc');
    assert.equal(args[args.indexOf('-FrameRate') + 1], frameRate);
  });
});

test('Linux launcher rejects unknown backends and invalid frame rates before starting components', { skip: skipLauncher }, async t => {
  for (const config of [{ backend: '' }, { backend: 'other' }, ...['', '4', '31', '1.5', '05', '20;true'].map(frameRate => ({ backend: 'tigervnc', frameRate }))]) {
    await t.test(JSON.stringify(config), async t => {
      const f = await launcherFixture(t, config);
      assert.equal((await f.exited).code, 1);
      assert.deepEqual(await readdir(f.logs), []);
      assert.ok(!f.output().stdout.includes('REGION_LAB_DESKTOP_READY'));
      assert.match(f.output().stderr, /must be/);
    });
  }
});

test('Linux desktop component failure exits and cleans the remaining owned processes', { skip: skipLauncher }, async t => {
  const f = await launcherFixture(t, { backend: 'tigervnc' });
  await f.ready();
  const pid = Number((await readFile(path.join(f.logs, 'Xtigervnc'), 'utf8')).split('\0')[0]);
  process.kill(pid, 'SIGTERM');
  assert.equal((await f.exited).code, 1);
  assert.match(f.output().stderr, /desktop component stopped/i);
  await until(() => !f.owned.alive());
});
