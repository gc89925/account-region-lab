import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

async function browserPath() {
  if (process.env.REGION_LAB_SKIP_UI_TESTS === '1') return null;
  const candidates = [process.env.REGION_LAB_UI_TEST_BROWSER,
    ...(process.platform === 'win32' ? [
      join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')
    ] : ['/usr/bin/google-chrome', '/usr/bin/chromium'])];
  for (const path of candidates.filter(Boolean)) { try { await access(path); return path; } catch {} }
  return null;
}

function desktopUrl(profile, generation = 'a'.repeat(32)) {
  const base = `desktop/${profile.id}/${generation}`;
  return `/${base}/vnc.html?autoconnect=true&resize=scale&path=${base}/websockify`;
}

test('remote UI keeps five independent environment views, preserves refreshes, and stops only the chosen browser', async t => {
  const executablePath = await browserPath();
  if (!executablePath) { t.skip('A local Chrome/Chromium/Edge executable is needed for the browser UI test'); return; }
  const profiles = ['US', 'JP', 'KR', 'IN', 'NG', 'CA'].map((country, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, label: `测试 ${country}`, country,
    accountLabel: `account-${index}`, proxy: 'socks5://127.0.0.1:1080', environment: { engine: 'native' },
    checks: [], observations: [], launches: [], session: { active: index < 3, managed: true, starting: false }
  }));
  for (const profile of profiles) profile.session.desktopUrl = profile.session.active ? desktopUrl(profile) : null;
  const actions = [], desktopRequests = [], errors = [];
  const staticFiles = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'proxy-input.js', 'proxy-session.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/state') return json({ profiles, token: 'test-token', browser: { name: 'Test Chrome' },
      capabilities: { remoteBrowser: true, managed: false, maxRemoteEnvironments: 5 },
      remoteSessions: { limit: 5, active: profiles.filter(profile => profile.session.active).length, starting: 0 }, links: {} });
    if (url.pathname === '/api/proxies/scan') return json({ state: 'idle', running: false });
    const action = url.pathname.match(/^\/api\/profiles\/([^/]+)\/(close|launch)$/);
    if (action && request.method === 'POST') {
      actions.push({ id: action[1], action: action[2] });
      const profile = profiles.find(item => item.id === action[1]);
      profile.session.active = action[2] === 'launch';
      profile.session.desktopUrl = profile.session.active ? desktopUrl(profile) : null;
      return json({ ok: true, profile });
    }
    if (url.pathname.startsWith('/desktop/')) {
      desktopRequests.push(url.pathname);
      response.setHeader('Content-Type', 'text/html');
      return response.end('<!doctype html><html><body><input aria-label="Test desktop input"></body></html>');
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (staticFiles.has(name)) {
      response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      return response.end(staticFiles.get(name));
    }
    response.statusCode = 404; response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const card = index => page.locator(`#profile-${profiles[index].id}`);
  const refresh = async () => { const response = page.waitForResponse(response => response.url() === `${origin}/api/state`); await page.locator('#refresh').click(); await response; await page.locator('#refresh').waitFor({ state: 'visible' }); };
  const expectText = async (selector, text) => { await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text }); };
  const expectViewer = async index => { await page.waitForFunction(path => document.querySelector('#remote-desktop-frame-container iframe')?.getAttribute('src') === path, profiles[index].session.desktopUrl || desktopUrl(profiles[index])); };
  await page.goto(origin);
  await expectText('#remote-session-summary', '运行中 3 / 5');
  await card(0).getByRole('button', { name: '打开测试 US的远程浏览器', exact: true }).click();
  await expectViewer(0);
  await page.getByRole('button', { name: '查看测试 JP的远程画面', exact: true }).click();
  await expectViewer(1);
  await page.frameLocator('#remote-desktop-frame-container iframe').getByRole('textbox').fill('JP retained through refresh');
  const requestsBefore = desktopRequests.length;
  await refresh();
  assert.equal(await page.frameLocator('#remote-desktop-frame-container iframe').getByRole('textbox').inputValue(), 'JP retained through refresh');
  assert.equal(desktopRequests.length, requestsBefore, 'state refresh must preserve the existing iframe connection');

  const separate = card(2).getByRole('link', { name: '在独立窗口打开测试 KR', exact: true });
  assert.equal(await separate.getAttribute('target'), '_blank');
  assert.match(await separate.getAttribute('rel'), /noopener/);
  const popupPromise = context.waitForEvent('page');
  await separate.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), origin + profiles[2].session.desktopUrl);
  assert.equal(await page.locator('#remote-desktop-frame-container iframe').getAttribute('src'), profiles[1].session.desktopUrl);
  await popup.close();
  await page.getByRole('button', { name: '收起画面', exact: true }).click();
  assert.equal(await page.locator('#remote-desktop-frame-container iframe').count(), 0);
  assert.equal(actions.length, 0, 'switching, opening a separate view, and hiding cannot close browser sessions');

  await card(1).getByRole('button', { name: '关闭测试 JP的浏览器', exact: true }).click();
  await expectText('#remote-session-summary', '运行中 2 / 5');
  assert.deepEqual(actions, [{ id: profiles[1].id, action: 'close' }]);
  assert.equal(profiles[0].session.active, true);
  assert.equal(profiles[2].session.active, true);
  await card(3).getByRole('button', { name: '在测试 IN环境登录Google账号', exact: true }).click();
  await expectViewer(3);
  assert.equal(actions.at(-1).id, profiles[3].id, 'another environment launches while existing environments continue');

  for (const profile of profiles.slice(0, 5)) { profile.session.active = true; profile.session.desktopUrl = desktopUrl(profile); }
  await refresh();
  await expectText('#remote-session-summary', '运行中 5 / 5');
  const countBefore = actions.length;
  await card(5).getByRole('button', { name: '在测试 CA环境登录Google账号', exact: true }).click();
  await expectText(`#profile-${profiles[5].id} .operation-status`, '已占用 5 个');
  assert.equal(actions.length, countBefore);
  await card(0).getByRole('button', { name: '在测试 US环境登录Google账号', exact: true }).click();
  await expectViewer(0);
  assert.equal(actions.length, countBefore + 1, 'existing environments may open pages at capacity');

  profiles[4].session = { active: false, managed: true, starting: true, desktopUrl: null };
  await refresh();
  await expectText('#remote-session-summary', '运行中 4 / 5 · 正在启动 1 个');
  await card(5).getByRole('button', { name: '在测试 CA环境登录Google账号', exact: true }).click();
  await expectText(`#profile-${profiles[5].id} .operation-status`, '已占用 5 个');
  assert.equal(actions.length, countBefore + 1, 'starting environments reserve a concurrency slot');
  profiles[4].session.starting = false;
  profiles[5].accountLabel = profiles[0].accountLabel.toUpperCase();
  await refresh();
  await expectText('#remote-session-summary', '运行中 4 / 5');
  await card(5).getByRole('button', { name: '在测试 CA环境登录Google账号', exact: true }).click();
  await expectText(`#profile-${profiles[5].id} .operation-status`, '相同账号代号');
  assert.equal(actions.length, countBefore + 1, 'same-account protection remains enforced with free capacity');

  profiles[0].session.desktopUrl = desktopUrl(profiles[0], 'b'.repeat(32));
  await refresh(); await expectViewer(0);
  assert.match(await page.locator('#remote-desktop-tab').getAttribute('href'), /b{32}/);
  profiles[1].session.desktopUrl = desktopUrl(profiles[0]);
  profiles[2].session.desktopUrl = 'https://foreign.invalid/desktop/vnc.html';
  await refresh();
  await page.waitForFunction(() => !document.querySelector('#profile-00000000-0000-4000-8000-000000000002 a[target="_blank"]'));
  assert.equal(await card(1).getByRole('link', { name: '在独立窗口打开测试 JP', exact: true }).count(), 0);
  assert.equal(await card(2).getByRole('link', { name: '在独立窗口打开测试 KR', exact: true }).count(), 0);

  await card(0).getByRole('button', { name: '编辑测试 US', exact: true }).click();
  await page.locator('#profile-label').fill('Keep draft');
  await page.mouse.click(2, 2);
  assert.equal(await page.locator('#profile-dialog').evaluate(dialog => dialog.open), true);
  assert.equal(await page.locator('#profile-label').inputValue(), 'Keep draft');
  assert.deepEqual(errors, []);
});

test('proxy settings can be replaced after close, pasted residential sessions stay private, and global catalog filters are selectable', async t => {
  const executablePath = await browserPath();
  if (!executablePath) { t.skip('A local Chrome/Chromium/Edge executable is needed for the browser UI test'); return; }
  const profile = { id: '00000000-0000-4000-8000-000000000009', label: '已用印度环境', country: 'IN',
    accountLabel: 'example-account', proxy: 'socks5://expired.example:1080', proxyUsername: 'old-user', proxyAuthConfigured: true,
    environment: { engine: 'native' }, launches: [{ at: new Date().toISOString() }], checks: [], observations: [],
    locked: true, session: { active: true, managed: true, starting: false } };
  profile.session.desktopUrl = desktopUrl(profile);
  const patches = [], scanRequests = [], countryRequests = [], errors = [];
  let scan = { state: 'idle', running: false };
  let pendingCatalogResponses = 0;
  const staticFiles = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'proxy-input.js', 'proxy-session.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    const body = async () => { let value = ''; for await (const chunk of request) value += chunk; return JSON.parse(value); };
    if (url.pathname === '/api/state') return json({ profiles: [profile], token: 'test-token', browser: { name: 'Test Chrome' }, capabilities: { remoteBrowser: true, maxRemoteEnvironments: 5 }, links: {} });
    if (url.pathname === `/api/profiles/${profile.id}/close`) { profile.session.active = false; profile.session.desktopUrl = null; profile.locked = false; return json({ ok: true, profile }); }
    if (url.pathname === `/api/profiles/${profile.id}` && request.method === 'PATCH') {
      const input = await body(); patches.push(input); Object.assign(profile, input); profile.proxyAuthConfigured = Boolean(input.proxy && input.proxyPassword); return json(profile);
    }
    if (url.pathname === '/api/proxies') {
      const country = url.searchParams.get('country'); countryRequests.push(country);
      const refreshing = pendingCatalogResponses-- > 0;
      return json({ country, nodes: [], total: 12, countryCounts: { DE: 7, BR: 3, ID: 2 }, countries: [{ code: 'DE', count: 7 }, { code: 'BR', count: 3 }, { code: 'ID', count: 2 }], refreshing,
        sources: [{ name: 'Example', ok: true }, { name: 'Slow source', ok: !refreshing, loading: refreshing }] });
    }
    if (url.pathname === '/api/proxies/scan') {
      if (request.method === 'POST') { const input = await body(); scanRequests.push(input); scan = { state: 'running', running: true, country: input.country, total: input.limit, tested: 3, active: 5, connecting: 3, verifying: 2, passed: 0, failed: 3 }; }
      return json(scan);
    }
    if (url.pathname === '/api/proxies/scan/cancel') { scan = { ...scan, state: 'cancelled', running: false, active: 0, connecting: 0, verifying: 0, cancelled: 5 }; return json(scan); }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (staticFiles.has(name)) { response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'); return response.end(staticFiles.get(name)); }
    response.statusCode = 404; response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const edit = () => page.getByRole('button', { name: '编辑已用印度环境', exact: true }).click();
  const paste = value => page.locator('#profile-proxy').evaluate((input, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, value);
  await page.goto(origin); await edit();
  assert.equal(await page.locator('#profile-proxy').isDisabled(), true);
  assert.match(await page.locator('#profile-binding-note').innerText(), /先关闭浏览器/);
  await page.locator('#close-profile-for-edit').click();
  await page.waitForFunction(() => !document.querySelector('#profile-proxy').disabled);
  assert.equal(profile.session.active, false);
  await page.locator('#clear-profile-proxy').click();
  assert.equal(await page.locator('#profile-proxy').inputValue(), '');
  assert.equal(await page.locator('#proxy-username').inputValue(), '');
  await page.locator('#profile-submit').click();
  await page.waitForFunction(() => !document.querySelector('#profile-dialog').open);
  assert.equal(patches.at(-1).proxy, '');
  assert.equal(patches.at(-1).proxyUsername, '');
  assert.equal(profile.launches.length, 1, 'network changes preserve the existing environment identity');

  await edit();
  const prefix = 'geo.iproyal.com:12321:demo-user:';
  const syntheticPasswords = ['DemoSecret_country-id_session-ExampleOne_lifetime-168h_streaming-1', 'DemoSecret_country-id_session-ExampleTwo_lifetime-168h_streaming-1', 'DemoSecret_country-id_session-ExampleThree_lifetime-168h_streaming-1'];
  await paste(syntheticPasswords.map(password => prefix + password).join(''));
  assert.equal(await page.locator('#proxy-import-choice option').count(), 3);
  assert.equal(await page.locator('#profile-proxy').inputValue(), 'socks5://geo.iproyal.com:12321');
  assert.equal(await page.locator('#proxy-username').inputValue(), 'demo-user');
  assert.equal(await page.locator('#proxy-password').getAttribute('type'), 'password');
  assert.equal(await page.locator('#profile-country').inputValue(), 'IN', 'pasted country must not silently change the existing country');
  assert.match(await page.locator('#proxy-import-status').innerText(), /ID 为印度尼西亚/);
  assert.match(await page.locator('#proxy-session-summary').innerText(), /168h/);
  assert.match(await page.locator('#proxy-session-summary').innerText(), /密码的一部分/);
  assert.match(await page.locator('#proxy-strict-help').innerText(), /首次启用可能分配新出口/);
  const visibleChoices = await page.locator('#proxy-import-choice').innerText();
  assert.ok(!visibleChoices.includes('DemoSecret') && !visibleChoices.includes('demo-user') && !visibleChoices.includes('ExampleOne'), 'choices expose only endpoint, country, and masked session hints');
  await page.locator('#proxy-import-choice').selectOption('2');
  assert.equal(await page.locator('#proxy-password').inputValue(), syntheticPasswords[2]);
  await page.locator('#proxy-import-country').click();
  assert.equal(await page.locator('#profile-country').inputValue(), 'ID');
  await page.locator('#profile-submit').click();
  await page.waitForFunction(() => !document.querySelector('#profile-dialog').open);
  assert.equal(patches.at(-1).proxyPassword, syntheticPasswords[2]);
  assert.equal(patches.at(-1).country, 'ID');
  assert.equal(await page.locator('#proxy-password').inputValue(), '', 'closing the form clears imported secrets from hidden fields');
  await edit(); assert.equal(await page.locator('#proxy-import-choice option').count(), 0);
  await paste('socks5://changed.example:1080');
  assert.match(await page.locator('#proxy-import-status').innerText(), /原认证字段暂时保留/);
  await paste('proxy.example:1080:demo-user:NotARealPassword');
  assert.equal(await page.locator('#profile-proxy').inputValue(), '', 'ambiguous credentials must never remain in a visible address field');
  assert.match(await page.locator('#proxy-import-status').innerText(), /协议/);
  await page.locator('#proxy-import-protocol').selectOption('socks5');
  await paste('proxy.example:1080:demo-user:NotARealPassword\nsocks5://anonymous.example:1080');
  assert.equal(await page.locator('#proxy-import-choice option').count(), 2);
  await page.locator('#proxy-import-choice').selectOption('1');
  assert.equal(await page.locator('#proxy-username').inputValue(), '');
  assert.equal(await page.locator('#proxy-password').inputValue(), '');
  assert.equal(await page.locator('#clear-proxy-auth').isChecked(), true, 'selecting an anonymous candidate cannot inherit credentials from the previous candidate');
  await page.getByRole('button', { name: '关闭环境设置', exact: true }).click();

  assert.equal(await page.locator('#catalog-country').inputValue(), 'ALL');
  assert.ok(await page.locator('#catalog-country option').count() >= 240);
  await page.locator('#load-catalog').click();
  await page.waitForFunction(() => document.querySelector('#catalog-country-help').textContent.includes('目录覆盖 3'));
  await page.locator('#catalog-country-search').fill('Germany');
  assert.equal(await page.locator('#catalog-country option').count(), 2);
  await page.locator('#catalog-country').selectOption('DE');
  await page.waitForFunction(() => !document.querySelector('#catalog-country').disabled);
  assert.equal(countryRequests.at(-1), 'DE');
  pendingCatalogResponses = 2;
  await page.locator('#load-catalog').click();
  await page.waitForFunction(() => document.querySelector('#catalog-status').textContent.includes('正在补充来源'));
  assert.equal(await page.locator('#catalog-source-status').isHidden(), true, 'an in-progress source must not be shown as failed');
  const requestsBeforeRefresh = countryRequests.length;
  await page.waitForFunction(() => !document.querySelector('#catalog-country').disabled && !document.querySelector('#catalog-status').textContent.includes('正在补充来源'));
  assert.equal(countryRequests.length, requestsBeforeRefresh + 2, 'source completion ends the automatic refresh cycle');
  assert.equal(await page.locator('#catalog-country').inputValue(), 'DE');
  assert.equal(await page.locator('#catalog-country-search').inputValue(), 'Germany');
  await page.locator('#scan-limit').selectOption('120');
  await page.locator('#scan-proxies').click();
  await page.waitForFunction(() => document.querySelector('#scan-progress-detail').textContent.includes('快速连接 3'));
  assert.deepEqual(scanRequests.at(-1), { country: 'DE', limit: 120 });
  assert.match(await page.locator('#scan-progress-detail').innerText(), /出口与 Google 验证 2/);
  await page.locator('#cancel-scan').click();
  await page.waitForFunction(() => !document.querySelector('#catalog-country').disabled);
  assert.deepEqual(errors, []);
});

test('proxy diagnosis shows sample changes and saved session details without accepting stale results after edits', async t => {
  const executablePath = await browserPath();
  if (!executablePath) { t.skip('A local Chrome/Chromium/Edge executable is needed for the browser UI test'); return; }
  const session = { provider: 'iproyal', country: 'ID', countries: ['ID'], sessionHint: 'De…12', lifetime: '168h', killswitch: true, issues: [] };
  const profile = { id: '00000000-0000-4000-8000-000000000019', label: '诊断测试环境', country: 'ID',
    accountLabel: '', proxy: 'socks5://geo.iproyal.com:12321', proxyUsername: 'demo-user', proxyAuthConfigured: true,
    proxySession: session, strictIp: true, environment: { engine: 'native' }, launches: [], checks: [], observations: [],
    locked: false, session: { active: false, managed: true, starting: false } };
  const requests = [], errors = [];
  const stableSamples = [1, 2, 3].map(() => ({ ip: '203.0.113.25', country: 'ID', source: 'api.country.is', ok: true }));
  let diagnosis = { ok: true, readyToLaunch: true, configuredProtocol: 'socks5', probe: stableSamples[0], session,
    stability: { samples: stableSamples, uniqueIps: 1, stable: true, complete: true }, googleReachable: true, targetCountryMatches: true };
  let deferNext = false, resolveHeld;
  const staticFiles = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'proxy-input.js', 'proxy-session.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/state') return json({ profiles: [profile], token: 'test-token', browser: { name: 'Test Chrome' }, capabilities: { remoteBrowser: true, maxRemoteEnvironments: 5 }, links: {} });
    if (url.pathname === '/api/proxies/scan') return json({ state: 'idle', running: false });
    if (url.pathname === '/api/proxy/diagnose') {
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const result = structuredClone(diagnosis);
      if (deferNext) { deferNext = false; await new Promise(resolve => { resolveHeld = resolve; }); }
      return json(result);
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (staticFiles.has(name)) { response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'); return response.end(staticFiles.get(name)); }
    response.statusCode = 404; response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { resolveHeld?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const expectText = async (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  const runDiagnosis = async () => { await page.locator('#diagnose-proxy').click(); await expectText('#diagnose-proxy', '重新诊断'); };
  await page.goto(origin);
  await page.getByRole('button', { name: '编辑诊断测试环境', exact: true }).click();
  assert.equal(await page.locator('#proxy-password').inputValue(), '');
  assert.match(await page.locator('#proxy-session-summary').innerText(), /De…12/);
  assert.match(await page.locator('#proxy-session-summary').innerText(), /168h/);
  await runDiagnosis();
  assert.equal(requests.at(-1).strictIp, true);
  assert.equal(requests.at(-1).proxyPassword, '');
  assert.match(await page.locator('#proxy-diagnosis').innerText(), /本次代理检查通过/);
  assert.equal(await page.locator('.diagnosis-samples li').count(), 3);
  assert.match(await page.locator('#proxy-diagnosis').innerText(), /不保证后续连接/);

  diagnosis = { ...diagnosis, readyToLaunch: false, stability: { samples: [stableSamples[0], { ...stableSamples[0], ip: '203.0.113.26' }, stableSamples[2]], uniqueIps: 2, stable: false, complete: true } };
  await runDiagnosis();
  assert.match(await page.locator('#proxy-diagnosis > strong').getAttribute('class'), /diagnosis-error/);
  assert.match(await page.locator('#proxy-diagnosis').innerText(), /取得 2 个不同出口 IP/);
  assert.doesNotMatch(await page.locator('#proxy-diagnosis').innerText(), /本次代理检查通过/);
  diagnosis = { ...diagnosis, stability: { samples: stableSamples, uniqueIps: 1, stable: true, complete: true, comparedWithPrevious: true, changedSincePrevious: true } };
  await runDiagnosis();
  assert.match(await page.locator('#proxy-diagnosis').innerText(), /与上一次相同配置的诊断出口不同/);
  diagnosis = { ...diagnosis, stability: { samples: stableSamples, uniqueIps: 1, stable: true, complete: true }, binding: { expectedIp: '203.0.113.50', matches: false } };
  await runDiagnosis();
  assert.match(await page.locator('#proxy-diagnosis > strong').innerText(), /绑定值不一致/);

  diagnosis = { ...diagnosis, binding: null, stability: { samples: [stableSamples[0], { ok: false, error: '连接超时' }], uniqueIps: 1, stable: false, complete: false } };
  await runDiagnosis();
  assert.match(await page.locator('#proxy-diagnosis').innerText(), /连续检查未全部完成/);
  assert.doesNotMatch(await page.locator('#proxy-diagnosis > strong').innerText(), /出口 IP 发生变化/);

  diagnosis = { ...diagnosis, readyToLaunch: true, stability: { samples: stableSamples, uniqueIps: 1, stable: true, complete: true }, binding: null };
  for (const selector of ['#profile-proxy', '#proxy-username', '#proxy-password', '#profile-country', '#profile-strict-ip']) {
    await runDiagnosis();
    await page.locator(selector).dispatchEvent('change');
    assert.equal(await page.locator('#proxy-diagnosis').isHidden(), true, `${selector} changes invalidate the displayed result`);
  }
  deferNext = true;
  await page.locator('#diagnose-proxy').click();
  while (!resolveHeld) await new Promise(resolve => setTimeout(resolve, 10));
  await page.locator('#profile-strict-ip').uncheck();
  const completed = page.waitForResponse(response => response.url() === `${origin}/api/proxy/diagnose`);
  resolveHeld(); await completed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#proxy-diagnosis').isHidden(), true, 'a response for the former strict setting cannot repaint the updated form');
  await runDiagnosis();
  assert.equal(requests.at(-1).strictIp, false);
  assert.deepEqual(errors, []);
});
