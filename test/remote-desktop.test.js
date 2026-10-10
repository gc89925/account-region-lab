import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  const desktops = createDesktopManager({ launch, runtimeRoot, readyTimeout: 100, closeTimeout: 15, killTimeout: 15, ...overrides });
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

test('desktop launcher rejects malformed display settings before starting processes', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'arl-desktop-settings-'));
  const marker = path.join(root, 'must-not-exist');
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../deploy/linux/start-desktop.sh', import.meta.url));
  const run = promisify(execFile);
  for (const geometry of ['800x600', '1921x1200', '1024x1201', '01024x768', '1024x768 -listen tcp', `1024x768; touch ${marker}`, `$(touch ${marker})`]) {
    await assert.rejects(run('/bin/bash', [script], {
      env: { ...process.env, REGION_LAB_DESKTOP_GEOMETRY: geometry, REGION_LAB_X11VNC_DAMAGE: '1' }, timeout: 3000,
    }), error => error.code === 1 && /Invalid desktop geometry/.test(error.stderr));
  }
  await assert.rejects(run('/bin/bash', [script], {
    env: { ...process.env, REGION_LAB_DESKTOP_GEOMETRY: '1024x768', REGION_LAB_X11VNC_DAMAGE: `1; touch ${marker}` }, timeout: 3000,
  }), error => error.code === 1 && /must be 0 or 1/.test(error.stderr));
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
