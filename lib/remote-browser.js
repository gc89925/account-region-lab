import { spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildBrowserArgs, LINKS, targetUrl } from './model.js';
import { createDesktopManager, trackOwnedProcess, stopOwnedProcess } from './remote-desktop.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function configuration({ profile, profileDir, browserPath, url }, windowBounds) {
  if (!profile || !UUID.test(profile.id || '')) throw new Error('环境 ID 必须是 UUID。');
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)
      || path.basename(profileDir).toLowerCase() !== profile.id.toLowerCase()) {
    throw new Error('必须使用该环境 UUID 对应的独立浏览器目录。');
  }
  if (typeof browserPath !== 'string' || !path.isAbsolute(browserPath)) throw new Error('浏览器程序路径无效。');
  if (!Object.values(LINKS).includes(url) && url !== targetUrl(profile, 'diagnostics')) {
    throw new Error('仅能打开支持的 Google 页面或环境诊断页。');
  }
  const directory = path.resolve(profileDir);
  const executable = path.resolve(browserPath);
  try {
    const [directoryStat, executableStat] = await Promise.all([lstat(directory), stat(executable)]);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !executableStat.isFile()) throw new Error();
  } catch { throw new Error('浏览器程序或该环境的现有目录不可用。'); }
  const args = buildBrowserArgs(profile, directory, 'signin');
  if (windowBounds) {
    const index = args.findIndex(arg => arg.startsWith('--window-size='));
    const [width, height] = args[index].slice('--window-size='.length).split(',').map(Number);
    args[index] = `--window-size=${Math.min(width, windowBounds.width)},${Math.min(height, windowBounds.height)}`;
  }
  args[args.length - 1] = url;
  return { id: profile.id, executable, args, signature: JSON.stringify([executable, args.slice(0, -1)]) };
}

// Each native Chrome runs on its own desktop and persistent profile directory.
// No DevTools connection, login automation, or sandbox bypass is used.
export function createRemoteLauncher({
  maxEnvironments = 5, desktops = createDesktopManager({ maxEnvironments }),
  launch = spawn, processGroups = launch === spawn && process.platform === 'linux',
  startupDelay = 800, closeTimeout = 8000, killTimeout = 2000,
  resourceMode = process.env.REGION_LAB_RESOURCE_MODE,
  desktopGeometry = process.env.REGION_LAB_DESKTOP_GEOMETRY || '1024x768',
} = {}) {
  if (!Number.isInteger(maxEnvironments) || maxEnvironments < 1 || maxEnvironments > 5) throw new Error('并发环境数量必须介于 1 和 5 之间。');
  let windowBounds = null;
  if (resourceMode === 'lean') {
    const match = typeof desktopGeometry === 'string' && /^(\d{3,4})x(\d{3,4})$/.exec(desktopGeometry);
    const width = match ? Number(match[1]) : 0;
    const height = match ? Number(match[2]) : 0;
    if (width < 640 || width > 2560 || height < 480 || height > 1600) throw new Error('轻量模式的桌面尺寸应为 640–2560 x 480–1600。');
    windowBounds = { width, height };
  }
  const active = new Map();
  let shuttingDown = false;

  function start(entry, config, primary) {
    let child;
    // Keep one browser window per environment by default. URL handoff adds a
    // tab to the existing window so older pages can become inactive.
    const args = primary ? config.args : config.args.filter(arg => arg !== '--new-window');
    try { child = launch(config.executable, args, {
      detached: processGroups, stdio: 'ignore', shell: false, windowsHide: false,
      env: { ...process.env, ...entry.desktop.env },
    }); }
    catch { throw new Error('服务器浏览器无法启动，请检查浏览器安装和桌面服务。'); }
    const owned = trackOwnedProcess(child, processGroups);
    entry.children.add(owned);
    if (primary) entry.child = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      child.once('spawn', () => {
        timer = setTimeout(() => finish(), startupDelay);
      });
      child.on('error', () => {
        if (primary) queueMicrotask(() => { void close(entry.id); });
        finish(new Error('服务器浏览器无法启动，请检查浏览器安装和桌面服务。'));
      });
      child.once('exit', (code, signal) => {
        if (!primary && !owned.alive()) entry.children.delete(owned);
        if (primary) queueMicrotask(() => { void close(entry.id); });
        // Only a secondary Chrome invocation may exit after handing its URL to
        // the primary. A primary early exit must never appear as an active tab.
        finish(primary || signal || code !== 0
          ? new Error('服务器浏览器启动后退出，请检查桌面服务、内存和环境目录是否被占用。') : null);
      });
    });
  }

  async function open(options) {
    if (shuttingDown) throw new Error('服务器正在停止，请稍后重试。');
    const config = await configuration(options, windowBounds);
    if (shuttingDown) throw new Error('服务器正在停止，请稍后重试。');
    let entry = active.get(config.id);
    if (entry && (entry.closing || entry.signature !== config.signature)) throw new Error('环境正在运行，请先关闭后再修改设置。');
    if (!entry && active.size >= maxEnvironments) throw new Error(`最多同时运行 ${maxEnvironments} 个服务器环境，请先关闭一个环境。`);
    if (!entry) {
      entry = { id: config.id, signature: config.signature, children: new Set(), closing: false, readyState: false };
      active.set(config.id, entry);
      entry.setup = (async () => {
        entry.desktop = await desktops.open(config.id);
        entry.desktop.exited.then(() => { if (!entry.closing) void close(entry.id); });
        if (entry.closing) throw new Error('浏览器启动已取消。');
        entry.startup = start(entry, config, true);
        entry.startup.catch(() => {});
      })();
      entry.ready = (async () => {
        try {
          await entry.setup;
          await entry.startup;
          if (entry.closing) throw new Error('浏览器启动已取消。');
          entry.readyState = true;
        } catch (error) { await close(config.id); throw error; }
      })();
      await entry.ready;
    } else {
      await entry.ready;
      if (entry.closing || active.get(config.id) !== entry) throw new Error('浏览器已经关闭，请重新打开。');
      await start(entry, config, false);
    }
    if (entry.closing || active.get(config.id) !== entry) throw new Error('浏览器已经关闭，请重新打开。');
    return { ok: true, active: true, pid: entry.child.pid, remote: true, pageLoadVerified: false };
  }

  async function close(profileId) {
    const entry = active.get(profileId);
    if (!entry) return { ok: true, closed: false };
    if (entry.closeResult) return entry.closeResult;
    entry.closing = true;
    entry.readyState = false;
    entry.closeResult = (async () => {
      // Cancel an unfinished desktop before waiting for setup. Once Chrome is
      // present, keep X alive until it has flushed its persistent profile.
      if (!entry.desktop) await desktops.close(profileId);
      await entry.setup.catch(() => {});
      const children = await Promise.all([...entry.children].map(owned => stopOwnedProcess(owned, closeTimeout, killTimeout)));
      if (children.some(result => !result.ok)) {
        entry.closeResult = null;
        return { ok: false, closed: false, code: 'CLOSE_FAILED', message: '服务器浏览器尚未退出，环境名额已保留，请稍后重试关闭。' };
      }
      const desktop = await desktops.close(profileId);
      if (!desktop.ok) { entry.closeResult = null; return desktop; }
      if (active.get(profileId) === entry) active.delete(profileId);
      return { ok: true, closed: true, forced: children.some(result => result.forced) || !!desktop.forced };
    })().catch(() => {
      entry.closeResult = null;
      return { ok: false, closed: false, code: 'CLOSE_FAILED', message: '服务器环境清理尚未完成，名额已保留，请稍后重试关闭。' };
    });
    return entry.closeResult;
  }

  return {
    open, close, maxEnvironments,
    isActive: profileId => active.has(profileId),
    getDesktop: profileId => {
      const entry = active.get(profileId);
      if (!entry?.readyState || entry.closing || !desktops.get(profileId)) return null;
      return { port: entry.desktop.port, generation: entry.desktop.generation };
    },
    closeAll: () => { shuttingDown = true; return Promise.all([...active.keys()].map(close)); },
  };
}
