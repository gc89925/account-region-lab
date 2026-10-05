import path from 'node:path';
import { lstat, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeEnvironment } from './environment.js';
import { validateProxy } from './model.js';

export const DIAGNOSTICS_URL = new URL('../public/diagnostics.html', import.meta.url).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEB_HOSTS = new Set(['mail.google.com', 'www.youtube.com', 'policies.google.com', 'myaccount.google.com']);

function destination(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('浏览器目标无效。'); }
  if (url.protocol === 'https:' && WEB_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port) return url.href;
  if (url.protocol === 'file:' && !url.search && !url.username && !url.password && !url.host) {
    try {
      if (path.resolve(fileURLToPath(url)) === path.resolve(fileURLToPath(DIAGNOSTICS_URL))) return url.href;
    } catch { /* Use a generic error below, never expose caller-provided URLs. */ }
  }
  throw new Error('仅能打开支持的 Google 页面或本地环境诊断页。');
}

async function validateLaunch({ profile, profileDir, browserPath, url }) {
  if (!profile || typeof profile.id !== 'string' || !UUID.test(profile.id)) throw new Error('环境 ID 必须是 UUID。');
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || path.basename(profileDir).toLowerCase() !== profile.id.toLowerCase()) {
    throw new Error('必须使用该环境 UUID 对应的独立浏览器目录。');
  }
  if (typeof browserPath !== 'string' || !path.isAbsolute(browserPath)) throw new Error('浏览器程序路径无效。');
  const environment = normalizeEnvironment(profile.environment, profile.country);
  if (environment.engine !== 'managed') throw new Error('该环境未启用受控浏览器模式。');
  const server = validateProxy(profile.proxy);
  if (!server) throw new Error('请先配置该环境的代理。');
  const target = destination(url);
  const directory = path.resolve(profileDir);
  const executablePath = path.resolve(browserPath);
  try {
    const [directoryStat, executableStat] = await Promise.all([lstat(directory), stat(executablePath)]);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !executableStat.isFile()) throw new Error();
  } catch { throw new Error('浏览器程序或该环境的现有目录不可用。'); }
  const downloadsPath = path.join(directory, 'Downloads');
  try {
    await mkdir(downloadsPath, { recursive: true });
    const downloadStat = await lstat(downloadsPath);
    if (!downloadStat.isDirectory() || downloadStat.isSymbolicLink()) throw new Error();
  } catch { throw new Error('该环境的独立下载目录不可用。'); }
  return { id: profile.id, directory, executablePath, environment, server, target, downloadsPath };
}

export function createManagedLauncher({ chromium } = {}) {
  const active = new Map();
  let browserType = chromium;

  async function open(options) {
    const config = await validateLaunch(options);
    const signature = JSON.stringify([config.directory, config.executablePath, config.environment, config.server]);
    let entry = active.get(config.id);
    if (entry && (entry.signature !== signature || entry.closing)) throw new Error('环境正在运行，请先关闭，再修改设置或重新打开。');
    if (!entry) {
      entry = { signature, context: null, opening: null, closing: false };
      active.set(config.id, entry);
      entry.opening = (async () => {
        browserType ||= (await import('playwright-core')).chromium;
        const context = await browserType.launchPersistentContext(config.directory, {
          executablePath: config.executablePath,
          headless: false,
          chromiumSandbox: true,
          locale: config.environment.locale,
          timezoneId: config.environment.timezoneId,
          viewport: config.environment.viewport,
          colorScheme: config.environment.colorScheme === 'system' ? null : config.environment.colorScheme,
          proxy: { server: config.server },
          permissions: [],
          downloadsPath: config.downloadsPath,
          args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-sync'],
        });
        entry.context = context;
        context.on('close', () => { if (active.get(config.id) === entry) active.delete(config.id); });
        return context;
      })();
    }
    let context;
    try { context = await entry.opening; }
    catch {
      if (active.get(config.id) === entry) active.delete(config.id);
      return { ok: false, code: 'BROWSER_START_FAILED', message: '受控浏览器启动失败，请检查浏览器安装、代理和环境目录。', active: false };
    }
    if (entry.closing || active.get(config.id) !== entry) return { ok: false, code: 'BROWSER_CLOSED', message: '浏览器已关闭，请重新打开。', active: false };
    let page;
    try {
      page = await context.newPage();
      await page.goto(config.target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { ok: true };
    } catch {
      if (page) { try { await page.close(); } catch { /* Context may already be closed. */ } }
      return { ok: false, code: 'NAVIGATION_FAILED', message: '页面未能加载。浏览器可能仍在运行；这不代表账号已登录或设备已退出。', active: active.get(config.id) === entry };
    }
  }

  async function close(profileId) {
    const entry = active.get(profileId);
    if (!entry) return { ok: true, closed: false };
    if (entry.closing) return entry.closeResult;
    entry.closing = true;
    entry.closeResult = (async () => {
      let context;
      try { context = await entry.opening; }
      catch { if (active.get(profileId) === entry) active.delete(profileId); return { ok: true, closed: false }; }
      try {
        await context.close();
        if (active.get(profileId) === entry) active.delete(profileId);
        return { ok: true, closed: true };
      } catch {
        entry.closing = false;
        return { ok: false, code: 'CLOSE_FAILED', message: '浏览器未能关闭，请手动关闭该环境窗口。' };
      }
    })();
    return entry.closeResult;
  }

  return { open, close, closeAll: () => Promise.all([...active.keys()].map(close)), isActive: profileId => active.has(profileId) };
}
