import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { createLabServer } from '../server.js';

// API contract tests use an in-memory opaque vault and local bridge substitutes.
// Actual Windows encryption and SOCKS framing are tested separately.
const AUTH = { username: 'unit-test-proxy-user', password: 'unit-test-password-value' };
const PROXY = 'socks5://proxy.example.test:1080';
const LOCAL_PROXY = 'socks5://127.0.0.1:49123';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'arl-proxy-auth-server-'));
  const sealed = new Map();
  const calls = { seal: [], open: [], bridges: [], probes: [], diagnoses: [], google: [], launches: [] };
  const control = {
    probe: { ip: '203.0.113.25', country: 'US', latencyMs: 12 },
    diagnosis: { ok: true, configuredProtocol: 'socks5', probe: { ip: '203.0.113.25', country: 'US' } },
    google: true,
  };
  const vault = {
    async seal(auth) {
      if (control.sealError) throw control.sealError;
      calls.seal.push({ ...auth });
      const envelope = { format: 'test-opaque-v1', data: `opaque-${calls.seal.length}` };
      sealed.set(envelope.data, { ...auth });
      return envelope;
    },
    async open(envelope) {
      calls.open.push(envelope);
      assert.ok(sealed.has(envelope.data));
      return { ...sealed.get(envelope.data) };
    },
  };
  const managed = { isActive: () => false, closeAll: async () => {}, close: async () => ({ ok: true }) };
  const lab = createLabServer({
    dataDir, vault, managed,
    browser: { path: 'fake-browser', name: 'Test browser' },
    createBridge: async (proxy, auth) => {
      const bridge = { proxy: LOCAL_PROXY, lastError: control.bridgeError || null, closed: false,
        async close() { this.closed = true; } };
      calls.bridges.push({ proxy, auth: { ...auth }, bridge });
      return bridge;
    },
    probe: async proxy => {
      calls.probes.push(proxy);
      if (control.probe instanceof Error) throw control.probe;
      return { ...control.probe };
    },
    diagnose: async (proxy, options) => {
      calls.diagnoses.push({ proxy, options });
      if (control.diagnosis instanceof Error) throw control.diagnosis;
      return structuredClone(control.diagnosis);
    },
    google: async proxy => { calls.google.push(proxy); return control.google; },
    destinationProbe: async () => ({ok:true,httpStatus:200}),
    launch: async (browserPath, args) => { calls.launches.push({ browserPath, args }); return { pid: 123 }; },
  });
  lab.server.listen(0, '127.0.0.1');
  await once(lab.server, 'listening');
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  t.after(async () => { await lab.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Lab-Token': lab.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    return { status: response.status, value: JSON.parse(raw), raw };
  }
  async function create(overrides = {}) {
    const result = await request('/api/profiles', {
      label: 'Authenticated environment', country: 'US', proxy: PROXY,
      proxyUsername: AUTH.username, proxyPassword: AUTH.password, ...overrides,
    });
    assert.equal(result.status, 201, result.raw);
    return result.value;
  }
  async function saved() { return JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8')); }
  return { calls, control, request, create, saved };
}

function assertNoPassword(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(AUTH.password), 'No API response or persisted state may contain a plaintext proxy password');
  assert.ok(!text.includes('proxyPassword'));
}

test('proxy auth is sealed before saving and responses/export never expose the envelope or password', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  assert.deepEqual(app.calls.seal, [AUTH]);
  assert.equal(profile.proxyAuthConfigured, true);
  assert.equal(profile.proxyAuth, undefined);
  assertNoPassword(profile);
  const disk = await app.saved();
  assertNoPassword(disk);
  assert.equal(disk.profiles.find(p => p.id === profile.id).proxyAuth.data, 'opaque-1');
  const state = await app.request('/api/state');
  assertNoPassword(state.value);
  assert.ok(!state.raw.includes('opaque-1'));
  const exported = await app.request('/api/export');
  assertNoPassword(exported.value);
  for (const privateValue of [AUTH.username, 'opaque-1', PROXY]) assert.ok(!exported.raw.includes(privateValue));
});

test('an empty password retains sealed credentials only for the same proxy endpoint', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const route = `/api/profiles/${profile.id}`;
  const renamed = await app.request(route, { label: 'Renamed', proxyUsername: AUTH.username, proxyPassword: '' }, 'PATCH');
  assert.equal(renamed.status, 200, renamed.raw);
  assert.equal(renamed.value.proxyAuthConfigured, true);
  assert.equal(app.calls.seal.length, 1);
  const before = await app.saved();
  for (const input of [
    { proxy: 'socks5://other.example.test:1080' },
    { proxy: 'socks5://other.example.test:1080', proxyUsername: AUTH.username, proxyPassword: '' },
  ]) {
    const rejected = await app.request(route, input, 'PATCH');
    assert.equal(rejected.status, 400, rejected.raw);
    assert.match(rejected.value.error, /代理地址已改变/);
    assert.deepEqual(await app.saved(), before);
  }
  const changed = await app.request(route, { proxy: 'socks5://other.example.test:1080', proxyUsername: AUTH.username, proxyPassword: 'replacement-test-password' }, 'PATCH');
  assert.equal(changed.status, 200, changed.raw);
  assert.equal(app.calls.seal.length, 2);
  const cleared = await app.request(route, { clearProxyAuth: true }, 'PATCH');
  assert.equal(cleared.status, 200, cleared.raw);
  assert.equal(cleared.value.proxyAuthConfigured, false);
  assert.equal(cleared.value.proxyUsername, '');
});

test('authenticated native launches probe and open only the loopback bridge with no credentials in browser arguments', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const opened = await app.request(`/api/profiles/${profile.id}/launch`, { target: 'gmail' });
  assert.equal(opened.status, 200, opened.raw);
  assert.equal(app.calls.bridges.length, 1);
  assert.equal(app.calls.bridges[0].proxy, PROXY);
  assert.deepEqual(app.calls.bridges[0].auth, AUTH);
  assert.deepEqual(app.calls.probes, [LOCAL_PROXY]);
  assert.ok(app.calls.launches[0].args.includes(`--proxy-server=${LOCAL_PROXY}`));
  const serialized = JSON.stringify(app.calls.launches);
  for (const secret of [AUTH.username, AUTH.password, PROXY, 'opaque-1']) assert.ok(!serialized.includes(secret));
  assertNoPassword(opened.value);
  assert.equal(opened.value.profile.expectedIp, '203.0.113.25');
  assert.equal(opened.value.profile.launches.length, 1);
});

test('bridge authentication failure blocks launch without binding an IP, starting a cycle or recording a launch', async t => {
  const app = await fixture(t);
  app.control.probe = new Error('Generic local SOCKS failure');
  app.control.bridgeError = { code: 'proxy_auth_rejected', stage: 'authentication', message: '代理拒绝了用户名或密码。', retryable: false };
  const profile = await app.create();
  const failed = await app.request(`/api/profiles/${profile.id}/launch`, { target: 'gmail' });
  assert.equal(failed.status, 400);
  assert.match(failed.value.error, /拒绝了用户名或密码/);
  assert.equal(app.calls.launches.length, 0);
  const saved = (await app.saved()).profiles.find(p => p.id === profile.id);
  assert.equal(saved.expectedIp, null);
  assert.equal(saved.cycleStartedAt, null);
  assert.deepEqual(saved.launches, []);
  assert.equal(saved.checks.at(-1).diagnostic.code, 'proxy_auth_rejected');
  assertNoPassword(saved);
});

test('authenticated diagnosis is temporary, reports target and Google checks, and does not alter profile state', async t => {
  const app = await fixture(t);
  app.control.google = false;
  const before = await app.saved();
  const diagnosed = await app.request('/api/proxy/diagnose', {
    proxy: PROXY, country: 'JP', proxyUsername: AUTH.username, proxyPassword: AUTH.password,
  });
  assert.equal(diagnosed.status, 200, diagnosed.raw);
  assert.equal(diagnosed.value.ok, true);
  assert.equal(diagnosed.value.configuredProtocol, 'socks5');
  assert.equal(diagnosed.value.targetCountryMatches, false);
  assert.equal(diagnosed.value.googleReachable, false);
  assert.ok(diagnosed.value.googleError);
  assert.deepEqual(app.calls.diagnoses, [{ proxy: LOCAL_PROXY, options: { tryAlternateProtocol: false } }]);
  assert.deepEqual(app.calls.google, [LOCAL_PROXY]);
  assert.equal(app.calls.bridges[0].bridge.closed, true);
  assert.equal(app.calls.seal.length, 0);
  assert.deepEqual(await app.saved(), before);
  assertNoPassword(diagnosed.value);
});

test('diagnosis can reuse saved auth but cannot forward it to a different endpoint', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const diagnosed = await app.request('/api/proxy/diagnose', { profileId: profile.id, proxy: PROXY, country: 'US', proxyPassword: '' });
  assert.equal(diagnosed.status, 200, diagnosed.raw);
  assert.deepEqual(app.calls.bridges[0].auth, AUTH);
  const rejected = await app.request('/api/proxy/diagnose', { profileId: profile.id, proxy: 'socks5://other.example.test:1080', country: 'US' });
  assert.equal(rejected.status, 400, rejected.raw);
  assert.equal(app.calls.bridges.length, 1);
  assert.match(rejected.value.error, /代理地址已改变/);
});

test('anonymous diagnosis permits explicit protocol comparison and invalid country is rejected before probing', async t => {
  const app = await fixture(t);
  app.control.diagnosis = { ok: false, configuredProtocol: 'socks5',
    error: { code: 'proxy_protocol_mismatch', stage: 'proxy_protocol', message: '协议不匹配。' },
    suggestedProtocol: 'http', alternateProtocol: { protocol: 'http', ok: true, probe: { country: 'US', ip: '203.0.113.25' } } };
  const result = await app.request('/api/proxy/diagnose', { proxy: PROXY, country: 'US' });
  assert.equal(result.status, 200);
  assert.equal(result.value.ok, false);
  assert.equal(result.value.suggestedProtocol, 'http');
  assert.deepEqual(app.calls.diagnoses[0], { proxy: PROXY, options: { tryAlternateProtocol: true } });
  assert.equal(app.calls.bridges.length, 0);
  const invalid = await app.request('/api/proxy/diagnose', { proxy: PROXY, country: 'INVALID' });
  assert.equal(invalid.status, 400);
  assert.equal(app.calls.diagnoses.length, 1);
});

test('diagnosis closes a temporary bridge on failure and keeps its specific authentication error', async t => {
  const app = await fixture(t);
  app.control.bridgeError = { code: 'proxy_auth_rejected', stage: 'authentication', message: '代理密码错误。', retryable: false };
  app.control.diagnosis = { ok: false, configuredProtocol: 'socks5', error: { code: 'socks_target_denied', message: 'Generic failure' } };
  const result = await app.request('/api/proxy/diagnose', { proxy: PROXY, country: 'US', proxyUsername: AUTH.username, proxyPassword: AUTH.password });
  assert.equal(result.status, 200);
  assert.equal(result.value.error.code, 'proxy_auth_rejected');
  assert.equal(app.calls.bridges[0].bridge.closed, true);
  assertNoPassword(result.value);
  app.control.diagnosis = new Error('Interrupted test probe');
  const thrown = await app.request('/api/proxy/diagnose', { proxy: PROXY, country: 'US', proxyUsername: AUTH.username, proxyPassword: AUTH.password });
  assert.equal(thrown.status, 400);
  assert.equal(app.calls.bridges[1].bridge.closed, true);
});

test('encryption failure aborts create or edit without changing stored profiles', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const before = await app.saved();
  app.control.sealError = new Error('Windows 无法加密代理认证，配置未保存。');
  const create = await app.request('/api/profiles', { label: 'Should not be saved', country: 'US', proxy: PROXY,
    proxyUsername: AUTH.username, proxyPassword: AUTH.password });
  assert.equal(create.status, 400);
  const edit = await app.request(`/api/profiles/${profile.id}`, { label: 'Should not change', proxyUsername: AUTH.username, proxyPassword: 'replacement-test-password' }, 'PATCH');
  assert.equal(edit.status, 400);
  assert.deepEqual(await app.saved(), before);
});
