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
  const staticFiles = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'proxy-input.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
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
  const expectViewer = async index => { await page.waitForFunction(path => document.querySelector('#remote-desktop-frame-container iframe')?.getAttribute('src') === path, profiles[index].session.desktopUrl); };
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
