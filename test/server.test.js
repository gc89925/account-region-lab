import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createLabServer } from '../server.js';

// Tests substitute both the public-IP probe and browser process. No Google account,
// external service, real proxy, or installed browser is used by this suite.
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'account-region-lab-test-'));
  const launches = [];
  const options = {
    dataDir,
    browser: { name: 'Test browser', path: 'fake-browser' },
    probe: async () => ({ ip: '203.0.113.10', country: 'IN' }),
    launch: async (browserPath, args) => { launches.push({ browserPath, args }); return { pid: 123 }; },
    ...overrides,
  };
  let lab;
  let base;
  async function start() {
    lab = await createLabServer(options);
    lab.server.listen(0, '127.0.0.1');
    await once(lab.server, 'listening');
    base = `http://127.0.0.1:${lab.server.address().port}`;
  }
  await start();
  t.after(async () => {
    await lab.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Lab-Token': lab.token }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    return { status: response.status, value, raw };
  }
  async function state() {
    const result = await request('/api/state');
    assert.equal(result.status, 200, result.raw);
    return result.value;
  }
  async function create(label, country = 'IN', proxy = 'http://127.0.0.1:18080') {
    const result = await request('/api/profiles', { method: 'POST', body: { label, country, proxy } });
    assert.ok(result.status >= 200 && result.status < 300, result.raw);
    const profile = (await state()).profiles.find(profile => profile.label === label);
    assert.ok(profile, 'Created profile must appear in state');
    return profile;
  }
  return {
    request, state, create, launches, dataDir,
    get token() { return lab.token; },
    get origin() { return base; },
    async restart() { await lab.close(); await start(); },
  };
}

test('new storage starts with India and Nigeria and generated profile IDs', async t => {
  const app = await fixture(t);
  const state = await app.state();
  assert.deepEqual(state.profiles.map(profile => profile.country).sort(), ['IN', 'NG']);
  assert.equal(state.token, app.token);
  assert.ok(state.token.length >= 24);
  assert.equal(new Set(state.profiles.map(profile => profile.id)).size, 2);
  for (const profile of state.profiles) {
    assert.match(profile.id, /^[0-9a-f-]{36}$/);
    assert.equal(profile.proxy, '');
    assert.equal(profile.cycleStartedAt, null);
  }
});

test('writes reject invalid tokens, external origins, and non-JSON submissions', async t => {
  const app = await fixture(t);
  const body = { label: 'CSRF attempt', country: 'IN', proxy: '' };
  for (const headers of [
    { 'X-Lab-Token': '' },
    { 'X-Lab-Token': 'not-the-token' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { Origin: `${app.origin}.attacker.example` },
  ]) {
    const result = await app.request('/api/profiles', { method: 'POST', body, headers });
    assert.equal(result.status, 403, result.raw);
  }
  const nonJson = await app.request('/api/profiles', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
  assert.ok(nonJson.status >= 400 && nonJson.status < 500, nonJson.raw);
  assert.equal((await app.state()).profiles.length, 2);
  const local = await app.request('/api/profiles', { method: 'POST', body: { ...body, label: 'Local origin' }, headers: { Origin: app.origin } });
  assert.ok(local.status >= 200 && local.status < 300, local.raw);
});

test('API refuses malformed proxies without saving any profile', async t => {
  const app = await fixture(t);
  for (const proxy of ['https://127.0.0.1:1080', 'http://user:secret@127.0.0.1:18080', 'http://127.0.0.1:18080;direct://', 'http://127.0.0.1:18080 --no-proxy-server']) {
    const result = await app.request('/api/profiles', { method: 'POST', body: { label: 'Invalid', country: 'IN', proxy } });
    assert.equal(result.status, 400, result.raw);
  }
  assert.equal((await app.state()).profiles.length, 2);
});

test('each launch rechecks the exit and refuses mismatches or probe errors after a prior success', async t => {
  let result = { ip: '203.0.113.10', country: 'IN' };
  let probeCalls = 0;
  const app = await fixture(t, {
    probe: async () => { probeCalls++; if (result instanceof Error) throw result; return result; },
  });
  const profile = await app.create('Exit guard');
  const endpoint = `/api/profiles/${profile.id}`;
  const check = await app.request(`${endpoint}/check`, { method: 'POST', body: {} });
  assert.equal(check.status, 200, check.raw);
  result = { ip: '203.0.113.20', country: 'CN' };
  const mismatch = await app.request(`${endpoint}/launch`, { method: 'POST', body: { target: 'gmail' } });
  assert.equal(mismatch.status, 400, mismatch.raw);
  result = new Error('Simulated proxy unavailable');
  const failed = await app.request(`${endpoint}/launch`, { method: 'POST', body: { target: 'youtube' } });
  assert.equal(failed.status, 400, failed.raw);
  assert.equal(probeCalls, 3, 'A stored successful check must never bypass a fresh launch probe');
  assert.equal(app.launches.length, 0);
});

test('matching launches use stable isolated directories and the selected proxy', async t => {
  const app = await fixture(t, {
    probe: async proxy => ({ ip: '203.0.113.10', country: proxy.endsWith(':18081') ? 'NG' : 'IN' }),
  });
  const india = await app.create('Isolated India');
  const nigeria = await app.create('Isolated Nigeria', 'NG', 'socks5://127.0.0.1:18081');
  for (const [profile, target] of [[india, 'gmail'], [india, 'youtube'], [nigeria, 'terms'], [nigeria, 'appeal']]) {
    const result = await app.request(`/api/profiles/${profile.id}/launch`, { method: 'POST', body: { target } });
    assert.equal(result.status, 200, result.raw);
  }
  assert.equal(app.launches.length, 4);
  const dirs = app.launches.map(call => call.args.find(arg => arg.startsWith('--user-data-dir=')));
  assert.equal(dirs[0], dirs[1]);
  assert.equal(dirs[2], dirs[3]);
  assert.notEqual(dirs[0], dirs[2]);
  for (const [index, profile] of [[0, india], [2, nigeria]]) {
    assert.ok(dirs[index].includes(profile.id));
    assert.ok(app.launches[index].args.includes(`--proxy-server=${profile.proxy}`));
  }
  for (const call of app.launches) assert.equal(call.browserPath, 'fake-browser');
});

test('unconfigured proxies and arbitrary launch targets never reach a browser process', async t => {
  const app = await fixture(t);
  const profile = await app.create('No exit', 'IN', '');
  const absent = await app.request(`/api/profiles/${profile.id}/launch`, { method: 'POST', body: { target: 'gmail' } });
  assert.equal(absent.status, 400, absent.raw);
  const configured = await app.create('Allowed destinations');
  for (const target of ['https://attacker.example', '__proto__', 'faq']) {
    const result = await app.request(`/api/profiles/${configured.id}/launch`, { method: 'POST', body: { target } });
    assert.equal(result.status, 400, result.raw);
  }
  assert.equal(app.launches.length, 0);
});

test('manual observations and review cycle survive restart while API tokens rotate', async t => {
  const app = await fixture(t);
  const profile = await app.create('Persistent evidence');
  const endpoint = `/api/profiles/${profile.id}`;
  const cycle = await app.request(`${endpoint}/cycle`, { method: 'POST', body: {} });
  assert.equal(cycle.status, 200, cycle.raw);
  const observation = await app.request(`${endpoint}/observations`, { method: 'POST', body: { country: 'CN', note: 'Terms page still shows China; manually observed.' } });
  assert.equal(observation.status, 200, observation.raw);
  const before = (await app.state()).profiles.find(item => item.id === profile.id);
  const oldToken = app.token;
  await app.restart();
  const after = (await app.state()).profiles.find(item => item.id === profile.id);
  assert.notEqual(app.token, oldToken);
  assert.deepEqual(after.observations, before.observations);
  assert.equal(after.observations.length, 1);
  assert.equal(after.observations[0].country, 'CN');
  assert.equal(after.cycleStartedAt, before.cycleStartedAt);
  assert.ok(after.cycleStartedAt);
  assert.equal(after.stats.observationCount, 1);
});

test('changing a target country clears stale network evidence and restarts review eligibility', async t => {
  const app = await fixture(t);
  const profile = await app.create('Change target');
  const endpoint = `/api/profiles/${profile.id}`;
  assert.equal((await app.request(`${endpoint}/check`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await app.request(`${endpoint}/cycle`, { method: 'POST', body: {} })).status, 200);
  const updated = await app.request(endpoint, { method: 'PATCH', body: { label: profile.label, country: 'NG', proxy: profile.proxy } });
  assert.equal(updated.status, 200, updated.raw);
  const saved = (await app.state()).profiles.find(item => item.id === profile.id);
  assert.equal(saved.country, 'NG');
  assert.deepEqual(saved.checks, []);
  assert.equal(saved.cycleStartedAt, null);
});

test('export removes proxy endpoints and detected IPs while keeping manual country evidence', async t => {
  const app = await fixture(t);
  const profile = await app.create('Export evidence', 'IN', 'http://127.0.0.1:18089');
  const endpoint = `/api/profiles/${profile.id}`;
  assert.equal((await app.request(`${endpoint}/check`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await app.request(`${endpoint}/observations`, { method: 'POST', body: { country: 'CN', note: 'Checked terms page' } })).status, 200);
  const exported = await app.request('/api/export');
  assert.equal(exported.status, 200, exported.raw);
  assert.ok(!exported.raw.includes('127.0.0.1:18089'));
  assert.ok(!exported.raw.includes('203.0.113.10'));
  assert.ok(!exported.raw.includes(app.token));
  assert.ok(exported.raw.includes('Export evidence'));
  assert.ok(exported.raw.includes('Checked terms page'));
});

test('a previously launched profile keeps its country and proxy across restart but can be renamed', async t => {
  const app = await fixture(t);
  const profile = await app.create('Immutable connection');
  const endpoint = `/api/profiles/${profile.id}`;
  assert.equal((await app.request(`${endpoint}/launch`, { method: 'POST', body: { target: 'gmail' } })).status, 200);
  await app.restart();
  for (const body of [{ country: 'NG' }, { proxy: 'http://127.0.0.1:18090' }]) {
    const response = await app.request(endpoint, { method: 'PATCH', body });
    assert.equal(response.status, 400, response.raw);
  }
  const rename = await app.request(endpoint, { method: 'PATCH', body: { label: 'Renamed environment' } });
  assert.equal(rename.status, 200, rename.raw);
  const saved = (await app.state()).profiles.find(item => item.id === profile.id);
  assert.equal(saved.label, 'Renamed environment');
  assert.equal(saved.proxy, profile.proxy);
  assert.equal(saved.country, 'IN');
});

test('a pending probe prevents simultaneous changes to that profile', async t => {
  let releaseProbe;
  let reachedProbe;
  const reached = new Promise(resolve => { reachedProbe = resolve; });
  const app = await fixture(t, {
    probe: async () => {
      reachedProbe();
      return await new Promise(resolve => { releaseProbe = () => resolve({ ip: '203.0.113.10', country: 'IN' }); });
    },
  });
  const profile = await app.create('No concurrent changes');
  const endpoint = `/api/profiles/${profile.id}`;
  const pending = app.request(`${endpoint}/check`, { method: 'POST', body: {} });
  await reached;
  let attempted;
  try {
    attempted = await app.request(endpoint, { method: 'PATCH', body: { country: 'NG' } });
  } finally { releaseProbe(); }
  assert.equal((await pending).status, 200);
  assert.equal(attempted.status, 409, attempted.raw);
  assert.equal((await app.state()).profiles.find(item => item.id === profile.id).country, 'IN');
});

test('browser process failures do not create successful launch records or start an observation cycle', async t => {
  const app = await fixture(t, { launch: async () => { throw new Error('Simulated process start failure'); } });
  const profile = await app.create('Browser unavailable');
  const response = await app.request(`/api/profiles/${profile.id}/launch`, { method: 'POST', body: { target: 'gmail' } });
  assert.equal(response.status, 400, response.raw);
  const saved = (await app.state()).profiles.find(item => item.id === profile.id);
  assert.deepEqual(saved.launches, []);
  assert.equal(saved.cycleStartedAt, null);
  assert.equal(saved.checks.at(-1).ok, true);
});
