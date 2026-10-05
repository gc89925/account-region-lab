import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { LINKS, countryCode, makeProfile, profileInput, withStats, buildBrowserArgs, targetUrl } from './lib/model.js';
import { defaultDataDir, detectBrowser, probeProxy, launchBrowser, atomicSave, acquireLock } from './lib/runtime.js';
import { createManagedLauncher } from './lib/managed.js';
import { createCatalog } from './lib/catalog.js';
import { createPublicProxyCatalog } from './lib/public-proxies.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.2.2';

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

export function createLabServer({ dataDir = process.env.REGION_LAB_DATA_DIR || defaultDataDir(), probe = probeProxy, launch = launchBrowser, browser = detectBrowser(), managed = createManagedLauncher(), catalog = createCatalog(), publicProxies = createPublicProxyCatalog() } = {}) {
  dataDir = resolve(dataDir);
  const workspaceId = createHash('sha256').update(process.platform === 'win32' ? dataDir.toLowerCase() : dataDir).digest('hex').slice(0,24);
  const instanceId = randomBytes(12).toString('hex');
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
      const normalized = profileInput({ ...p, strictIp: p.strictIp ?? false });
      Object.assign(p, normalized);
      p.deviceReviews ||= [];
      p.expectedIp ||= null;
      if (!Array.isArray(p.deviceReviews) || (p.expectedIp && !isIP(p.expectedIp))) throw new Error('数据文件格式有误。');
    }
    atomicSave(file, state);
  } catch (err) { release(); throw err; }
  const token = randomBytes(32).toString('hex');
  const busy = new Set();
  const accountBusy = new Set();
  const save = () => atomicSave(file, state);
  const displayProfile = p => ({ ...withStats(p), locked: p.launches.length > 0, session: { active: managed.isActive(p.id), managed: p.environment.engine === 'managed' }, network: {
    checkCount: p.checks.length,
    uniqueIps: new Set(p.checks.filter(c => c.ip).map(c => c.ip)).size,
    lastCheckedAt: p.checks.at(-1)?.at || null,
  } });
  const snapshot = () => ({ version: VERSION, profiles: state.profiles.map(displayProfile), browser, token, links: LINKS, capabilities: { managed: true, devices: 'manual-review', catalog: 'VPN Gate metadata only' } });

  async function check(profile) {
    let record;
    try {
      if (!profile.proxy) throw new Error('请先配置该环境的固定代理。');
      const result = await probe(profile.proxy);
      if (!isIP(result.ip)) throw new Error('出口检测没有返回有效 IP，已拦截启动。');
      const actual = countryCode(result.country);
      const changedIp = profile.strictIp && profile.expectedIp && profile.expectedIp !== result.ip;
      const ok = actual === profile.country && !changedIp;
      record = { at: new Date().toISOString(), ok, ip: result.ip, country: actual,
        ...(Number.isFinite(result.latencyMs) ? { latencyMs: result.latencyMs } : {}),
        ...(ok ? {} : { error: changedIp ? '出口 IP 与该环境固定绑定值不同，已拦截启动。请恢复原线路，或新建环境。' : `出口地区为 ${actual}，目标为 ${profile.country}。已拦截启动。` }) };
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
    let lockedId, lockedAccount;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return respond(res, 200, { app: 'account-region-lab', version: VERSION, ready: true, workspaceId, instanceId });
      if (req.method === 'GET' && url.pathname === '/api/state') return respond(res, 200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/proxies') return respond(res,200,await publicProxies.list((url.searchParams.get('country') || 'ALL').toUpperCase()));
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        const requested = (url.searchParams.get('country') || 'ALL').toUpperCase();
        return respond(res, 200, await catalog.list(requested === 'ALL' ? 'ALL' : countryCode(requested)));
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const profiles = state.profiles.map(({ proxy, expectedIp, accountLabel, checks, ...p }) => ({ ...p, proxyConfigured: !!proxy, checks: checks.map(({ ip, ...c }) => c) }));
        res.setHeader('Content-Disposition', 'attachment; filename="account-region-observations.json"');
        return respond(res, 200, { exportedAt: new Date().toISOString(), note: '人工观察记录，不构成 Google 地区判定或改区资格证明。代理地址和出口 IP 已移除；备注由用户提供。', profiles });
      }
      if (['POST', 'PATCH'].includes(req.method)) {
        if (req.headers['x-lab-token'] !== token) return respond(res, 403, { error: '会话令牌无效，请刷新本地页面。' });
        const body = await readBody(req);
        if (req.method === 'POST' && url.pathname === '/api/shutdown') {
          if (body.instanceId !== instanceId) return respond(res,409,{error:'实例已变化，请重新尝试停止。'});
          res.once('finish', () => setImmediate(() => close().catch(() => console.error('Unable to close the local service cleanly.'))));
          return respond(res,202,{ok:true});
        }
        if (req.method === 'POST' && url.pathname === '/api/proxies/check') return respond(res,200,await publicProxies.check(body.id,body.country));
        if (req.method === 'POST' && url.pathname === '/api/profiles') {
          if (state.profiles.length >= 100) throw new Error('第一版最多支持 100 个环境。');
          const p = makeProfile(body);
          state.profiles.push(p); save();
          return respond(res, 201, withStats(p));
        }
        const match = /^\/api\/profiles\/([a-f0-9-]{36})(?:\/(check|launch|observations|cycle|device-review|close))?$/.exec(url.pathname);
        if (!match) return respond(res, 404, { error: '接口不存在。' });
        const profile = state.profiles.find(p => p.id === match[1]);
        if (!profile) return respond(res, 404, { error: '环境不存在。' });
        if (busy.has(profile.id)) return respond(res, 409, { error: '这个环境正在检测或启动，请稍后再试。' });
        lockedId = profile.id; busy.add(lockedId);
        if (req.method === 'PATCH' && !match[2]) {
          const updated = profileInput({ ...profile, ...body });
          if (updated.accountLabel !== profile.accountLabel && managed.isActive(profile.id)) throw new Error('请先关闭受控环境，再修改账号代号。');
          if (updated.proxy !== profile.proxy || updated.country !== profile.country || JSON.stringify(updated.environment) !== JSON.stringify(profile.environment) || updated.strictIp !== profile.strictIp) {
            // Do not retarget a profile that might still be running with its previous proxy.
            if (profile.launches.length) throw new Error('使用过的环境已固定网络和环境参数。请新建环境，避免旧浏览器继续使用原配置。名称仍可修改。');
            profile.checks = []; profile.cycleStartedAt = null; profile.expectedIp = null;
          }
          Object.assign(profile, updated); save();
          return respond(res, 200, withStats(profile));
        }
        if (req.method !== 'POST') return respond(res, 405, { error: '请求方法不支持。' });
        if (match[2] === 'check') return respond(res, 200, await check(profile));
        if (match[2] === 'close') {
          if (profile.environment.engine !== 'managed') throw new Error('原生模式请直接关闭对应浏览器窗口。本工具不能可靠追踪原生会话。');
          const closed = await managed.close(profile.id);
          if (closed?.ok === false) throw new Error('受控环境未能关闭，请手动关闭该环境窗口并刷新状态。');
          return respond(res, 200, { ok: true, message: '受控环境已关闭。Google 在其他设备上的登录不受此操作影响。' });
        }
        if (match[2] === 'launch') {
          const destination = targetUrl(profile, body.target);
          if (!browser) throw new Error('未检测到 Chrome 或 Edge，请安装浏览器或设置 BROWSER_PATH。');
          if (!profile.proxy) throw new Error('请先设置代理，再打开该环境。诊断页不访问外网，但会固定该环境的网络设置。');
          const accountKey = profile.accountLabel.toLowerCase();
          if (accountKey) {
            if (accountBusy.has(accountKey) || state.profiles.some(p => p.id !== profile.id && p.accountLabel.toLowerCase() === accountKey && managed.isActive(p.id))) throw new Error('同一账号代号已有受控环境运行或启动中。请先关闭它。此限制只覆盖本工具的受控环境。');
            accountBusy.add(accountKey); lockedAccount = accountKey;
          }
          let result;
          if (body.target !== 'diagnostics') {
            result = await check(profile);
            if (!result.ok) throw new Error(result.error);
          }
          const profileDir = join(dataDir, 'profiles', profile.id);
          mkdirSync(profileDir, { recursive: true, mode: 0o700 });
          let opening;
          if (profile.environment.engine === 'managed') {
            opening = await managed.open({ profile, profileDir, browserPath: browser.path, url: destination });
          } else {
            const args = buildBrowserArgs(profile, profileDir, body.target);
            opening = await launch(browser.path, args);
          }
          if (opening?.ok === false && !opening.active) throw new Error('受控环境打开失败，请检查浏览器和代理设置。');
          const at = new Date().toISOString();
          if (result) {
            profile.cycleStartedAt ||= at;
            if (profile.strictIp) profile.expectedIp ||= result.ip;
          }
          profile.launches.push({ at, target: body.target });
          profile.launches = profile.launches.slice(-500);
          save();
          if (opening?.ok === false) throw new Error('浏览器已启动，但目标页面未加载成功。环境设置已固定；可关闭受控环境后检查线路重试。');
          return respond(res, 200, { ok: true, message: `已向本机 ${browser.name} 打开此环境。请切换到弹出的独立浏览器窗口完成 Google 登录；登录表单不在工作台内。本工具尚未确认登录状态。`, profile: withStats(profile) });
        }
        if (match[2] === 'device-review') {
          if (typeof body.otherSessionsSignedOut !== 'boolean' || typeof body.currentSessionKept !== 'boolean') throw new Error('请明确填写设备核查结果。');
          const note = typeof body.note === 'string' ? body.note.trim() : '';
          if (note.length > 1000 || profile.deviceReviews.length >= 1000) throw new Error('设备核查备注或记录超出上限。');
          profile.deviceReviews.push({ at: new Date().toISOString(), otherSessionsSignedOut: body.otherSessionsSignedOut, currentSessionKept: body.currentSessionKept, note, source: 'user-confirmed' });
          save(); return respond(res, 200, displayProfile(profile));
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
    finally { if (lockedId) busy.delete(lockedId); if (lockedAccount) accountBusy.delete(lockedAccount); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', release);
  let closing;
  const close = () => closing ||= (async () => {
    await managed.closeAll();
    if (!server.listening) { release(); return; }
    return new Promise((resolveClose, reject) => {
      server.close(err => { release(); err ? reject(err) : resolveClose(); });
      server.closeIdleConnections();
    });
  })();
  return { server, token, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024–65535 的端口号。');
  const lab = createLabServer();
  lab.server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : err.message); process.exitCode = 1; lab.server.close(); });
  lab.server.listen(port, '127.0.0.1', () => console.log(`Account Region Lab v${VERSION}\n本地控制台: http://127.0.0.1:${port}\n七天是观察周期，不是 Google 改区承诺。`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => lab.close().finally(() => process.exit(0)));
}
