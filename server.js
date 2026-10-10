import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { LINKS, countryCode, makeProfile, profileInput, withStats, buildBrowserArgs, targetUrl, validateProxy } from './lib/model.js';
import { defaultDataDir, detectBrowser, probeProxy, probeGoogle, probeDestination, diagnoseProxy, launchBrowser, atomicSave, acquireLock } from './lib/runtime.js';
import { createManagedLauncher } from './lib/managed.js';
import { createCatalog } from './lib/catalog.js';
import { createPublicProxyCatalog } from './lib/public-proxies.js';
import { createCredentialVault, validateProxyAuth } from './lib/proxy-auth.js';
import { createSocksBridge } from './lib/socks-bridge.js';
import { createRemoteLauncher } from './lib/remote-browser.js';
import { inspectProxySession, prepareProxySession, applyProxySessionOptions } from './public/proxy-session.js';
import { sampleProxyStability, createStabilityHistory } from './lib/proxy-stability.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.9.0';

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

export function createLabServer({ dataDir = process.env.REGION_LAB_DATA_DIR || defaultDataDir(), probe = probeProxy, google = probeGoogle, destinationProbe = probeDestination, diagnose = diagnoseProxy, launch = launchBrowser, browser = detectBrowser(), managed = createManagedLauncher(), catalog = createCatalog(), publicProxies = createPublicProxyCatalog(), vault, createBridge = createSocksBridge, remoteMode = process.env.REGION_LAB_REMOTE === '1', publicOrigin = process.env.REGION_LAB_PUBLIC_ORIGIN || '', maxRemoteEnvironments = Number(process.env.REGION_LAB_MAX_ENVIRONMENTS || 5), remote } = {}) {
  dataDir = resolve(dataDir);
  if (!Number.isInteger(maxRemoteEnvironments) || maxRemoteEnvironments < 1 || maxRemoteEnvironments > 5) throw new Error('服务器并发环境数必须是 1–5。');
  remote ||= createRemoteLauncher({maxEnvironments:maxRemoteEnvironments});
  if (remoteMode) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('服务器模式需要配置 HTTPS 公共访问地址。'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin || parsed.username || parsed.password) throw new Error('服务器模式需要不含路径的 HTTPS 公共访问地址。');
  }
  const workspaceId = createHash('sha256').update(process.platform === 'win32' ? dataDir.toLowerCase() : dataDir).digest('hex').slice(0,24);
  const instanceId = randomBytes(12).toString('hex');
  const release = acquireLock(dataDir);
  vault ||= createCredentialVault(remoteMode ? {keyPath:join(dataDir, 'proxy-vault.key')} : {});
  const file = join(dataDir, 'state.json');
  const effectiveInput = input => remoteMode ? { ...input, environment:{ ...input.environment, engine:'native' } } : input;
  let state;
  try {
    state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, profiles: [
      makeProfile({ label: '印度 · 主环境', country: 'IN' }), makeProfile({ label: '尼日利亚 · 主环境', country: 'NG' }),
    ] };
    if (state.version !== 1 || !Array.isArray(state.profiles)) throw new Error('不支持的数据文件版本。');
    for (const p of state.profiles) {
      if (!/^[a-f0-9-]{36}$/.test(p.id) || !Array.isArray(p.checks) || !Array.isArray(p.observations) || !Array.isArray(p.launches)) throw new Error('数据文件格式有误。');
      const normalized = profileInput(effectiveInput({ ...p, strictIp: p.strictIp ?? false }));
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
  const launching = new Set();
  const bridges = new Map();
  const bridgeStarts = new Map();
  const sessionSummaries = new Map();
  const stabilityHistory = createStabilityHistory();
  const diagnosingProfiles = new Set();
  let diagnosticsActive = 0;
  const diagnosisKey = (proxy,auth,country,strictIp) => createHash('sha256').update(token).update(JSON.stringify([proxy,auth?.username,auth?.password,country,strictIp])).digest('hex');
  const save = () => atomicSave(file, state);
  const sessionActive = id => remoteMode ? remote.isActive(id) : managed.isActive(id);
  const settingsLocked = profile => sessionActive(profile.id) || launching.has(profile.id) ||
    (!remoteMode && profile.environment.engine !== 'managed' && profile.launches.length > 0);
  const desktopFor = id => {
    const desktop = remoteMode ? remote.getDesktop?.(id) : null;
    return desktop && Number.isInteger(desktop.port) && desktop.port >= 6101 && desktop.port <= 6105 && /^[a-f0-9]{32}$/.test(desktop.generation) ? desktop : null;
  };
  const displayProfile = p => { const { proxyAuth, proxySession: _storedSummary, ...visible } = withStats(p); const desktop = desktopFor(p.id); return ({ ...visible, proxySession: sessionSummaries.get(p.id)?.summary || null, proxyAuthConfigured: !!proxyAuth, locked: settingsLocked(p), session: { active: sessionActive(p.id), managed: remoteMode || p.environment.engine === 'managed', ...(remoteMode ? {
    starting: !desktop && launching.has(p.id),
    desktopUrl: desktop ? `/desktop/${p.id}/${desktop.generation}/vnc.html?autoconnect=true&resize=scale&path=desktop/${p.id}/${desktop.generation}/websockify` : null,
  } : {}) }, network: {
    checkCount: p.checks.length,
    uniqueIps: new Set(p.checks.filter(c => c.ip).map(c => c.ip)).size,
    lastCheckedAt: p.checks.at(-1)?.at || null,
  } }); };
  const snapshot = async () => {
    await Promise.all(state.profiles.map(async p => {
      const cached = sessionSummaries.get(p.id);
      if (cached?.envelope === p.proxyAuth && cached?.proxy === p.proxy) return;
      try { sessionSummaries.set(p.id, { envelope:p.proxyAuth, proxy:p.proxy, summary:inspectProxySession(p.proxy, p.proxyAuth ? await vault.open(p.proxyAuth) : null) }); }
      catch { sessionSummaries.set(p.id, { envelope:p.proxyAuth, proxy:p.proxy, summary:null }); }
    }));
    const profiles = state.profiles.map(displayProfile);
    return { version: VERSION, profiles, browser, token, links: LINKS, ...(remoteMode ? {remoteSessions:{limit:maxRemoteEnvironments, active:profiles.filter(p => p.session.desktopUrl).length, starting:profiles.filter(p => p.session.starting).length}} : {}), capabilities: { remoteBrowser:remoteMode, ...(remoteMode ? {maxRemoteEnvironments} : {}), managed: !remoteMode, devices: 'manual-review', catalog: 'VPN Gate metadata only' } };
  };

  async function readAuth(body, profile, proxy) {
    if (body.clearProxyAuth === true) return null;
    const hasInput = Object.hasOwn(body, 'proxyUsername') || Object.hasOwn(body, 'proxyPassword');
    if (!hasInput && !profile?.proxyAuth) return null;
    const username = body.proxyUsername ?? profile?.proxyUsername ?? '';
    const password = body.proxyPassword ?? '';
    if (typeof username !== 'string' || typeof password !== 'string') throw new Error('代理用户名和密码格式无效。');
    if (!username && !password && !profile?.proxyAuth) return null;
    if (new URL(proxy).protocol !== 'socks5:') throw new Error('用户名密码认证目前支持 SOCKS5。HTTP 认证请先在本地客户端配置。');
    if (!password && profile?.proxyAuth && username === profile.proxyUsername) {
      if (profile.proxy !== proxy) throw new Error('代理地址已改变，请重新输入密码，避免把原认证发送到其他代理。');
      return vault.open(profile.proxyAuth);
    }
    return validateProxyAuth(username, password);
  }

  async function saveAuth(body, profile, proxy, settings) {
    // Clearing an expired endpoint must also forget its saved credentials.
    if (!proxy) return { proxyUsername: '', proxyAuth: null };
    const auth = await readEffectiveAuth(body, profile, proxy);
    if (body.clearProxyAuth === true) return { proxyUsername:'', proxyAuth:null };
    const prepared = prepareProxySession(proxy, auth, settings);
    if (!prepared.auth) return { proxyUsername: '', proxyAuth: null };
    const effective = prepared.auth;
    const previous = profile?.proxyAuth ? await vault.open(profile.proxyAuth) : null;
    const unchanged = previous && previous.username === effective.username && previous.password === effective.password;
    return { proxyUsername: effective.username, proxyAuth: unchanged ? profile.proxyAuth : await vault.seal(effective) };
  }

  async function readEffectiveAuth(body, profile, proxy) {
    const auth = await readAuth(body, profile, proxy);
    if (!Object.hasOwn(body, 'proxyOptions')) return auth;
    const updates = body.proxyOptions;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('IPRoyal 高级参数必须是字段对象。');
    if (!Object.keys(updates).length) return auth;
    if (body.clearProxyAuth === true) throw new Error('清除认证时不能同时修改 IPRoyal 参数。请重新粘贴完整代理后编辑。');
    return applyProxySessionOptions(proxy, auth, updates);
  }

  async function connection(profile) {
    if (!profile.proxyAuth) return { proxy: profile.proxy };
    if (bridges.has(profile.id)) return bridges.get(profile.id);
    if (!bridgeStarts.has(profile.id)) bridgeStarts.set(profile.id, (async () => {
      const auth = await vault.open(profile.proxyAuth);
      const prepared = prepareProxySession(profile.proxy, auth, profile);
      if (prepared.changed) throw new Error('此 IPRoyal 环境尚未启用固定会话断线保护。请关闭环境、重新诊断并保存代理配置，再启动浏览器。');
      const bridge = await createBridge(profile.proxy, auth, {port:profile.proxyBridgePort || 0});
      bridges.set(profile.id, bridge);
      // Chrome may keep the original proxy flags in an existing process.
      // Reuse this loopback port after service restart for that same profile.
      profile.proxyBridgePort = Number(new URL(bridge.proxy).port);
      save();
      return bridge;
    })().finally(() => bridgeStarts.delete(profile.id)));
    return bridgeStarts.get(profile.id);
  }

  function probeDetail(error, network) {
    // The caller can time out before the bridge sees its socket close. Keep
    // that original cause instead of replacing it with the resulting close.
    if (error.diagnostic?.code === 'proxy_timeout' && ['proxy_closed', 'proxy_connect_failed'].includes(network?.lastError?.code)) return error.diagnostic;
    return network?.lastError || error.diagnostic;
  }

  async function check(profile, target = 'signin') {
    let record;
    let network;
    try {
      if (!profile.proxy) throw new Error('请先配置该环境的固定代理。');
      network = await connection(profile);
      const result = await probe(network.proxy);
      if (!isIP(result.ip)) throw new Error('出口检测没有返回有效 IP，已拦截启动。');
      const actual = countryCode(result.country);
      const changedIp = profile.strictIp && profile.expectedIp && profile.expectedIp !== result.ip;
      let ok = actual === profile.country && !changedIp;
      let stability;
      if (ok && profile.strictIp && new URL(profile.proxy).hostname === 'geo.iproyal.com') {
        stability = await sampleProxyStability(network.proxy, {first:result,probe});
        const auth = profile.proxyAuth ? await vault.open(profile.proxyAuth) : null;
        Object.assign(stability, stabilityHistory.compare(diagnosisKey(profile.proxy,auth,profile.country,profile.strictIp),stability));
        ok = stability.stable && stability.complete && !stability.changedSincePrevious;
      }
      record = { at: new Date().toISOString(), ok, ip: result.ip, country: actual,
        ...(Number.isFinite(result.latencyMs) ? { latencyMs: result.latencyMs } : {}),
        ...(stability ? {stability} : {}),
        ...(ok ? {} : { error: changedIp ? '出口 IP 与该环境固定绑定值不同，已拦截启动。请关闭环境后检查线路，确认更换代理时重新保存配置。' : stability ? '连续出口检查发现 IP 变化或采样未完成，已拦截启动。请核对完整固定会话参数。' : `出口地区为 ${actual}，目标为 ${profile.country}。已拦截启动。` }) };
      if (ok) {
        const destination = await destinationProbe(network.proxy, targetUrl(profile, target));
        Object.assign(record, {target, targetReachable:destination.ok === true, targetHttpStatus:destination.httpStatus ?? null});
        if (!destination.ok) {
          const detail = probeDetail({diagnostic:destination.diagnostic}, network);
          Object.assign(record, {ok:false, error:`出口国家检查通过，但 Google 目标页面连接失败：${detail?.message || destination.error || 'HTTPS 请求未通过。'} 未启动浏览器。`, ...(detail ? {diagnostic:detail} : {})});
        }
      }
    } catch (err) { const detail = probeDetail(err, network); record = { ...(record || {}), at: new Date().toISOString(), ok: false, error: detail?.message || err.message, ...(detail ? { diagnostic: detail } : {}) }; }
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map(h => `http://${h}`);
    if (remoteMode) { hosts.push(new URL(publicOrigin).host); origins.push(publicOrigin); }
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
      return respond(res, 403, { error: '仅允许本机同源访问。' });
    }
    let lockedId, lockedAccount;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/internal/')) {
        // Only the loopback gateway may resolve a current desktop. Public
        // requests retain the public Host and are also blocked by the gateway.
        if (!remoteMode || !hosts.slice(0,2).includes(req.headers.host) || req.headers.origin || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return respond(res,403,{error:'内部接口不可从工作台访问。'});
        const route = /^\/internal\/desktops\/([a-f0-9-]{36})\/([a-f0-9]{32})$/.exec(url.pathname);
        const desktop = req.method === 'GET' && route ? desktopFor(route[1]) : null;
        if (!desktop || desktop.generation !== route[2]) return respond(res,404,{error:'该环境画面已关闭，请重新打开。'});
        return respond(res,200,{port:desktop.port});
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return respond(res, 200, { app: 'account-region-lab', version: VERSION, ready: true, workspaceId, instanceId });
      if (req.method === 'GET' && url.pathname === '/api/state') return respond(res, 200, await snapshot());
      if (req.method === 'GET' && url.pathname === '/api/proxies') return respond(res,200,await publicProxies.list((url.searchParams.get('country') || 'ALL').toUpperCase()));
      if (req.method === 'GET' && url.pathname === '/api/proxies/scan') return respond(res,200,publicProxies.scanStatus());
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        const requested = (url.searchParams.get('country') || 'ALL').toUpperCase();
        return respond(res, 200, await catalog.list(requested === 'ALL' ? 'ALL' : countryCode(requested)));
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const profiles = state.profiles.map(({ proxy, proxyAuth, proxyUsername, expectedIp, accountLabel, checks, ...p }) => ({ ...p, proxyConfigured: !!proxy, checks: checks.map(({ ip, stability, ...c }) => ({...c,...(stability ? {stability:{stable:stability.stable,complete:stability.complete,uniqueIpCount:stability.uniqueIps.length}} : {})})) }));
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
        if (req.method === 'POST' && url.pathname === '/api/proxies/scan') return respond(res,202,await publicProxies.startScan(body.country || 'ALL',{limit:body.limit}));
        if (req.method === 'POST' && url.pathname === '/api/proxies/scan/cancel') return respond(res,200,publicProxies.cancelScan());
        if (req.method === 'POST' && url.pathname === '/api/proxy/diagnose') {
          if (diagnosticsActive >= 3) return respond(res,429,{error:'已有 3 个诊断正在运行，请稍候。'});
          const proxy = validateProxy(body.proxy);
          if (!proxy) throw new Error('请先填写代理地址。');
          const country = countryCode(body.country);
          const existing = body.profileId ? state.profiles.find(p => p.id === body.profileId) : null;
          if (body.profileId && !existing) throw new Error('环境不存在，请刷新页面。');
          if (body.strictIp !== undefined && typeof body.strictIp !== 'boolean') throw new Error('固定出口选项必须是布尔值。');
          if (existing && (busy.has(existing.id) || diagnosingProfiles.has(existing.id))) return respond(res,409,{error:'这个环境正在检测或修改，请稍后再试。'});
          if (existing) diagnosingProfiles.add(existing.id);
          diagnosticsActive++;
          let temporary;
          try {
            const strictIp = body.strictIp ?? existing?.strictIp ?? true;
            const prepared = prepareProxySession(proxy, await readEffectiveAuth(body, existing, proxy), {strictIp,country});
            const auth = prepared.auth;
            if (auth) temporary = await createBridge(proxy, auth);
            const tested = temporary?.proxy || proxy;
            const result = await diagnose(tested, {tryAlternateProtocol: !auth});
            result.session = {...prepared.session, protectionApplied:prepared.changed};
            result.configuredProtocol = new URL(proxy).protocol.slice(0,-1);
            if (!result.ok && temporary?.lastError) result.error = probeDetail({diagnostic:result.error}, temporary);
            if (result.ok) {
              result.stability = await sampleProxyStability(tested, {first:result.probe,probe});
              const historyKey = diagnosisKey(proxy,auth,country,strictIp);
              Object.assign(result.stability, stabilityHistory.compare(historyKey,result.stability));
              result.targetCountryMatches = result.stability.samples.every(sample => sample.ok && sample.country === country);
              const savedAuth = existing?.proxyAuth ? await vault.open(existing.proxyAuth) : null;
              const sameConfiguration = existing?.proxy === proxy && savedAuth?.username === auth?.username && savedAuth?.password === auth?.password;
              result.binding = {expectedIp:strictIp && sameConfiguration ? existing.expectedIp : null};
              result.binding.matches = !result.binding.expectedIp || result.stability.samples.every(sample => sample.ok && sample.ip === result.binding.expectedIp);
              result.googleReachable = await google(tested);
              if (!result.googleReachable) result.googleError = '出口检测通过，但 Google 登录页 HTTPS 请求未通过。';
            }
            result.readyToLaunch = result.ok === true && result.googleReachable === true && result.targetCountryMatches === true && result.stability?.complete === true && result.stability?.stable === true && !result.stability.changedSincePrevious && result.binding?.matches !== false;
            return respond(res,200,result);
          } finally { await temporary?.close(); diagnosticsActive--; if (existing) diagnosingProfiles.delete(existing.id); }
        }
        if (req.method === 'POST' && url.pathname === '/api/profiles') {
          if (state.profiles.length >= 100) throw new Error('第一版最多支持 100 个环境。');
          const p = makeProfile(effectiveInput(body));
          Object.assign(p, await saveAuth(body, null, p.proxy, p));
          sessionSummaries.set(p.id,{envelope:p.proxyAuth,proxy:p.proxy,summary:inspectProxySession(p.proxy,p.proxyAuth ? await vault.open(p.proxyAuth) : null)});
          state.profiles.push(p); save();
          return respond(res, 201, displayProfile(p));
        }
        const match = /^\/api\/profiles\/([a-f0-9-]{36})(?:\/(check|launch|resume|observations|cycle|device-review|close))?$/.exec(url.pathname);
        if (!match) return respond(res, 404, { error: '接口不存在。' });
        const profile = state.profiles.find(p => p.id === match[1]);
        if (!profile) return respond(res, 404, { error: '环境不存在。' });
        // Viewing an existing desktop must not probe the proxy, launch another
        // Chrome window, or rewrite history. Also protect older open workbench
        // pages whose sign-in button still sends /launch for an active profile.
        if (req.method === 'POST' && (match[2] === 'resume'
            || match[2] === 'launch' && remoteMode && body.target === 'signin' && sessionActive(profile.id))) {
          if (!remoteMode) throw new Error('继续使用入口仅适用于服务器浏览器。');
          const current = displayProfile(profile);
          if (!current.session.desktopUrl) return respond(res, 409, { error: current.session.active || current.session.starting
            ? '此环境的远程画面尚未就绪，请稍后刷新重试。'
            : '此环境的浏览器已关闭。状态已更新，请点击“登录 Google 账号”重新启动。', profile: current });
          return respond(res, 200, { ok: true, resumed: true, message: '已连接现有浏览器画面，原有标签保持不变。', profile: current });
        }
        if (busy.has(profile.id) || diagnosingProfiles.has(profile.id)) return respond(res, 409, { error: '这个环境正在检测或启动，请稍后再试。' });
        lockedId = profile.id; busy.add(lockedId);
        if (req.method === 'PATCH' && !match[2]) {
          const updated = profileInput(effectiveInput({ ...profile, ...body }));
          const authentication = await saveAuth(body, profile, updated.proxy, updated);
          const authChanged = JSON.stringify(authentication.proxyAuth) !== JSON.stringify(profile.proxyAuth || null);
          if (updated.accountLabel !== profile.accountLabel && sessionActive(profile.id)) throw new Error('请先关闭环境浏览器，再修改账号代号。');
          if (authChanged || updated.proxy !== profile.proxy || updated.country !== profile.country || JSON.stringify(updated.environment) !== JSON.stringify(profile.environment) || updated.strictIp !== profile.strictIp) {
            // Do not retarget a profile that might still be running with its previous proxy.
            if (settingsLocked(profile)) throw new Error(remoteMode || profile.environment.engine === 'managed'
              ? '请先关闭该环境浏览器，再清空或更换代理和环境参数。登录资料会保留。'
              : '使用过的本机原生环境无法可靠确认是否已关闭，请新建环境。服务器环境关闭后可以更换代理。');
            // An old bridge failing to restore must not prevent replacing it.
            await bridgeStarts.get(profile.id)?.catch(() => {});
            await bridges.get(profile.id)?.close(); bridges.delete(profile.id);
            if (profile.cycleStartedAt) { profile.cycleHistory ||= []; profile.cycleHistory.push(profile.cycleStartedAt); }
            profile.checks = []; profile.cycleStartedAt = null; profile.expectedIp = null;
            delete profile.proxyBridgePort;
          }
          Object.assign(profile, updated, authentication); save();
          sessionSummaries.set(profile.id,{envelope:profile.proxyAuth,proxy:profile.proxy,summary:inspectProxySession(profile.proxy,profile.proxyAuth ? await vault.open(profile.proxyAuth) : null)});
          return respond(res, 200, displayProfile(profile));
        }
        if (req.method !== 'POST') return respond(res, 405, { error: '请求方法不支持。' });
        if (match[2] === 'check') return respond(res, 200, await check(profile));
        if (match[2] === 'close') {
          if (!remoteMode && profile.environment.engine !== 'managed') throw new Error('原生模式请直接关闭对应浏览器窗口。本工具不能可靠追踪原生会话。');
          const closed = await (remoteMode ? remote : managed).close(profile.id);
          if (closed?.ok === false) throw new Error('受控环境未能关闭，请手动关闭该环境窗口并刷新状态。');
          return respond(res, 200, { ok: true, message: '环境浏览器已关闭，登录目录保留。Google 在其他设备上的登录不受此操作影响。' });
        }
        if (match[2] === 'launch') {
          const destination = targetUrl(profile, body.target);
          if (!browser) throw new Error('未检测到 Chrome 或 Edge，请安装浏览器或设置 BROWSER_PATH。');
          if (!profile.proxy) throw new Error('请先设置代理，再打开该环境。诊断页不访问外网，但会固定该环境的网络设置。');
          if (remoteMode && !sessionActive(profile.id)) {
            const occupied = state.profiles.filter(p => sessionActive(p.id) || launching.has(p.id)).length;
            if (occupied >= maxRemoteEnvironments) throw new Error(`服务器最多同时运行 ${maxRemoteEnvironments} 个环境，请先关闭一个环境。`);
          }
          // Reserve before network probes yield so concurrent requests cannot
          // overbook the server. A network check alone does not reserve a slot.
          if (remoteMode) launching.add(profile.id);
          const accountKey = profile.accountLabel.toLowerCase();
          if (accountKey) {
            if (accountBusy.has(accountKey) || state.profiles.some(p => p.id !== profile.id && p.accountLabel.toLowerCase() === accountKey && sessionActive(p.id))) throw new Error('同一账号代号已有受控环境运行或启动中。请先关闭它。此限制只覆盖本工具的受控环境。');
            accountBusy.add(accountKey); lockedAccount = accountKey;
          }
          let result;
          if (body.target !== 'diagnostics') {
            result = await check(profile, body.target);
            if (!result.ok) throw new Error(result.error);
          }
          const profileDir = join(dataDir, 'profiles', profile.id);
          mkdirSync(profileDir, { recursive: true, mode: 0o700 });
          let opening;
          const { proxyAuth: _secret, proxyUsername: _username, ...launchProfile } = profile;
          launchProfile.proxy = (await connection(profile)).proxy;
          if (remoteMode) {
            opening = await remote.open({ profile: launchProfile, profileDir, browserPath: browser.path, url: destination });
          } else if (profile.environment.engine === 'managed') {
            opening = await managed.open({ profile: launchProfile, profileDir, browserPath: browser.path, url: destination });
          } else {
            const args = buildBrowserArgs(launchProfile, profileDir, body.target);
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
          return respond(res, 200, { ok: true, message: `${result ? '启动前的出口与 Google 目标页面连通检查已通过。' : '已请求打开诊断页，未检查外网连接。'}${remoteMode ? '已在服务器打开浏览器，请在远程浏览器画面中操作。' : `已向本机独立浏览器窗口发送打开请求，请切换到 ${browser.name} 查看。`}此检查不保证页面持续可用，本工具尚未确认登录状态。`, profile: displayProfile(profile) });
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
          save(); return respond(res, 200, displayProfile(profile));
        }
        if (match[2] === 'cycle') {
          profile.cycleHistory ||= [];
          if (profile.cycleStartedAt) profile.cycleHistory.push(profile.cycleStartedAt);
          profile.cycleStartedAt = new Date().toISOString();
          save(); return respond(res, 200, displayProfile(profile));
        }
        return respond(res, 404, { error: '接口不存在。' });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/proxy-input.js': ['proxy-input.js', 'text/javascript'], '/proxy-session.js': ['proxy-session.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [filename, type] = assets[url.pathname];
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        return res.end(readFileSync(join(ROOT, 'public', filename)));
      }
      respond(res, 404, { error: '页面不存在。' });
    } catch (err) { respond(res, 400, { error: err.code ? '本地文件或服务操作失败，请检查程序终端。' : err.message }); }
    finally { if (lockedId) { busy.delete(lockedId); launching.delete(lockedId); } if (lockedAccount) accountBusy.delete(lockedAccount); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.once('listening', () => {
    for (const profile of state.profiles) if (profile.proxyAuth && profile.proxyBridgePort) {
      connection(profile).catch(() => console.error('Unable to restore a local authenticated proxy bridge; check this profile in the workbench.'));
    }
  });
  server.on('close', release);
  let closing;
  const close = () => closing ||= (async () => {
    publicProxies.cancelScan?.();
    await remote.closeAll();
    await managed.closeAll();
    await Promise.allSettled([...bridgeStarts.values()]);
    await Promise.all([...bridges.values()].map(bridge => bridge.close()));
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
