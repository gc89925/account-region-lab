import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const options = {
    dataDir,
    remoteMode: true,
    publicOrigin: PUBLIC_ORIGIN,
    browser: { name: 'Test remote browser', path: '/test/chromium' },
    remote: {
      isActive: id => active.has(id),
      getDesktop: id => active.has(id) && !control.desktopUnavailable ? {port:6101 + [...active].indexOf(id), generation:id.replaceAll('-','')} : null,
      async open(options) {
        calls.remote.push(structuredClone(options));
        if (control.openError) throw control.openError;
        active.add(options.profile.id);
        return { ok: true, active: true, pid: 1234 };
      },
      async close(id) { calls.remoteClose.push(id); if (control.closeFails) return {ok:false}; active.delete(id); return { ok: true }; },
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
  };
  let lab = createLabServer(options);
  lab.server.listen(0, '127.0.0.1');
  await once(lab.server, 'listening');
  let origin = `http://127.0.0.1:${lab.server.address().port}`;
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
  return {
    dataDir, get origin() { return origin; }, calls, control, active, request, post, state, create, close: () => lab.close(),
    async restart() {
      await lab.close();
      lab = createLabServer(options);
      lab.server.listen(0, '127.0.0.1');
      await once(lab.server, 'listening');
      origin = `http://127.0.0.1:${lab.server.address().port}`;
    },
  };
}

test('remote snapshot advertises per-profile desktops and capacity', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const snapshot = await app.state();
  assert.equal(snapshot.capabilities.remoteBrowser, true);
  assert.equal(snapshot.capabilities.managed, false);
  assert.equal(snapshot.remoteDesktopUrl, undefined);
  assert.equal(snapshot.capabilities.maxRemoteEnvironments,5);
  assert.deepEqual(snapshot.remoteSessions,{limit:5,active:0,starting:0});
  assert.equal(snapshot.profiles.find(p => p.id === profile.id).environment.engine, 'native');
  assert.deepEqual(snapshot.profiles.find(p => p.id === profile.id).session, { active: false, managed: true, starting:false, desktopUrl:null });
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
  assert.equal(managed.environment.engine, 'native', 'Server settings must describe the effective native browser');
  assert.equal((await app.post(`/api/profiles/${managed.id}/launch`, { target: 'signin' })).status, 200);
  assert.equal(app.calls.remote.at(-1).profile.id, managed.id);
  assert.notEqual(app.calls.remote.at(-1).profileDir, app.calls.remote[0].profileDir);
  assert.equal(app.calls.native.length, 0);
  assert.equal(app.calls.managed.length, 0);
  await app.close();
  assert.equal(app.calls.remoteCloseAll, 1);
  assert.equal(app.active.size, 0);
});

test('five different environments remain active and closing one frees only its slot', async t => {
  const app = await fixture(t);
  const profiles = [];
  for (let i=0;i<6;i++) profiles.push(await app.create({label:`Account ${i}`,accountLabel:`account-${i}`}));
  for (const profile of profiles.slice(0,5)) assert.equal((await app.post(`/api/profiles/${profile.id}/launch`,{target:'signin'})).status,200);
  const snapshot = await app.state();
  assert.deepEqual(snapshot.remoteSessions,{limit:5,active:5,starting:0});
  const urls = snapshot.profiles.filter(p => p.session.active).map(p => p.session.desktopUrl);
  assert.equal(new Set(urls).size,5);
  for (let i=0;i<5;i++) assert.ok(urls[i].startsWith(`/desktop/${profiles[i].id}/${profiles[i].id.replaceAll('-','')}/`));
  const probeCount = app.calls.probes.length;
  const blocked = await app.post(`/api/profiles/${profiles[5].id}/launch`, { target: 'gmail' });
  assert.equal(blocked.status, 400, blocked.raw);
  assert.match(blocked.value.error, /最多同时运行 5 个环境/);
  assert.equal(app.calls.probes.length, probeCount);
  assert.equal(app.calls.remote.length, 5);
  // A new tab in an existing environment is allowed at full capacity.
  assert.equal((await app.post(`/api/profiles/${profiles[1].id}/launch`,{target:'gmail'})).status,200);
  assert.equal((await app.post(`/api/profiles/${profiles[0].id}/close`)).status, 200);
  assert.deepEqual([...app.active],profiles.slice(1,5).map(p => p.id));
  assert.equal((await app.post(`/api/profiles/${profiles[5].id}/launch`, { target: 'signin' })).status, 200);
  assert.deepEqual([...app.active],profiles.slice(1).map(p => p.id));
});

test('resume is idempotent and older sign-in requests never add tabs or network probes to an active environment', async t => {
  const app = await fixture(t);
  const profile = await app.create();
  const route = `/api/profiles/${profile.id}`;
  assert.equal((await app.post(route + '/launch', { target: 'signin' })).status, 200);
  const before = (await app.state()).profiles.find(item => item.id === profile.id);
  const callsBefore = { remote: app.calls.remote.length, probes: app.calls.probes.length, destinations: app.calls.destinations.length, bridges: app.calls.bridges.length };
  app.control.probe = new Error('Resuming a desktop must not depend on a fresh proxy probe');
  for (const action of ['resume', 'resume', 'launch']) {
    const result = await app.post(`${route}/${action}`, action === 'launch' ? { target: 'signin' } : {});
    assert.equal(result.status, 200, result.raw);
    assert.equal(result.value.resumed, true);
    assert.equal(result.value.profile.session.desktopUrl, before.session.desktopUrl);
    assert.deepEqual(result.value.profile.launches, before.launches);
    assert.deepEqual(result.value.profile.checks, before.checks);
    assert.equal(result.value.profile.expectedIp, before.expectedIp);
  }
  assert.deepEqual({ remote: app.calls.remote.length, probes: app.calls.probes.length, destinations: app.calls.destinations.length, bridges: app.calls.bridges.length }, callsBefore);
  app.control.desktopUnavailable = true;
  const unavailable = await app.post(route + '/resume');
  assert.equal(unavailable.status, 409); assert.match(unavailable.value.error, /尚未就绪/);
  app.control.desktopUnavailable = false;
  await app.post(route + '/close');
  const closed = await app.post(route + '/resume');
  assert.equal(closed.status, 409); assert.match(closed.value.error, /已关闭/);
  assert.equal(closed.value.profile.session.active, false);
  assert.equal(app.calls.remote.length, callsBefore.remote, 'resume cannot silently restart a closed browser');
});

test('expired remote proxies can be cleared and replaced after close while preserving the login directory', async t => {
  const app = await fixture(t);
  const profile = await app.create({proxyUsername:TEST_AUTH.username,proxyPassword:TEST_AUTH.password});
  const route = `/api/profiles/${profile.id}`;
  assert.equal((await app.post(route+'/launch',{target:'gmail'})).status,200);
  const profileDir = app.calls.remote[0].profileDir;
  await writeFile(path.join(profileDir,'login-preservation-sentinel'),'existing account data');
  await app.post(route+'/observations',{country:'CN',note:'Before proxy expired'});
  const active = (await app.state()).profiles.find(p=>p.id===profile.id);
  assert.equal(active.locked,true);
  const rejected = await app.request(route,{method:'PATCH',body:{proxy:''}});
  assert.equal(rejected.status,400); assert.match(rejected.value.error,/先关闭/);
  assert.equal((await app.state()).profiles.find(p=>p.id===profile.id).proxy,TARGET_PROXY);
  await app.post(route+'/close');
  assert.equal((await app.state()).profiles.find(p=>p.id===profile.id).locked,false);
  const cleared = await app.request(route,{method:'PATCH',body:{proxy:''}});
  assert.equal(cleared.status,200,cleared.raw);
  assert.equal(cleared.value.proxy,'');
  assert.equal(cleared.value.proxyAuthConfigured,false);
  assert.equal(cleared.value.proxyUsername,'');
  assert.equal(cleared.value.expectedIp,null);
  assert.equal(cleared.value.cycleStartedAt,null);
  assert.equal(cleared.value.proxyBridgePort,undefined);
  assert.equal(cleared.value.launches.length,1);
  assert.equal(cleared.value.observations.length,1);
  assert.ok(cleared.value.cycleHistory.includes(active.cycleStartedAt));
  assert.equal(app.calls.bridges[0].bridge.closed,true);
  assert.equal((await app.post(route+'/launch',{target:'gmail'})).status,400);
  const changed = await app.request(route,{method:'PATCH',body:{proxy:'socks5://replacement.example.test:12321',proxyUsername:'replacement-user',proxyPassword:'replacement-test-password'}});
  assert.equal(changed.status,200,changed.raw);
  assert.equal(changed.value.proxyAuthConfigured,true);
  app.control.probe = {ip:'203.0.113.99',country:'IN'};
  assert.equal((await app.post(route+'/launch',{target:'gmail'})).status,200);
  assert.equal(app.calls.remote.at(-1).profileDir,profileDir);
  assert.equal(await readFile(path.join(profileDir,'login-preservation-sentinel'),'utf8'),'existing account data');
  assert.equal(app.calls.bridges.at(-1).proxy,'socks5://replacement.example.test:12321');
  assert.equal((await app.state()).profiles.find(p=>p.id===profile.id).expectedIp,'203.0.113.99');
});

test('a failed remote close keeps network settings locked and credentials intact', async t => {
  const app = await fixture(t);
  const profile = await app.create({proxyUsername:TEST_AUTH.username,proxyPassword:TEST_AUTH.password});
  const route = `/api/profiles/${profile.id}`;
  await app.post(route+'/launch',{target:'diagnostics'});
  app.control.closeFails=true;
  assert.equal((await app.post(route+'/close')).status,400);
  assert.equal((await app.request(route,{method:'PATCH',body:{proxy:''}})).status,400);
  const saved=(await app.state()).profiles.find(p=>p.id===profile.id);
  assert.equal(saved.locked,true); assert.equal(saved.proxyAuthConfigured,true);
  assert.equal(saved.proxy,TARGET_PROXY);
});

test('clearing an expired proxy succeeds when its concurrent startup bridge restoration fails', async t => {
  let restoring = false, rejectRestoration, notifyRestoration;
  const restorationReached = new Promise(resolve => { notifyRestoration = resolve; });
  const app = await fixture(t, {
    async createBridge() {
      if (restoring) {
        notifyRestoration();
        await new Promise((resolve, reject) => { rejectRestoration = reject; });
      }
      return { proxy: BRIDGE_PROXY, async close() {} };
    },
  });
  const profile = await app.create({ proxyUsername: TEST_AUTH.username, proxyPassword: TEST_AUTH.password });
  const route = `/api/profiles/${profile.id}`;
  assert.equal((await app.post(route + '/launch', { target: 'diagnostics' })).status, 200);
  await app.post(route + '/close');
  const profileDir = app.calls.remote[0].profileDir;
  await writeFile(path.join(profileDir, 'restoration-preservation-sentinel'), 'existing account data');

  restoring = true;
  await app.restart();
  await restorationReached;
  const clearing = app.request(route, { method: 'PATCH', body: { proxy: '' } });
  try {
    // A competing edit returning 409 proves the first edit reached the pending
    // restoration, rather than releasing the failed startup before PATCH began.
    let competing;
    for (let attempt = 0; attempt < 10; attempt++) {
      competing = await app.request(route, { method: 'PATCH', body: { label: profile.label } });
      if (competing.status === 409) break;
    }
    assert.equal(competing.status, 409, competing.raw);
  } finally {
    rejectRestoration(new Error('Synthetic expired bridge restoration failure'));
  }
  const cleared = await clearing;
  assert.equal(cleared.status, 200, cleared.raw);
  assert.equal(cleared.value.proxy, '');
  assert.equal(cleared.value.proxyAuthConfigured, false);
  assert.equal(cleared.value.proxyBridgePort, undefined);
  assert.equal(await readFile(path.join(profileDir, 'restoration-preservation-sentinel'), 'utf8'), 'existing account data');
  const persisted = JSON.parse(await readFile(path.join(app.dataDir, 'state.json'), 'utf8')).profiles.find(item => item.id === profile.id);
  assert.equal(persisted.proxyAuth, null);
  assert.equal(persisted.proxyBridgePort, undefined);
});

test('in-flight launches reserve capacity and cannot race past the limit', async t => {
  let releaseProbe, reachedProbe, started=0;
  const gate = new Promise(resolve => { releaseProbe=resolve; });
  const reached = new Promise(resolve => { reachedProbe=resolve; });
  const app = await fixture(t, { maxRemoteEnvironments:3, probe: async () => {
    if (++started === 3) reachedProbe();
    await gate;
    return { ip: '203.0.113.42', country: 'IN' };
  } });
  const profiles=[];
  for (let i=0;i<4;i++) profiles.push(await app.create({label:`Pending ${i}`}));
  const pending=profiles.slice(0,3).map(p => app.post(`/api/profiles/${p.id}/launch`,{target:'signin'}));
  await reached;
  let blocked;
  try {
    assert.deepEqual((await app.state()).remoteSessions,{limit:3,active:0,starting:3});
    blocked = await app.post(`/api/profiles/${profiles[3].id}/launch`, { target: 'signin' });
  }
  finally { releaseProbe(); }
  assert.ok((await Promise.all(pending)).every(r => r.status===200));
  assert.equal(blocked.status, 400, blocked.raw);
  assert.equal(app.calls.remote.length, 3);
  assert.deepEqual((await app.state()).remoteSessions,{limit:3,active:3,starting:0});
});

test('internal desktop resolution is loopback-only and bound to the active generation',async t => {
  const app=await fixture(t), profile=await app.create();
  const route=`/internal/desktops/${profile.id}/${profile.id.replaceAll('-','')}`;
  assert.equal((await app.request(route)).status,404);
  assert.equal((await app.post(`/api/profiles/${profile.id}/launch`,{target:'diagnostics'})).status,200);
  assert.deepEqual((await app.request(route)).value,{port:6101});
  assert.equal((await app.request(route,{headers:{Host:'example.test'}})).status,403);
  assert.equal((await app.request(route,{headers:{Origin:app.origin}})).status,403);
  assert.equal((await app.request(`/internal/desktops/${profile.id}/${'0'.repeat(32)}`)).status,404);
  await app.post(`/api/profiles/${profile.id}/close`);
  assert.equal((await app.request(route)).status,404);
});

test('same account remains mutually exclusive even with spare capacity',async t => {
  const app=await fixture(t), first=await app.create({accountLabel:'same'}), second=await app.create({accountLabel:'SAME'});
  assert.equal((await app.post(`/api/profiles/${first.id}/launch`,{target:'diagnostics'})).status,200);
  const blocked=await app.post(`/api/profiles/${second.id}/launch`,{target:'diagnostics'});
  assert.equal(blocked.status,400);assert.match(blocked.value.error,/同一账号代号/);
});

test('a failed close remains retryable instead of being mislabeled as starting',async t => {
  const app=await fixture(t), profile=await app.create();
  await app.post(`/api/profiles/${profile.id}/launch`,{target:'diagnostics'});
  app.control.desktopUnavailable=true;app.control.closeFails=true;
  assert.equal((await app.post(`/api/profiles/${profile.id}/close`)).status,400);
  const session=(await app.state()).profiles.find(p => p.id===profile.id).session;
  assert.deepEqual(session,{active:true,managed:true,starting:false,desktopUrl:null});
  app.control.closeFails=false;
  assert.equal((await app.post(`/api/profiles/${profile.id}/close`)).status,200);
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
