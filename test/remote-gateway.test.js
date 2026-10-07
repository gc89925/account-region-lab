import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { scryptSync, createHash } from 'node:crypto';
import { createRemoteGateway } from '../lib/remote-gateway.js';

const publicOrigin = 'https://lab.example.test';
const salt = '1a'.repeat(16);
const credentials = { username: 'test-admin', salt, passwordHash: scryptSync('test-password-only', Buffer.from(salt, 'hex'), 32).toString('hex') };
const profileA = '11111111-1111-4111-8111-111111111111';
const profileB = '22222222-2222-4222-8222-222222222222';
const generationA = 'a'.repeat(32);
const generationB = 'b'.repeat(32);
const desktopA = `/desktop/${profileA}/${generationA}`;
const desktopB = `/desktop/${profileB}/${generationB}`;
const internalA = `/internal/desktops/${profileA}/${generationA}`;
const internalB = `/internal/desktops/${profileB}/${generationB}`;

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function listenDesktop(server) {
  for (let port = 6101; port <= 6105; port++) {
    try { return await listen(server, port); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('The gateway integration tests need two free loopback ports in 6101..6105.');
}

async function fixture(t, options = {}) {
  const appRequests = [];
  const desktopRequests = [];
  const lookupRequests = [];
  const routes = new Map();
  let lookupHandler;
  let upgradeHandler;
  const app = http.createServer((req, res) => {
    if (req.url.startsWith('/internal/')) {
      lookupRequests.push({ url: req.url, headers: req.headers });
      if (lookupHandler) return lookupHandler(req, res);
      const desktopPort = routes.get(req.url);
      res.writeHead(desktopPort ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(desktopPort ? { port: desktopPort } : { error: 'inactive' }));
    }
    appRequests.push({ url: req.url, headers: req.headers });
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: true }));
  });
  const desktopSockets = new Set();
  const desktops = ['A', 'B'].map(name => {
    const desktop = http.createServer((req, res) => {
      desktopRequests.push({ name, url: req.url, headers: req.headers });
      res.end(`desktop-${name}`);
    });
    desktop.on('upgrade', (req, socket, head) => {
      desktopRequests.push({ name, url: req.url, headers: req.headers, upgrade: true });
      desktopSockets.add(socket);
      socket.on('close', () => desktopSockets.delete(socket));
      socket.on('error', () => {});
      upgradeHandler?.(req, socket);
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      if (head.length) socket.write(head);
      socket.on('data', data => socket.write(data));
    });
    return desktop;
  });
  let gateway;
  t.after(async () => {
    await gateway?.close();
    for (const socket of desktopSockets) socket.destroy();
    await Promise.all([app, ...desktops].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  const appPort = await listen(app);
  const desktopPort = await listenDesktop(desktops[0]);
  const secondDesktopPort = await listenDesktop(desktops[1]);
  routes.set(internalA, desktopPort);
  routes.set(internalB, secondDesktopPort);
  gateway = createRemoteGateway({ publicOrigin, credentials, appTarget: `http://127.0.0.1:${appPort}`, ...options });
  const port = await listen(gateway.server);
  const request = (route = '/', { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: 'lab.example.test', ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const login = (password = 'test-password-only') => request('/login', {
    method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: credentials.username, password }).toString(),
  });
  const upgrade = (headers = {}, route = `${desktopA}/websockify`) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, headers: {
      Host: 'lab.example.test', Origin: publicOrigin, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'), ...headers,
    } });
    req.once('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.once('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.once('error', reject);
    req.end();
  });
  return {
    request, login, upgrade, appRequests, desktopRequests, lookupRequests, desktopPort,
    appPort, port, routes, gateway, secondDesktopPort,
    setLookupHandler(handler) { lookupHandler = handler; },
    setUpgradeHandler(handler) { upgradeHandler = handler; },
  };
}

test('all workbench and desktop resources require authentication and the cookie is browser-secure', async t => {
  const f = await fixture(t);
  const loginPage = await f.request('/login');
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers['referrer-policy'], 'same-origin');
  assert.equal((await f.request('/')).headers.location, '/login');
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/desktop/vnc.html')).headers.location, '/login');
  assert.equal(f.appRequests.length, 0);
  assert.equal(f.desktopRequests.length, 0);
  const failed = await f.login('wrong');
  assert.equal(failed.status, 401);
  assert.equal(failed.headers['set-cookie'], undefined);
  const login = await f.login();
  assert.equal(login.status, 303);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-region_lab_session=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await f.request('/api/state', { headers: { Cookie: cookie, Authorization: 'Basic ignored' } })).status, 200);
  assert.equal(f.appRequests[0].headers.host, 'lab.example.test');
  assert.equal(f.appRequests[0].headers.cookie, undefined);
  assert.equal(f.appRequests[0].headers.authorization, undefined);
  assert.equal((await f.request(`${desktopA}/vnc.html?resize=scale`, { headers: { Cookie: cookie } })).body, 'desktop-A');
  assert.equal(f.desktopRequests[0].url, '/vnc.html?resize=scale');
  assert.equal(f.desktopRequests[0].headers.host, `127.0.0.1:${f.desktopPort}`);
  assert.equal(f.lookupRequests[0].url, internalA);
  assert.equal(f.lookupRequests[0].headers.host, `127.0.0.1:${f.appPort}`);
  assert.equal(f.lookupRequests[0].headers.cookie, undefined);
  assert.equal(f.lookupRequests[0].headers.origin, undefined);
});

test('host and origin validation rejects cross-site login and authenticated mutations', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/login', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.request('/login', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/login', { method: 'POST' })).status, 403);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  for (const origin of [undefined, 'https://evil.example']) {
    assert.equal((await f.request('/api/profiles', { method: 'POST', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } })).status, 403);
  }
  assert.equal((await f.request('/api/profiles', { method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(f.appRequests.length, 0);
  assert.equal((await f.request('/api/profiles', { method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin }, body: '{}' })).status, 200);
  assert.equal(f.appRequests[0].headers.origin, publicOrigin);
});

test('WebSocket tunnel requires same-origin session and logout closes an active tunnel', async t => {
  const f = await fixture(t);
  assert.equal((await f.upgrade()).status, 401);
  assert.equal(f.desktopRequests.length, 0);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  assert.equal((await f.upgrade({ Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.upgrade({ Cookie: cookie }, '/api/state')).status, 404);
  const tunnel = await f.upgrade({ Cookie: cookie });
  assert.equal(tunnel.status, 101);
  const echoed = once(tunnel.socket, 'data');
  tunnel.socket.write('test-tunnel-payload');
  assert.equal((await echoed)[0].toString(), 'test-tunnel-payload');
  assert.equal(f.desktopRequests.at(-1).url, '/websockify');
  assert.equal(f.desktopRequests.at(-1).headers.cookie, undefined);
  assert.equal(f.lookupRequests.length, 2, 'the generation is rechecked after connecting the socket');
  const closed = once(tunnel.socket, 'close');
  const logout = await f.request('/logout', { method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin } });
  assert.equal(logout.status, 303);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  await closed;
  assert.equal((await f.request('/api/state', { headers: { Cookie: cookie } })).status, 401);
});

test('login attempts are bounded and expired sessions cannot access APIs or WebSockets', async t => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time, sessionMs: 1000 });
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  time += 1001;
  assert.equal((await f.request('/api/state', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await f.upgrade({ Cookie: cookie })).status, 401);
  for (let i = 0; i < 9; i++) assert.equal((await f.login('wrong')).status, 401);
  const limited = await f.login();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  time += 60000;
  assert.equal((await f.login()).status, 303);
});

test('configuration rejects public upstreams and an insecure public origin', () => {
  assert.throws(() => createRemoteGateway({ publicOrigin: 'http://lab.example.test', credentials }), /HTTPS/);
  assert.throws(() => createRemoteGateway({ publicOrigin, credentials, appTarget: 'http://example.com:4317' }), /本机/);
  assert.throws(() => createRemoteGateway({ publicOrigin, credentials: { ...credentials, passwordHash: 'wrong' } }), /认证文件/);
  assert.throws(() => createRemoteGateway({ publicOrigin, credentials, maxSessions: 0 }), /会话限制/);
});

test('oversized form and duplicate cookies are rejected; session count is bounded', async t => {
  const f = await fixture(t, { maxSessions: 1 });
  const oversized = await f.request('/login', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + 'x'.repeat(8192) });
  assert.equal(oversized.status, 413);
  const first = (await f.login()).headers['set-cookie'][0].split(';')[0];
  assert.equal((await f.request('/api/state', { headers: { Cookie: `${first}; ${first}` } })).status, 401);
  const second = (await f.login()).headers['set-cookie'][0].split(';')[0];
  assert.notEqual(first, second);
  assert.equal((await f.request('/api/state', { headers: { Cookie: first } })).status, 401);
  assert.equal((await f.request('/api/state', { headers: { Cookie: second } })).status, 200);
  assert.equal((await f.request('/logout', { headers: { Cookie: second } })).status, 405);
});

test('different environments have independent assets and simultaneous desktop tunnels', async t => {
  const f = await fixture(t);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie };
  const assets = await Promise.all([
    f.request(`${desktopA}/app/ui.js?cache=a`, { headers }),
    f.request(`${desktopB}/app/ui.js?cache=b`, { headers }),
  ]);
  assert.deepEqual(assets.map(response => response.body), ['desktop-A', 'desktop-B']);
  assert.deepEqual(f.desktopRequests.map(request => request.url).sort(), ['/app/ui.js?cache=a', '/app/ui.js?cache=b']);
  const [first, second] = await Promise.all([
    f.upgrade(headers, `${desktopA}/websockify`), f.upgrade(headers, `${desktopB}/websockify`),
  ]);
  assert.equal(first.status, 101);
  assert.equal(second.status, 101);
  const firstEcho = once(first.socket, 'data');
  const secondEcho = once(second.socket, 'data');
  first.socket.write('first-environment');
  second.socket.write('second-environment');
  assert.equal((await firstEcho)[0].toString(), 'first-environment');
  assert.equal((await secondEcho)[0].toString(), 'second-environment');
  first.socket.destroy();
  f.routes.delete(internalA);
  assert.equal((await f.request(`${desktopA}/vnc.html`, { headers })).status, 404);
  assert.equal((await f.upgrade(headers, `${desktopA}/websockify`)).status, 404);
  const stillLive = once(second.socket, 'data');
  second.socket.write('second-remains-open');
  assert.equal((await stillLive)[0].toString(), 'second-remains-open');
  second.socket.destroy();
});

test('stale generations and the legacy shared desktop cannot reach a restarted environment', async t => {
  const f = await fixture(t);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie };
  f.routes.delete(internalA);
  const restarted = `/desktop/${profileA}/${'c'.repeat(32)}`;
  f.routes.set(`/internal/desktops/${profileA}/${'c'.repeat(32)}`, f.desktopPort);
  for (const route of [`${desktopA}/vnc.html`, '/desktop', '/desktop/', '/desktop/vnc.html', '/desktop/6101/vnc.html', `/desktop/${profileA}/wrong/vnc.html`]) {
    assert.equal((await f.request(route, { headers })).status, 404, route);
  }
  assert.equal((await f.upgrade(headers, `${desktopA}/websockify`)).status, 404);
  assert.equal((await f.upgrade(headers, '/desktop/websockify')).status, 404);
  assert.equal(f.desktopRequests.length, 0);
  assert.equal((await f.request(`${restarted}/vnc.html`, { headers })).body, 'desktop-A');
});

test('internal routes and ambiguous encoded paths are blocked before authentication or proxying', async t => {
  const f = await fixture(t);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  for (const headers of [{}, { Cookie: cookie }]) {
    for (const route of [internalA, '/internal', '/INTERNAL/desktops/test']) {
      assert.equal((await f.request(route, { headers })).status, 404, route);
      assert.equal((await f.upgrade(headers, route)).status, 404, route);
    }
    for (const route of ['/x/../internal/desktops/test', '/%69nternal/desktops/test', '/internal%2fdesktops/test', '/%2569nternal/test', '//internal/test', '/desktop\\..\\internal/test', '/desktop/%2e%2e/internal/test']) {
      assert.equal((await f.request(route, { headers })).status, 400, route);
      assert.equal((await f.upgrade(headers, route)).status, 404, route);
    }
  }
  assert.equal(f.appRequests.length, 0);
  assert.equal(f.lookupRequests.length, 0);
  assert.equal(f.desktopRequests.length, 0);
});

test('desktop lookup rejects unexpected ports, malformed responses and oversized bodies', async t => {
  const f = await fixture(t);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie };
  for (const body of [JSON.stringify({ port: 6100 }), JSON.stringify({ port: 6106 }), JSON.stringify({ port: '6101' }), JSON.stringify({ port: 4317 }), '{}', '{broken', 'x'.repeat(1025)]) {
    f.setLookupHandler((_req, res) => res.end(body));
    assert.equal((await f.request(`${desktopA}/vnc.html`, { headers })).status, 502);
    assert.equal((await f.upgrade(headers)).status, 502);
  }
  f.setLookupHandler((_req, res) => { res.writeHead(503); res.end('unavailable'); });
  assert.equal((await f.request(`${desktopA}/vnc.html`, { headers })).status, 502);
  assert.equal(f.desktopRequests.length, 0);
});

test('a generation invalidated during the upstream handshake never opens a client tunnel', async t => {
  const f = await fixture(t);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  f.setUpgradeHandler(() => f.routes.delete(internalA));
  assert.equal((await f.upgrade({ Cookie: cookie })).status, 404);
  assert.equal(f.lookupRequests.length, 2);
  f.routes.set(internalA, f.desktopPort);
  f.setUpgradeHandler(() => f.routes.set(internalA, f.secondDesktopPort));
  assert.equal((await f.upgrade({ Cookie: cookie })).status, 404);
  assert.equal(f.lookupRequests.length, 4);
});

test('desktop lookups have a deadline and are canceled when the browser disconnects', { timeout: 5000 }, async t => {
  const f = await fixture(t, { desktopResolveTimeoutMs: 100 });
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  f.setLookupHandler(() => {});
  assert.equal((await f.request(`${desktopA}/vnc.html`, { headers: { Cookie: cookie } })).status, 502);
  assert.equal((await f.upgrade({ Cookie: cookie })).status, 502);
  let seen;
  let disconnected;
  const seenPromise = new Promise(resolve => { seen = resolve; });
  const disconnectedPromise = new Promise(resolve => { disconnected = resolve; });
  f.setLookupHandler((_req, res) => { res.once('close', disconnected); seen(); });
  const request = http.get({ hostname: '127.0.0.1', port: f.port, path: `${desktopA}/vnc.html`, headers: { Host: 'lab.example.test', Cookie: cookie } });
  request.on('error', () => {});
  await seenPromise;
  request.destroy();
  await disconnectedPromise;
  assert.equal(f.desktopRequests.length, 0);
});

test('logging out while a desktop lookup is pending prevents the request from being forwarded', async t => {
  const f = await fixture(t);
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  let received;
  const lookup = new Promise(resolve => { received = resolve; });
  f.setLookupHandler((_req, res) => received(res));
  const pending = f.request(`${desktopA}/vnc.html`, { headers: { Cookie: cookie } });
  const response = await lookup;
  assert.equal((await f.request('/logout', { method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin } })).status, 303);
  response.end(JSON.stringify({ port: f.desktopPort }));
  assert.equal((await pending).status, 401);
  assert.equal(f.desktopRequests.length, 0);
});

test('session expiry closes an already connected desktop tunnel', { timeout: 5000 }, async t => {
  const f = await fixture(t, { sessionMs: 300 });
  const cookie = (await f.login()).headers['set-cookie'][0].split(';')[0];
  const tunnel = await f.upgrade({ Cookie: cookie });
  assert.equal(tunnel.status, 101);
  await once(tunnel.socket, 'close');
  assert.equal((await f.request('/api/state', { headers: { Cookie: cookie } })).status, 401);
});
