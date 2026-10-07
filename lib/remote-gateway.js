import http from 'node:http';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const COOKIE = '__Host-region_lab_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const DESKTOP_ROUTE = /^\/desktop\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([a-f0-9]{32})\/(.*)$/;

function requestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\#\u0000-\u0020\u007f]/.test(value)) return null;
  const path = value.split('?')[0];
  // All public routes and asset names use literal ASCII paths. Reject encoded
  // separators, encoded names and dot segments before any URL normalization or
  // authentication, so an external request can never reach an internal route.
  if (path.includes('%') || path.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return null;
  return path;
}

function desktopRoute(value, path) {
  const match = DESKTOP_ROUTE.exec(path);
  if (!match) return null;
  const prefix = `/desktop/${match[1]}/${match[2]}`;
  return { profileId: match[1], generation: match[2], path: value.slice(prefix.length) };
}

function accessConfig(value) {
  if (!value || typeof value.username !== 'string' || !value.username || value.username.length > 128
      || typeof value.salt !== 'string' || !/^[a-f0-9]{32,128}$/i.test(value.salt) || value.salt.length % 2
      || typeof value.passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.passwordHash)) {
    throw new Error('远程访问认证文件格式无效。');
  }
  return { username: value.username, salt: Buffer.from(value.salt, 'hex'), passwordHash: Buffer.from(value.passwordHash, 'hex') };
}

function endpoint(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('远程网关上游必须是本机 HTTP 服务。');
  }
  return parsed;
}

function scrubHeaders(headers) {
  const result = { ...headers };
  const nominated = String(result.connection || '').toLowerCase().split(',').map(v => v.trim());
  for (const key of [...HOP, ...nominated, 'authorization', 'cookie', 'set-cookie', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'forwarded']) delete result[key];
  return result;
}

function loginPage(failed = false) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 账号地区实验室</title><style>body{font:16px system-ui;background:#f4f6fb;color:#17233d;max-width:420px;margin:12vh auto;padding:24px}main{padding:28px;background:white;border-radius:16px}h1{font-size:24px}label{display:block;margin:18px 0 6px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #aeb8cb;border-radius:8px}button{margin-top:24px;background:#294dc0;color:white;border:0;cursor:pointer}p{line-height:1.6;color:#536078}.error{color:#a12424}</style><main><h1>账号地区实验室</h1><p>登录服务器工作台，在远程桌面中操作独立浏览器。</p>${failed ? '<p class="error" role="alert">用户名或密码错误，请重试。</p>' : ''}<form method="post" action="/login"><label for="username">工作台用户名</label><input id="username" name="username" autocomplete="username" maxlength="128" required><label for="password">工作台密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button type="submit">登录工作台</button></form><p>这里填写工作台凭据。Google 账号在远程浏览器中登录。</p></main></html>`;
}

export function createRemoteGateway({
  publicOrigin = process.env.REGION_LAB_PUBLIC_ORIGIN,
  credentials = JSON.parse(readFileSync(process.env.REGION_LAB_ACCESS_FILE, 'utf8')),
  appTarget = 'http://127.0.0.1:4317', desktopResolveTimeoutMs = 3000,
  sessionMs = SESSION_MS, maxSessions = 64, now = Date.now,
} = {}) {
  let external;
  try { external = new URL(publicOrigin); } catch { throw new Error('请设置远程工作台 HTTPS 地址。'); }
  if (external.protocol !== 'https:' || external.username || external.password || external.pathname !== '/' || external.search || external.hash) {
    throw new Error('远程工作台必须使用固定 HTTPS 来源地址。');
  }
  const origin = external.origin;
  if (!Number.isInteger(sessionMs) || sessionMs < 1 || sessionMs > SESSION_MS
      || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 256
      || !Number.isInteger(desktopResolveTimeoutMs) || desktopResolveTimeoutMs < 1 || desktopResolveTimeoutMs > 15000) {
    throw new Error('远程会话限制配置无效。');
  }
  const access = accessConfig(credentials);
  const app = endpoint(appTarget);
  const sessions = new Map();
  const tunnels = new Map();
  const pendingUpstreams = new Set();
  let attempts = [];

  function readSession(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const value = cookies[0].slice(COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    const expires = sessions.get(value);
    if (!expires || expires <= now()) { sessions.delete(value); return null; }
    return value;
  }

  function forgetSession(value) {
    sessions.delete(value);
    for (const [socket, entry] of tunnels) if (entry.session === value) {
      socket.destroy(); entry.upstream.destroy();
    }
  }

  function pruneSessions() {
    for (const [value, expires] of sessions) if (expires <= now()) forgetSession(value);
  }

  function validHost(req) { return req.headers.host === external.host; }
  function sameOrigin(req) { return req.headers.origin === origin && req.headers['sec-fetch-site'] !== 'cross-site'; }
  function json(res, status, error) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error }));
  }
  function redirect(res, destination) { res.writeHead(303, { Location: destination }); res.end(); }
  function expiredCookie() { return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`; }

  function resolveDesktop(route, signal) {
    return new Promise((resolveResult, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolveResult(result);
      };
      const request = http.get({
        hostname: app.hostname, port: app.port,
        path: `/internal/desktops/${route.profileId}/${route.generation}`,
        // The application's internal endpoint rejects public Host headers.
        // No browser cookie, Origin or forwarding header belongs in this call.
        headers: { Host: app.host, Accept: 'application/json' }, agent: false, signal,
      }, response => {
        if (response.statusCode === 404) { finish(null, null); response.destroy(); return; }
        if (response.statusCode !== 200) { finish(new Error('Desktop lookup failed')); response.destroy(); return; }
        let length = 0;
        const chunks = [];
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 1024) { finish(new Error('Desktop lookup response too large')); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.once('aborted', () => finish(new Error('Desktop lookup interrupted')));
        response.once('error', error => finish(error));
        response.once('end', () => {
          if (settled) return;
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!Number.isInteger(result?.port) || result.port < 6101 || result.port > 6105) throw new Error('Invalid desktop port');
            finish(null, endpoint(`http://127.0.0.1:${result.port}`));
          } catch (error) { finish(error); }
        });
      });
      pendingUpstreams.add(request);
      request.once('close', () => pendingUpstreams.delete(request));
      request.once('error', error => finish(error));
      timer = setTimeout(() => request.destroy(new Error('Desktop lookup timed out')), desktopResolveTimeoutMs);
      timer.unref();
    });
  }

  async function login(req, res) {
    attempts = attempts.filter(at => now() - at < 60000);
    if (attempts.length >= 10) { res.setHeader('Retry-After', '60'); return json(res, 429, '登录尝试过多，请稍后重试。'); }
    attempts.push(now());
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return json(res, 415, '登录表单格式无效。');
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8192) return json(res, 413, '登录表单过长。');
      chunks.push(chunk);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const username = form.get('username') || '';
    const password = form.get('password') || '';
    if (username.length > 128 || password.length > 1024 || form.getAll('username').length !== 1 || form.getAll('password').length !== 1) return json(res, 400, '登录表单格式无效。');
    const hash = await derive(password, access.salt, 32);
    const nameHash = createHash('sha256').update(username).digest();
    const expectedNameHash = createHash('sha256').update(access.username).digest();
    const validPassword = timingSafeEqual(hash, access.passwordHash);
    const validUsername = timingSafeEqual(nameHash, expectedNameHash);
    if (!validPassword || !validUsername) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage(true));
    }
    pruneSessions();
    const previous = readSession(req);
    if (previous) forgetSession(previous);
    while (sessions.size >= maxSessions) forgetSession(sessions.keys().next().value);
    const value = randomBytes(32).toString('hex');
    sessions.set(value, now() + sessionMs);
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionMs / 1000)}`);
    redirect(res, '/');
  }

  function headersFor(req, upstream, isDesktop, upgrade = false) {
    const headers = scrubHeaders(req.headers);
    headers.host = isDesktop ? upstream.host : external.host;
    headers['x-forwarded-proto'] = 'https';
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }

  function proxyHttp(req, res, desktop = null) {
    const upstream = desktop?.upstream || app;
    const upstreamRequest = http.request({
      hostname: upstream.hostname, port: upstream.port, method: req.method,
      path: desktop?.route.path || req.url,
      headers: headersFor(req, upstream, Boolean(desktop)),
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode, scrubHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
      upstreamResponse.on('error', () => res.destroy());
    });
    pendingUpstreams.add(upstreamRequest);
    upstreamRequest.once('close', () => pendingUpstreams.delete(upstreamRequest));
    upstreamRequest.setTimeout(130000, () => upstreamRequest.destroy());
    upstreamRequest.on('error', () => { if (!res.headersSent) json(res, 502, '服务器工作台暂时不可用，请稍后重试。'); else res.destroy(); });
    req.once('aborted', () => upstreamRequest.destroy());
    res.once('close', () => { if (!res.writableFinished) upstreamRequest.destroy(); });
    req.pipe(upstreamRequest);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!validHost(req)) return json(res, 403, '访问地址无效。');
      const path = requestPath(req.url);
      if (path === null) return json(res, 400, '请求路径无效。');
      if (/^\/internal(?:\/|$)/i.test(path)) return json(res, 404, '页面不存在。');
      const url = new URL(req.url, origin);
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return json(res, 405, '请求方法不支持。');
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return json(res, 403, '仅允许工作台同源操作。');
      if (url.pathname === '/login') {
        // A no-referrer policy makes Chrome send Origin: null for a form POST.
        // Keep the genuine same-origin form navigation compatible with the
        // exact Origin validation below instead of accepting opaque origins.
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (readSession(req)) return redirect(res, '/');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(req.method === 'HEAD' ? '' : loginPage());
        }
        if (req.method === 'POST') return await login(req, res);
        return json(res, 405, '请求方法不支持。');
      }
      const session = readSession(req);
      if (!session) {
        if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) return json(res, 401, '请先登录工作台。');
        return redirect(res, '/login');
      }
      if (url.pathname === '/logout') {
        if (req.method !== 'POST') return json(res, 405, '请通过退出按钮登出。');
        forgetSession(session);
        res.setHeader('Set-Cookie', expiredCookie());
        return redirect(res, '/login');
      }
      if (path === '/desktop' || path.startsWith('/desktop/')) {
        const route = desktopRoute(req.url, path);
        if (!route) return json(res, 404, '远程环境地址无效，请从工作台重新打开。');
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, '请求方法不支持。');
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        let upstream;
        try { upstream = await resolveDesktop(route, controller.signal); }
        catch {
          if (!res.destroyed) json(res, 502, '无法连接远程环境，请稍后重试。');
          return;
        } finally { req.off('aborted', abort); res.off('close', abort); }
        if (res.destroyed || req.aborted) return;
        if (!readSession(req)) return json(res, 401, '请重新登录工作台。');
        if (!upstream) return json(res, 404, '这个远程环境已关闭，请从工作台重新打开。');
        return proxyHttp(req, res, { route, upstream });
      }
      proxyHttp(req, res);
    } catch {
      if (!res.headersSent) json(res, 400, '请求无法处理，请重试。');
      else res.destroy();
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    function deny(status) { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    if (!validHost(req) || !sameOrigin(req)) return deny('403 Forbidden');
    const path = requestPath(req.url);
    if (path === null || /^\/internal(?:\/|$)/i.test(path)) return deny('404 Not Found');
    const session = readSession(req);
    if (!session) return deny('401 Unauthorized');
    const route = desktopRoute(req.url, path);
    if (req.method !== 'GET' || !route || route.path.split('?')[0] !== '/websockify'
        || String(req.headers.upgrade).toLowerCase() !== 'websocket') return deny('404 Not Found');
    const controller = new AbortController();
    const abort = () => controller.abort();
    socket.once('error', abort);
    socket.once('close', abort);
    let desktop;
    try { desktop = await resolveDesktop(route, controller.signal); }
    catch { return deny('502 Bad Gateway'); }
    if (socket.destroyed) return;
    if (!readSession(req)) return deny('401 Unauthorized');
    if (!desktop) return deny('404 Not Found');
    const upstreamRequest = http.request({
      hostname: desktop.hostname, port: desktop.port, method: 'GET',
      path: route.path, headers: headersFor(req, desktop, true, true),
    });
    pendingUpstreams.add(upstreamRequest);
    upstreamRequest.once('close', () => pendingUpstreams.delete(upstreamRequest));
    upstreamRequest.setTimeout(15000, () => upstreamRequest.destroy());
    upstreamRequest.once('error', () => { if (!socket.destroyed) deny('502 Bad Gateway'); });
    upstreamRequest.once('response', response => { response.resume(); deny('502 Bad Gateway'); });
    upstreamRequest.once('upgrade', async (response, upstreamSocket, upstreamHead) => {
      upstreamSocket.setTimeout(0);
      upstreamSocket.pause();
      // Attach an error handler while the second lookup is pending. A browser
      // or desktop can close between the initial lookup and the TCP handshake.
      const earlyError = () => { upstreamSocket.destroy(); socket.destroy(); };
      const earlyClose = () => { socket.destroy(); };
      upstreamSocket.once('error', earlyError);
      upstreamSocket.once('close', earlyClose);
      if (!readSession(req) || socket.destroyed) { upstreamSocket.destroy(); return socket.destroy(); }
      if (response.statusCode !== 101) { upstreamSocket.destroy(); return deny('502 Bad Gateway'); }
      let current;
      try { current = await resolveDesktop(route, controller.signal); }
      catch { upstreamSocket.destroy(); return deny('502 Bad Gateway'); }
      if (socket.destroyed || upstreamSocket.destroyed) return upstreamSocket.destroy();
      if (!readSession(req)) { upstreamSocket.destroy(); return deny('401 Unauthorized'); }
      // A reused port must never attach an old environment URL to a new one.
      // Validate after TCP connects and before sending any desktop bytes. Once
      // connected, this socket cannot be redirected to a replacement process.
      if (!current || current.port !== desktop.port) { upstreamSocket.destroy(); return deny('404 Not Found'); }
      upstreamSocket.off('error', earlyError);
      upstreamSocket.off('close', earlyClose);
      const headers = scrubHeaders(response.headers);
      headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
      const responseHeaders = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(v => `${name}: ${v}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      const timer = setTimeout(() => { socket.destroy(); upstreamSocket.destroy(); }, Math.max(1, sessions.get(session) - now()));
      timer.unref();
      tunnels.set(socket, { upstream: upstreamSocket, session });
      const cleanup = () => { clearTimeout(timer); tunnels.delete(socket); socket.destroy(); upstreamSocket.destroy(); };
      socket.once('error', cleanup); upstreamSocket.once('error', cleanup);
      socket.once('close', cleanup); upstreamSocket.once('close', cleanup);
      socket.pipe(upstreamSocket); upstreamSocket.pipe(socket);
    });
    socket.once('error', () => upstreamRequest.destroy());
    socket.once('close', () => upstreamRequest.destroy());
    upstreamRequest.end();
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 15000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  let stopping;
  function close() {
    return stopping ||= (async () => {
      for (const entry of [...sessions.keys()]) forgetSession(entry);
      for (const request of pendingUpstreams) request.destroy();
      if (!server.listening) return;
      await new Promise((done, reject) => {
        server.close(error => error ? reject(error) : done());
        server.closeAllConnections();
      });
    })();
  }
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.GATEWAY_PORT || process.env.REGION_LAB_GATEWAY_PORT || 4318);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('网关端口无效。');
    const gateway = createRemoteGateway();
    gateway.server.on('error', () => { console.error('远程访问网关无法监听端口。'); process.exitCode = 1; });
    gateway.server.listen(port, '127.0.0.1', () => console.log('远程访问网关已启动。'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => gateway.close().finally(() => process.exit(0)));
  } catch { console.error('远程访问网关配置无效，请检查服务配置和认证文件。'); process.exitCode = 1; }
}
