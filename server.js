import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINKS, countryCode, makeProfile, profileInput, withStats, buildBrowserArgs } from './lib/model.js';
import { defaultDataDir, detectBrowser, probeProxy, launchBrowser, atomicSave, acquireLock } from './lib/runtime.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Error('请求必须使用 application/json。');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new Error('请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error('请求 JSON 无效。'); }
}

export function createLabServer({ dataDir = process.env.REGION_LAB_DATA_DIR || defaultDataDir(), probe = probeProxy, launch = launchBrowser, browser = detectBrowser() } = {}) {
  dataDir = resolve(dataDir);
  const release = acquireLock(dataDir);
  const file = join(dataDir, 'state.json');
  let state;
  try {
    state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, profiles: [
      makeProfile({ label: '印度 · 主环境', country: 'IN' }), makeProfile({ label: '尼日利亚 · 主环境', country: 'NG' }),
    ] };
    if (state.version !== 1 || !Array.isArray(state.profiles)) throw new Error('不支持的数据文件版本。');
    for (const p of state.profiles) {
      if (!/^[a-f0-9-]{36}$/.test(p.id) || !Array.isArray(p.checks) || !Array.isArray(p.observations) || !Array.isArray(p.launches)) throw new Error('数据文件格式有误。');
      profileInput(p);
    }
    atomicSave(file, state);
  } catch (err) { release(); throw err; }
  const token = randomBytes(32).toString('hex');
  const busy = new Set();
  const save = () => atomicSave(file, state);
  const snapshot = () => ({ version: VERSION, profiles: state.profiles.map(p => withStats(p)), browser, token, links: LINKS });

  async function check(profile) {
    let record;
    try {
      if (!profile.proxy) throw new Error('请先配置该环境的固定代理。');
      const result = await probe(profile.proxy);
      const actual = countryCode(result.country);
      const ok = actual === profile.country;
      record = { at: new Date().toISOString(), ok, ip: result.ip, country: actual,
        ...(ok ? {} : { error: `出口地区为 ${actual}，目标为 ${profile.country}。已拦截启动。` }) };
    } catch (err) { record = { at: new Date().toISOString(), ok: false, error: err.message }; }
    profile.checks.push(record);
    profile.checks = profile.checks.slice(-500);
    save();
    return record;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
      return respond(res, 403, { error: '仅允许本机同源访问。' });
    }
    let lockedId;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return respond(res, 200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const profiles = state.profiles.map(({ proxy, checks, ...p }) => ({ ...p, proxyConfigured: !!proxy, checks: checks.map(({ ip, ...c }) => c) }));
        res.setHeader('Content-Disposition', 'attachment; filename="account-region-observations.json"');
        return respond(res, 200, { exportedAt: new Date().toISOString(), note: '人工观察记录，不构成 Google 地区判定或改区资格证明。代理地址和出口 IP 已移除；备注由用户提供。', profiles });
      }
      if (['POST', 'PATCH'].includes(req.method)) {
        if (req.headers['x-lab-token'] !== token) return respond(res, 403, { error: '会话令牌无效，请刷新本地页面。' });
        const body = await readBody(req);
        if (req.method === 'POST' && url.pathname === '/api/profiles') {
          if (state.profiles.length >= 100) throw new Error('第一版最多支持 100 个环境。');
          const p = makeProfile(body);
          state.profiles.push(p); save();
          return respond(res, 201, withStats(p));
        }
        const match = /^\/api\/profiles\/([a-f0-9-]{36})(?:\/(check|launch|observations|cycle))?$/.exec(url.pathname);
        if (!match) return respond(res, 404, { error: '接口不存在。' });
        const profile = state.profiles.find(p => p.id === match[1]);
        if (!profile) return respond(res, 404, { error: '环境不存在。' });
        if (busy.has(profile.id)) return respond(res, 409, { error: '这个环境正在检测或启动，请稍后再试。' });
        lockedId = profile.id; busy.add(lockedId);
        if (req.method === 'PATCH' && !match[2]) {
          const updated = profileInput({ ...profile, ...body });
          if (updated.proxy !== profile.proxy || updated.country !== profile.country) {
            // Do not retarget a profile that might still be running with its previous proxy.
            if (profile.launches.length) throw new Error('使用过的环境不能修改目标国家或代理。请新建环境，避免旧浏览器继续使用原线路。名称仍可修改。');
            profile.checks = []; profile.cycleStartedAt = null;
          }
          Object.assign(profile, updated); save();
          return respond(res, 200, withStats(profile));
        }
        if (req.method !== 'POST') return respond(res, 405, { error: '请求方法不支持。' });
        if (match[2] === 'check') return respond(res, 200, await check(profile));
        if (match[2] === 'launch') {
          if (!Object.hasOwn(LINKS, body.target) || body.target === 'faq') throw new Error('不支持的打开目标。');
          if (!browser) throw new Error('未检测到 Chrome 或 Edge，请安装浏览器或设置 BROWSER_PATH。');
          const result = await check(profile);
          if (!result.ok) throw new Error(result.error);
          const profileDir = join(dataDir, 'profiles', profile.id);
          mkdirSync(profileDir, { recursive: true, mode: 0o700 });
          const args = buildBrowserArgs(profile, profileDir, body.target);
          await launch(browser.path, args);
          const at = new Date().toISOString();
          profile.cycleStartedAt ||= at;
          profile.launches.push({ at, target: body.target });
          profile.launches = profile.launches.slice(-500);
          save();
          return respond(res, 200, { ok: true, message: '已发送浏览器启动请求。请在浏览器内确认出口和登录账号；本次检测不代表 Google 的地区判定。', profile: withStats(profile) });
        }
        if (match[2] === 'observations') {
          const country = countryCode(body.country);
          const note = typeof body.note === 'string' ? body.note.trim() : '';
          if (note.length > 1000) throw new Error('备注最多 1000 个字符。');
          if (profile.observations.length >= 5000) throw new Error('观察记录已达到第一版上限，请先导出记录。');
          profile.observations.push({ at: new Date().toISOString(), country, note });
          save(); return respond(res, 200, withStats(profile));
        }
        if (match[2] === 'cycle') {
          profile.cycleHistory ||= [];
          if (profile.cycleStartedAt) profile.cycleHistory.push(profile.cycleStartedAt);
          profile.cycleStartedAt = new Date().toISOString();
          save(); return respond(res, 200, withStats(profile));
        }
        return respond(res, 404, { error: '接口不存在。' });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [filename, type] = assets[url.pathname];
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        return res.end(readFileSync(join(ROOT, 'public', filename)));
      }
      respond(res, 404, { error: '页面不存在。' });
    } catch (err) { respond(res, 400, { error: err.code ? '本地文件或服务操作失败，请检查程序终端。' : err.message }); }
    finally { if (lockedId) busy.delete(lockedId); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', release);
  return { server, token, close: () => new Promise((resolveClose, reject) => {
    server.close(err => { release(); err ? reject(err) : resolveClose(); });
    server.closeIdleConnections();
  }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024–65535 的端口号。');
  const lab = createLabServer();
  lab.server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : err.message); process.exitCode = 1; lab.server.close(); });
  lab.server.listen(port, '127.0.0.1', () => console.log(`Account Region Lab v${VERSION}\n本地控制台: http://127.0.0.1:${port}\n七天是观察周期，不是 Google 改区承诺。`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => lab.close().finally(() => process.exit(0)));
}
