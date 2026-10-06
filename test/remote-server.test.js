import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import http from 'node:http';
import { createLabServer } from '../server.js';

const PUBLIC_ORIGIN = 'https://example.test';
const TARGET_PROXY = 'socks5://proxy.example.test:1080';
const BRIDGE_PROXY = 'socks5://127.0.0.1:49125';
const TEST_AUTH = { username: 'remote-test-proxy-user', password: 'remote-test-password' };

// Exercise the HTTP API and persisted state without real credentials, external
// networks, a display server, or a browser process.
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'arl-remote-server-'));
  const active = new Set();
  const envelopes = new Map();
  const calls = { remote: [], remoteClose: [], remoteCloseAll: 0, native: [], managed: [], probes: [], destinations: [], bridges: [] };
  const control = {
    probe: { ip: '203.0.113.42', country: 'IN' },
    destination: { ok: true, httpStatus: 200, latencyMs: 1 },
  };
  const lab = createLabServer({
    dataDir,
    remoteMode: true,
    publicOrigin: PUBLIC_ORIGIN,
    browser: { name: 'Test remote browser', path: '/test/chromium' },
    remote: {
      isActive: id => active.has(id),
      async open(options) {
        calls.remote.push(structuredClone(options));
        if (control.openError) throw control.openError;
        active.add(options.profile.id);
        return { ok: true, active: true, pid: 1234 };
      },
      async close(id) { calls.remoteClose.push(id); active.delete(id); return { ok: true }; },
      async closeAll() { calls.remoteCloseAll++; active.clear(); },
    },
    managed: {
      isActive: () => false,
      async open(options) { calls.managed.push(options); return { ok: true }; },
      async close() { throw new Error('Remote mode must not close through the managed launcher'); },
      async closeAll() {},
    },
    async launch(...args) { calls.native.push(args); return { pid: 4321 }; },
    async probe(proxy) {
      calls.probes.push(proxy);
      if (control.probe instanceof Error) throw control.probe;
      return { ...control.probe };
    },
    async destinationProbe(proxy, url) { calls.destinations.push({ proxy, url }); return { ...control.destination }; },
    vault: {
      async seal(auth) {
        const envelope = { format: 'test-vault-v1', data: `remote-opaque-${envelopes.size + 1}` };
        envelopes.set(envelope.data, { ...auth });
        return envelope;
      },
      async open(envelope) { assert.ok(envelopes.has(envelope.data)); return { ...envelopes.get(envelope.data) }; },
    },
    async createBridge(proxy, auth) {
      const bridge = { proxy: BRIDGE_PROXY, closed: false, async close() { this.closed = true; } };
      calls.bridges.push({ proxy, auth: { ...auth }, bridge });
      return bridge;
    },
    ...overrides,
  });
  lab.server.listen(0, '127.0.0.1');
  await once(lab.server, 'listening');
  const origin = `http://127.0.0.1:${lab.server.address().port}`;
  t.after(async () => { await lab.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, headers = {} } = {}) {
    // Raw HTTP preserves explicit Host and Sec-Fetch-Site values; fetch may
    // overwrite these headers, which would invalidate the origin guard tests.
    const response = await new Promise((resolve, reject) => {
      const request = http.request(origin + route, {
        method,
        headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Lab-Token': lab.token }), ...headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers), raw: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    let value;
    try { value = JSON.parse(response.raw); } catch { value = response.raw; }
    return { ...response, value };
  }
  async function state() {
    const result = await request('/api/state');
    assert.equal(result.status, 200, result.raw);
    return result.value;
  }
  async function create(overrides = {}) {
    const result = await request('/api/profiles', { method: 'POST', body: {
      label: 'Remote test environment', country: 'IN', proxy: TARGET_PROXY, ...overrides,
    } });
    assert.equal(result.status, 201, result.raw);
    return result.value;
  }
  const post = (route, body = {}) => request(route, { method: 'POST', body });
  return { dataDir, origin, calls, control, active, request, post, state, create, close: () => lab.close() };
}

test('remote snapshot advertises its same-origin desktop and native sessions are managed by the server', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const snapshot = await app.state();
  assert.equal(snapshot.capabilities.remoteBrowser, true);
  assert.equal(snapshot.capabilities.managed, false);
  assert.equal(snapshot.remoteDesktopUrl, '/desktop/vnc.html?autoconnect=true&resize=scale&path=desktop/websockify');
  assert.equal(snapshot.profiles.find(p => p.id === profile.id).environment.engine, 'native');
  assert.deepEqual(snapshot.profiles.find(p => p.id === profile.id).session, { active: false, managed: true });
  const page = await app.request('/');
  assert.match(page.headers.get('content-security-policy'), /frame-src 'self'/);
});

test('remote launches use the remote launcher for both engines and reuse the same account directory for more tabs', async t => {
  const app = await fixture(t);
  const native = await app.create({ label: 'Native remote' });
  const route = `/api/profiles/${native.id}`;
  for (const target of ['signin', 'gmail', 'youtube']) {
    const opened = await app.post(route + '/launch', { target });
    assert.equal(opened.status, 200, opened.raw);
    assert.match(opened.value.message, /服务器打开浏览器/);
    assert.equal(opened.value.profile.session.active, true);
    assert.equal(opened.value.profile.session.managed, true);
  }
  assert.deepEqual(app.calls.remote.map(call => call.url), ['https://accounts.google.com/', 'https://mail.google.com/', 'https://www.youtube.com/']);
  assert.equal(new Set(app.calls.remote.map(call => call.profileDir)).size, 1);
  assert.equal(app.calls.remote[0].profileDir, path.join(app.dataDir, 'profiles', native.id));
  assert.ok(app.calls.remote.every(call => call.profile.proxy === TARGET_PROXY && call.browserPath === '/test/chromium'));
  const beforeClose = (await app.state()).profiles.find(p => p.id === native.id);
  const closed = await app.post(route + '/close');
  assert.equal(closed.status, 200, closed.raw);
  assert.deepEqual(app.calls.remoteClose, [native.id]);
  const afterClose = (await app.state()).profiles.find(p => p.id === native.id);
  assert.equal(afterClose.session.active, false);
  assert.deepEqual(afterClose.launches, beforeClose.launches);
  assert.equal(afterClose.expectedIp, beforeClose.expectedIp);

  const managed = await app.create({ label: 'Remote overrides managed engine', environment: { engine: 'managed' } });
  assert.equal((await app.post(`/api/profiles/${managed.id}/launch`, { target: 'signin' })).status, 200);
  assert.equal(app.calls.remote.at(-1).profile.id, managed.id);
  assert.notEqual(app.calls.remote.at(-1).profileDir, app.calls.remote[0].profileDir);
  assert.equal(app.calls.native.length, 0);
  assert.equal(app.calls.managed.length, 0);
  await app.close();
  assert.equal(app.calls.remoteCloseAll, 1);
  assert.equal(app.active.size, 0);
});

test('a running remote environment blocks a different account before probing and allows switching after close', async t => {
  const app = await fixture(t);
  const first = await app.create({ label: 'First account', accountLabel: 'first' });
  const second = await app.create({ label: 'Second account', accountLabel: 'second' });
  assert.equal((await app.post(`/api/profiles/${first.id}/launch`, { target: 'signin' })).status, 200);
  const probeCount = app.calls.probes.length;
  const blocked = await app.post(`/api/profiles/${second.id}/launch`, { target: 'gmail' });
  assert.equal(blocked.status, 400, blocked.raw);
  assert.match(blocked.value.error, /一次运行一个账号浏览器/);
  assert.equal(app.calls.probes.length, probeCount);
  assert.equal(app.calls.remote.length, 1);
  assert.deepEqual((await app.state()).profiles.find(p => p.id === second.id).launches, []);
  assert.equal((await app.post(`/api/profiles/${first.id}/close`)).status, 200);
  assert.equal((await app.post(`/api/profiles/${second.id}/launch`, { target: 'signin' })).status, 200);
  assert.deepEqual([...app.active], [second.id]);
});

test('an in-flight launch prevents another remote account from racing into the shared desktop', async t => {
  let releaseProbe;
  let reachedProbe;
  const reached = new Promise(resolve => { reachedProbe = resolve; });
  const app = await fixture(t, { probe: async () => {
    reachedProbe();
    await new Promise(resolve => { releaseProbe = resolve; });
    return { ip: '203.0.113.42', country: 'IN' };
  } });
  const first = await app.create({ label: 'Pending account' });
  const second = await app.create({ label: 'Competing account' });
  const pending = app.post(`/api/profiles/${first.id}/launch`, { target: 'signin' });
  await reached;
  let blocked;
  try { blocked = await app.post(`/api/profiles/${second.id}/launch`, { target: 'signin' }); }
  finally { releaseProbe(); }
  assert.equal((await pending).status, 200);
  assert.equal(blocked.status, 400, blocked.raw);
  assert.equal(app.calls.remote.length, 1);
  assert.equal(app.calls.remote[0].profile.id, first.id);
});

test('authenticated remote launches share the bridge with both probes and strip secrets from browser input and API output', async t => {
  const app = await fixture(t);
  const profile = await app.create({ proxyUsername: TEST_AUTH.username, proxyPassword: TEST_AUTH.password });
  const check = await app.post(`/api/profiles/${profile.id}/check`);
  assert.equal(check.status, 200, check.raw);
  assert.equal(check.value.ok, true);
  const opened = await app.post(`/api/profiles/${profile.id}/launch`, { target: 'youtube' });
  assert.equal(opened.status, 200, opened.raw);
  assert.equal(app.calls.bridges.length, 1);
  assert.equal(app.calls.bridges[0].proxy, TARGET_PROXY);
  assert.deepEqual(app.calls.bridges[0].auth, TEST_AUTH);
  assert.deepEqual(app.calls.probes, [BRIDGE_PROXY, BRIDGE_PROXY]);
  assert.deepEqual(app.calls.destinations, [
    { proxy: BRIDGE_PROXY, url: 'https://accounts.google.com/' },
    { proxy: BRIDGE_PROXY, url: 'https://www.youtube.com/' },
  ]);
  assert.equal(app.calls.remote[0].profile.proxy, BRIDGE_PROXY);
  const browserInput = JSON.stringify(app.calls.remote);
  for (const secret of [TEST_AUTH.username, TEST_AUTH.password, TARGET_PROXY, 'remote-opaque-1']) assert.ok(!browserInput.includes(secret));
  assert.equal(Object.hasOwn(app.calls.remote[0].profile, 'proxyAuth'), false);
  assert.equal(Object.hasOwn(app.calls.remote[0].profile, 'proxyUsername'), false);
  const snapshot = await app.request('/api/state');
  const exported = await app.request('/api/export');
  const disk = await readFile(path.join(app.dataDir, 'state.json'), 'utf8');
  for (const raw of [opened.raw, snapshot.raw, exported.raw, disk]) assert.ok(!raw.includes(TEST_AUTH.password));
  for (const raw of [opened.raw, snapshot.raw, exported.raw]) assert.ok(!raw.includes('remote-opaque-1'));
  assert.ok(!exported.raw.includes(TEST_AUTH.username));
  assert.ok(!exported.raw.includes(TARGET_PROXY));
  assert.ok(disk.includes('remote-opaque-1'));
});

test('failed destination or browser start never marks a remote environment successfully launched', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const route = `/api/profiles/${profile.id}/launch`;
  app.control.destination = { ok: false, error: 'Destination unavailable', diagnostic: { code: 'proxy_timeout', stage: 'connection', message: 'Test timeout' } };
  const blocked = await app.post(route, { target: 'gmail' });
  assert.equal(blocked.status, 400, blocked.raw);
  assert.equal(app.calls.remote.length, 0);
  let saved = (await app.state()).profiles.find(p => p.id === profile.id);
  assert.equal(saved.expectedIp, null);
  assert.equal(saved.cycleStartedAt, null);
  assert.deepEqual(saved.launches, []);
  assert.equal(saved.checks.at(-1).targetReachable, false);

  app.control.destination = { ok: true, httpStatus: 200 };
  app.control.openError = new Error('Test browser failed to start');
  const failed = await app.post(route, { target: 'signin' });
  assert.equal(failed.status, 400, failed.raw);
  saved = (await app.state()).profiles.find(p => p.id === profile.id);
  assert.equal(saved.session.active, false);
  assert.equal(saved.expectedIp, null);
  assert.equal(saved.cycleStartedAt, null);
  assert.deepEqual(saved.launches, []);
  assert.equal(saved.checks.at(-1).ok, true);
});

test('remote HTTP access accepts only the configured HTTPS origin and explicit loopback hosts', async t => {
  const app = await fixture(t);
  const port = new URL(app.origin).port;
  for (const headers of [
    { Host: 'example.test', Origin: PUBLIC_ORIGIN },
    { Host: `127.0.0.1:${port}`, Origin: app.origin },
    { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
  ]) {
    const result = await app.request('/api/profiles', { method: 'POST', body: { label: 'Allowed origin', country: 'IN' }, headers });
    assert.equal(result.status, 201, result.raw);
  }
  const before = (await app.state()).profiles.length;
  for (const headers of [
    { Host: 'attacker.example', Origin: PUBLIC_ORIGIN },
    { Host: 'example.test.attacker.example', Origin: PUBLIC_ORIGIN },
    { Host: 'example.test', Origin: 'http://example.test' },
    { Host: 'example.test', Origin: 'https://example.test:444' },
    { Host: 'example.test', Origin: 'https://example.test.attacker.example' },
    { Host: 'example.test', Origin: 'https://attacker.example' },
    { Host: 'example.test', Origin: 'null' },
    { Host: 'example.test', Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'example.test', Origin: PUBLIC_ORIGIN, 'X-Lab-Token': '' },
  ]) {
    const result = await app.request('/api/profiles', { method: 'POST', body: { label: 'Rejected origin', country: 'IN' }, headers });
    assert.equal(result.status, 403, `${JSON.stringify(headers)}: ${result.raw}`);
  }
  assert.equal((await app.state()).profiles.length, before);
});

test('remote mode refuses missing, non-HTTPS and non-origin public addresses before creating storage', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'arl-remote-origin-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const publicOrigin of ['', 'http://example.test', 'https://example.test/', 'https://example.test/path', 'https://user:secret@example.test', 'https://example.test?query=1']) {
    assert.throws(() => createLabServer({ dataDir, remoteMode: true, publicOrigin }), /HTTPS/);
  }
});
