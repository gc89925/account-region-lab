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

function desktopUrl(profile, generation) {
  const base = `desktop/${profile.id}/${generation}`;
  return `/${base}/vnc.html?autoconnect=true&resize=scale&path=${base}/websockify`;
}

test('remote clipboard explicitly sends Unicode to the selected live environment and clears transient text', async t => {
  const executablePath = await browserPath();
  if (!executablePath) { t.skip('A local Chrome/Chromium/Edge executable is needed for the clipboard UI test'); return; }
  const profiles = ['IN', 'JP'].map((country, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    label: `测试 ${country}`, country, proxy: 'socks5://127.0.0.1:1080', environment: { engine: 'native' },
    checks: [], observations: [], launches: [], session: { active: true, managed: true, starting: false }
  }));
  const generations = ['a'.repeat(32), 'b'.repeat(32)];
  profiles.forEach((profile, index) => { profile.session.desktopUrl = desktopUrl(profile, generations[index]); });
  const requests = [], desktopRequests = [], errors = [];
  let holdNextRequest = false, releaseRequest, failNextRequest = false;
  const files = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'clipboard.css', 'proxy-input.js', 'proxy-session.js']
    .map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/state') return json({ profiles, token: 'test-token', browser: { name: 'Test Chrome' },
      capabilities: { remoteBrowser: true, managed: false, maxRemoteEnvironments: 5 }, links: {} });
    if (url.pathname === '/api/proxies/scan') return json({ state: 'idle', running: false });
    if (/^\/desktop\/[^/]+\/[^/]+\/clipboard$/.test(url.pathname) && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ path: url.pathname, payload, headers: request.headers });
      if (holdNextRequest) { holdNextRequest = false; await new Promise(resolve => { releaseRequest = resolve; }); }
      if (failNextRequest) { failNextRequest = false; response.statusCode = 409; return json({ error: '环境已重新启动，请刷新状态。' }); }
      return json({ ok: true, pasted: payload.paste, persistenceSeconds: 120 });
    }
    if (url.pathname.startsWith('/desktop/')) {
      desktopRequests.push(url.pathname);
      response.setHeader('Content-Type', 'text/html');
      return response.end('<!doctype html><input aria-label="远程测试输入框">');
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (files.has(name)) {
      response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      return response.end(files.get(name));
    }
    response.statusCode = 404; response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { releaseRequest?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.clipboardReads = 0;
    window.clipboardMode = 'deny';
    Object.defineProperty(navigator, 'clipboard', { value: { readText() {
      window.clipboardReads += 1;
      if (window.clipboardMode === 'hold') return new Promise(resolve => { window.finishClipboardRead = resolve; });
      if (window.clipboardMode === 'deny') return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
      return Promise.resolve('本机剪贴板 · नमस्ते 🌍');
    } }, configurable: true });
  });
  page.on('pageerror', error => errors.push(error.message));
  const card = index => page.locator(`#profile-${profiles[index].id}`);
  const dialog = page.locator('#clipboard-dialog');
  const input = page.locator('#clipboard-text');
  const open = async index => { await card(index).getByRole('button', { name: `向测试 ${profiles[index].country}粘贴文本`, exact: true }).click(); await dialog.waitFor({ state: 'visible' }); };
  const expectText = async (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  const closed = async () => { await dialog.waitFor({ state: 'hidden' }); assert.equal(await input.inputValue(), ''); };
  const refresh = async () => {
    const done = page.waitForResponse(response => response.url() === origin + '/api/state');
    await page.evaluate(() => document.querySelector('#refresh').click());
    await done;
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  };
  await page.goto(origin);
  await card(1).waitFor();
  await card(0).getByRole('button', { name: '打开测试 IN的远程浏览器', exact: true }).click();
  await page.frameLocator('#remote-desktop-frame-container iframe').getByRole('textbox').fill('保留远程页面');
  const originalFrame = await page.locator('#remote-desktop-frame-container iframe').getAttribute('src');
  const originalFrameRequests = desktopRequests.length;

  await page.locator('#open-remote-clipboard').click();
  await expectText('#clipboard-context', '测试 IN');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false, `Clipboard dialog must not overflow horizontally at ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.equal(await page.evaluate(() => window.clipboardReads), 0, 'opening or focusing does not read local clipboard');
  await page.locator('#read-local-clipboard').click();
  await expectText('#clipboard-error', 'Ctrl+V');
  assert.equal(await input.isEnabled(), true, 'permission denial keeps manual input available');
  const unicodeText = '申请地区：印度\nNamaste नमस्ते 🌍\n"quoted" & <plain text>';
  await input.fill(unicodeText);
  holdNextRequest = true;
  await page.locator('#send-clipboard-paste').click();
  await page.waitForFunction(() => document.querySelector('#clipboard-status').textContent.includes('正在发送'));
  assert.equal(await page.locator('#send-clipboard-paste').isDisabled(), true);
  assert.equal(await page.locator('#send-clipboard-only').isDisabled(), true);
  assert.equal(await page.locator('#read-local-clipboard').isDisabled(), true);
  assert.equal(await input.isDisabled(), true);
  await page.evaluate(() => { document.querySelector('#send-clipboard-paste').click(); document.querySelector('#send-clipboard-only').click(); });
  await assert.doesNotReject(async () => {
    const deadline = Date.now() + 5000;
    while (!releaseRequest && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(releaseRequest);
  });
  assert.equal(requests.length, 1, 'busy state rejects duplicate send requests');
  assert.deepEqual(requests[0].payload, { text: unicodeText, paste: true });
  assert.equal(requests[0].path, `/desktop/${profiles[0].id}/${generations[0]}/clipboard`);
  assert.equal(requests[0].headers['x-lab-token'], undefined, 'clipboard uses the authenticated same-origin gateway');
  releaseRequest(); releaseRequest = undefined;
  await closed();
  await expectText('#toast-region', '未提交表单');
  assert.equal(await page.locator('#remote-desktop-frame-container iframe').getAttribute('src'), originalFrame);
  assert.equal(desktopRequests.length, originalFrameRequests, 'clipboard must not reload or reconnect the remote viewer');
  assert.equal(await page.frameLocator('#remote-desktop-frame-container iframe').getByRole('textbox').inputValue(), '保留远程页面');

  await open(1);
  await input.fill('copy-only 日本語');
  await page.locator('#send-clipboard-only').click();
  await closed();
  assert.equal(requests.at(-1).path, `/desktop/${profiles[1].id}/${generations[1]}/clipboard`);
  assert.deepEqual(requests.at(-1).payload, { text: 'copy-only 日本語', paste: false });
  assert.equal(await page.locator('#remote-desktop-frame-container iframe').getAttribute('src'), originalFrame, 'card action does not change the selected viewer');

  await open(1);
  await input.fill('temporary private text');
  await page.keyboard.press('Escape');
  await closed();
  await open(1);
  assert.equal(await input.inputValue(), '');
  await page.evaluate(() => { window.clipboardMode = 'hold'; });
  await page.locator('#read-local-clipboard').click();
  await page.getByRole('button', { name: '关闭粘贴文本', exact: true }).click();
  await closed();
  await open(0);
  await input.fill('new dialog draft');
  await page.evaluate(() => window.finishClipboardRead('stale clipboard response'));
  assert.equal(await input.inputValue(), 'new dialog draft', 'late read cannot populate a reopened dialog for another environment');
  await page.getByRole('button', { name: '关闭粘贴文本', exact: true }).click();
  await closed();

  await open(0);
  await page.evaluate(() => { window.clipboardMode = 'success'; });
  await page.locator('#read-local-clipboard').click();
  await page.waitForFunction(() => document.querySelector('#clipboard-text').value === '本机剪贴板 · नमस्ते 🌍');
  assert.equal(await page.locator('#send-clipboard-paste').isEnabled(), true);
  const oversizedAscii = 'a'.repeat(12289);
  await input.fill(oversizedAscii);
  assert.equal(await input.inputValue(), oversizedAscii, 'oversized input remains visible instead of being silently truncated');
  assert.equal(await input.getAttribute('maxlength'), null, 'native maxlength must not cut off pasted content');
  assert.equal(await page.locator('#send-clipboard-paste').isDisabled(), true);
  await input.fill('a'.repeat(12288));
  assert.equal(await page.locator('#send-clipboard-paste').isEnabled(), true, 'exact byte limit remains usable');
  const escapedControls = '\u0001'.repeat(6000);
  await input.fill(escapedControls);
  assert.equal(await input.inputValue(), escapedControls, 'escaped controls remain visible as the original input without truncation');
  await expectText('#clipboard-error', '请分段发送');
  assert.equal(await page.locator('#send-clipboard-paste').isDisabled(), true, 'serialized request limit rejects excessive JSON escaping');
  assert.equal(await page.locator('#send-clipboard-only').isDisabled(), true);
  await input.fill('汉'.repeat(4097));
  await expectText('#clipboard-error', '超过 12 KB');
  assert.equal(await page.locator('#send-clipboard-paste').isDisabled(), true, 'UTF-8 bytes constrain Unicode text');
  await input.fill('still private');
  failNextRequest = true;
  await page.locator('#send-clipboard-paste').click();
  await expectText('#clipboard-error', '环境已重新启动');
  assert.equal(await input.inputValue(), 'still private', 'failed send preserves the current draft for a manual retry');
  assert.equal(await input.isEnabled(), true);
  const beforeStale = requests.length;
  profiles[0].session.desktopUrl = desktopUrl(profiles[0], 'c'.repeat(32));
  await refresh();
  await expectText('#clipboard-error', '已关闭或重新启动');
  assert.equal(await page.locator('#send-clipboard-paste').isDisabled(), true);
  assert.equal(requests.length, beforeStale);
  await page.getByRole('button', { name: '关闭粘贴文本', exact: true }).click();
  await closed();
  await open(0);
  await input.fill('new generation');
  await page.locator('#send-clipboard-only').click();
  await closed();
  assert.equal(requests.at(-1).path, `/desktop/${profiles[0].id}/${'c'.repeat(32)}/clipboard`);
  assert.deepEqual(errors, []);
});
