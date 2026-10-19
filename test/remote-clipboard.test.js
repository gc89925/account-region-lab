import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteClipboard } from '../lib/remote-clipboard.js';

const generation = 'a'.repeat(32);
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arl-clipboard-'));
  const runtimeRoot = path.join(root, 'desktops');
  await mkdir(runtimeRoot, { mode: 0o700 });
  const profiles = new Map();
  const calls = [];
  const selections = new Map();
  const control = { readWrong: false, readHang: false, writeFail: false, pasteFail: false };
  const resolveCalls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.signals = [];
    child.finished = false;
    const finish = code => {
      if (child.finished) return;
      child.finished = true;
      child.emit('exit', code);
      child.emit('close', code);
    };
    const call = { executable, args, options, child, input: Buffer.alloc(0) };
    calls.push(call);
    child.kill = signal => {
      child.signals.push(signal);
      if (selections.get(options.env.DISPLAY)?.child === child) selections.delete(options.env.DISPLAY);
      queueMicrotask(() => finish(null));
      return true;
    };
    if (executable === 'xclip' && args.includes('-in')) {
      child.stdin.on('data', chunk => { call.input = Buffer.concat([call.input, chunk]); });
      child.stdin.once('finish', () => {
        if (control.writeFail) queueMicrotask(() => child.emit('error', new Error('SECRET stderr failure')));
        else selections.set(options.env.DISPLAY, { data: call.input, child });
      });
    } else if (executable === 'xclip') {
      queueMicrotask(() => {
        if (control.readHang) return;
        const selection = selections.get(options.env.DISPLAY);
        child.stdout.write(control.readWrong ? 'wrong value SECRET' : (selection?.data || ''));
        finish(selection ? 0 : 1);
      });
    } else {
      queueMicrotask(() => finish(control.pasteFail ? 1 : 0));
    }
    return child;
  };
  const clipboard = createRemoteClipboard({ runtimeRoot, spawnProcess, operationTimeout: 250, readTimeout: 40, pollInterval: 2, stopTimeout: 5,
    resolveDesktop: async request => {
      resolveCalls.push(request);
      return profiles.get(request.profileId)?.generation === request.generation ? profiles.get(request.profileId).port : null;
    }, ...overrides });
  const add = async (port = 6101, profileId = randomUUID(), epoch = generation) => {
    const directory = path.join(runtimeRoot, `${profileId}-${epoch}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, 'Xauthority'), 'cookie-placeholder', { mode: 0o600 });
    profiles.set(profileId, { generation: epoch, port });
    return { profileId, generation: epoch, directory };
  };
  t.after(async () => { await clipboard.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtimeRoot, clipboard, profiles, calls, control, selections, resolveCalls, add };
}

test('Unicode text travels only through stdin and exact UTF8 selection readback is verified', async t => {
  const f = await fixture(t);
  const profile = await f.add();
  const text = '你好，India 🌏\nsecond line & $(never-run)';
  assert.deepEqual(await f.clipboard.send({ ...profile, text }), { ok: true, pasted: false, persistenceSeconds: 120 });
  const writer = f.calls.find(call => call.args.includes('-in'));
  assert.equal(writer.input.toString('utf8'), text);
  assert.deepEqual(writer.args, ['-selection', 'clipboard', '-in', '-target', 'UTF8_STRING', '-quiet']);
  assert.equal(writer.options.shell, false);
  assert.deepEqual(writer.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(writer.options.env.LC_ALL, 'C.UTF-8');
  assert.equal(f.calls.some(call => JSON.stringify([call.args, call.options]).includes(text)), false);
  assert.equal(f.calls.some(call => call.executable === 'xdotool'), false);
  assert.equal(f.resolveCalls.length, 3);
});

test('separate environments use distinct authority files and displays, with explicit paste only', async t => {
  const f = await fixture(t);
  const a = await f.add(6101), b = await f.add(6105);
  await Promise.all([f.clipboard.send({ ...a, text: 'first' }), f.clipboard.send({ ...b, text: '第二个', paste: true })]);
  const writers = f.calls.filter(call => call.args.includes('-in'));
  assert.deepEqual(writers.map(call => call.options.env.DISPLAY).sort(), [':200', ':204']);
  assert.equal(new Set(writers.map(call => call.options.env.XAUTHORITY)).size, 2);
  const paste = f.calls.find(call => call.executable === 'xdotool');
  assert.deepEqual(paste.args, ['key', '--clearmodifiers', 'ctrl+v']);
  assert.equal(paste.options.env.DISPLAY, ':204');
  assert.equal(f.selections.get(':200').data.toString(), 'first');
  assert.equal(f.selections.get(':204').data.toString(), '第二个');
});

test('stale generation and port changes are rejected before any writer starts', async t => {
  let count = 0;
  const f = await fixture(t, { resolveDesktop: async () => ++count === 1 ? 6101 : 6102 });
  const profile = await f.add();
  await assert.rejects(f.clipboard.send({ ...profile, text: 'secret' }), { code: 'DESKTOP_STALE', status: 409 });
  assert.equal(f.calls.length, 0);
  const normal = await fixture(t);
  const p = await normal.add();
  await assert.rejects(normal.clipboard.send({ ...p, generation: 'b'.repeat(32), text: 'secret' }), { code: 'DESKTOP_STALE' });
  assert.equal(normal.calls.length, 0);
});

test('generation becoming stale after write is never pasted and writer is stopped', async t => {
  let count = 0;
  const f = await fixture(t, { resolveDesktop: async () => ++count < 3 ? 6101 : null });
  const profile = await f.add();
  await assert.rejects(f.clipboard.send({ ...profile, text: 'draft', paste: true }), { code: 'DESKTOP_STALE' });
  assert.equal(f.calls.some(call => call.executable === 'xdotool'), false);
  assert.deepEqual(f.calls.find(call => call.args.includes('-in')).child.signals, ['SIGTERM']);
});

test('session expiry before or during verification prevents paste and releases the selection', async t => {
  const f = await fixture(t);
  const profile = await f.add();
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private', isAuthorized: () => false }), { code: 'CLIPBOARD_UNAUTHORIZED', status: 401 });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private', paste: true,
    isAuthorized: () => !f.calls.some(call => call.args.includes('-out')),
  }), { code: 'CLIPBOARD_UNAUTHORIZED', status: 401 });
  assert.equal(f.calls.some(call => call.executable === 'xdotool'), false);
  assert.deepEqual(f.calls.find(call => call.args.includes('-in')).child.signals, ['SIGTERM']);
});

test('replacement stops the previous owner and keeps another profile untouched', async t => {
  const f = await fixture(t);
  const a = await f.add(), b = await f.add(6102);
  await f.clipboard.send({ ...a, text: 'old' });
  await f.clipboard.send({ ...b, text: 'other' });
  const first = f.calls.find(call => call.args.includes('-in'));
  await f.clipboard.send({ ...a, text: 'new' });
  assert.deepEqual(first.child.signals, ['SIGTERM']);
  assert.equal(f.selections.get(':200').data.toString(), 'new');
  assert.equal(f.selections.get(':201').data.toString(), 'other');
});

test('overlapping sends for one profile are rejected rather than queued for a later focus', async t => {
  const f = await fixture(t);
  const profile = await f.add();
  const pending = f.clipboard.send({ ...profile, text: 'one' });
  await assert.rejects(f.clipboard.send({ ...profile, text: 'two', paste: true }), { code: 'CLIPBOARD_BUSY', status: 409 });
  await pending;
  assert.equal(f.calls.filter(call => call.args.includes('-in')).length, 1);
});

test('write errors and readback mismatches never leak content or invoke paste', async t => {
  const f = await fixture(t, { operationTimeout: 40, readTimeout: 10 });
  const profile = await f.add();
  f.control.readWrong = true;
  await assert.rejects(f.clipboard.send({ ...profile, text: 'SECRET user text', paste: true }), error => error.code === 'CLIPBOARD_TIMEOUT' && !error.message.includes('SECRET'));
  f.control.readWrong = false;
  f.control.writeFail = true;
  await assert.rejects(f.clipboard.send({ ...profile, text: 'SECRET user text', paste: true }), error => error.code === 'CLIPBOARD_UNAVAILABLE' && !error.message.includes('SECRET'));
  assert.equal(f.calls.some(call => call.executable === 'xdotool'), false);
});

test('failed paste reports failure and releases the owner without extra keys', async t => {
  const f = await fixture(t);
  const profile = await f.add();
  f.control.pasteFail = true;
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private', paste: true }), { code: 'CLIPBOARD_UNAVAILABLE' });
  assert.equal(f.calls.filter(call => call.executable === 'xdotool').length, 1);
  assert.equal(f.selections.size, 0);
});

test('hangs are bounded and close cancels in-flight readers plus selection owners', async t => {
  const f = await fixture(t, { operationTimeout: 1000 });
  const profile = await f.add();
  f.control.readHang = true;
  const pending = f.clipboard.send({ ...profile, text: 'waiting' });
  const rejection = assert.rejects(pending, { code: 'CLIPBOARD_CLOSED' });
  await until(() => f.calls.length === 2);
  await f.clipboard.close();
  await rejection;
  assert.ok(f.calls.every(call => call.child.finished));
  await assert.rejects(f.clipboard.send({ ...profile, text: 'later' }), { code: 'CLIPBOARD_CLOSED' });
});

test('shutdown also cancels a pending desktop resolution without creating a child', async t => {
  const f = await fixture(t, { resolveDesktop: () => new Promise(() => {}) });
  const profile = await f.add();
  const pending = f.clipboard.send({ ...profile, text: 'waiting' });
  const rejection = assert.rejects(pending);
  await f.clipboard.close();
  await rejection;
  assert.equal(f.calls.length, 0);
});

test('selection owner expires and five-owner capacity cannot be exceeded', async t => {
  const f = await fixture(t, { persistenceSeconds: 0.05 });
  const profile = await f.add();
  await f.clipboard.send({ ...profile, text: 'temporary' });
  await until(() => f.calls[0].child.finished);
  assert.equal(f.selections.size, 0);
  const capacity = await fixture(t);
  for (let n = 0; n < 5; n++) {
    const p = await capacity.add(6101 + n);
    await capacity.clipboard.send({ ...p, text: String(n) });
  }
  const extra = await capacity.add(6101);
  await assert.rejects(capacity.clipboard.send({ ...extra, text: 'extra' }), { code: 'CLIPBOARD_BUSY', status: 429 });
  assert.equal(capacity.calls.filter(call => call.args.includes('-in')).length, 5);
});

test('types, path identifiers, NUL and UTF8 byte limits are checked before resolving', async t => {
  const f = await fixture(t);
  const profile = await f.add();
  for (const change of [{ profileId: '../other' }, { generation: '../other' }, { text: '' }, { text: 42 }, { text: 'a\0b' },
    { text: '中'.repeat(4097) }, { text: '\ud800' }, { paste: 'true' }]) {
    await assert.rejects(f.clipboard.send({ ...profile, text: 'valid', ...change }), { code: 'CLIPBOARD_INVALID', status: 400 });
  }
  assert.equal(f.resolveCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test('unsafe permissions and symlink authority paths are rejected', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const profile = await f.add();
  const auth = path.join(profile.directory, 'Xauthority');
  await chmod(f.runtimeRoot, 0o755);
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private' }), { code: 'CLIPBOARD_UNAVAILABLE' });
  await chmod(f.runtimeRoot, 0o700);
  await chmod(profile.directory, 0o750);
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private' }), { code: 'CLIPBOARD_UNAVAILABLE' });
  await chmod(profile.directory, 0o700);
  await chmod(auth, 0o644);
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private' }), { code: 'CLIPBOARD_UNAVAILABLE' });
  await rm(auth);
  await writeFile(path.join(f.root, 'auth'), 'cookie', { mode: 0o600 });
  await symlink(path.join(f.root, 'auth'), auth);
  await assert.rejects(f.clipboard.send({ ...profile, text: 'private' }), { code: 'CLIPBOARD_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('symlinks in intermediate runtime paths are rejected', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const profile = await f.add();
  const linked = path.join(f.root, 'linked');
  await symlink(f.root, linked);
  const clipboard = createRemoteClipboard({ runtimeRoot: path.join(linked, 'desktops'), resolveDesktop: async () => 6101,
    spawnProcess: () => { throw new Error('Must never spawn'); } });
  t.after(() => clipboard.close());
  await assert.rejects(clipboard.send({ ...profile, text: 'private' }), { code: 'CLIPBOARD_UNAVAILABLE' });
});
