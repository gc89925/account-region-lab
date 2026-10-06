import { spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildBrowserArgs, LINKS, targetUrl } from './model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function configuration({ profile, profileDir, browserPath, url }) {
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
  args[args.length - 1] = url;
  return { id: profile.id, executable, args, signature: JSON.stringify([executable, args.slice(0, -1)]) };
}

// A native, visible Chrome process runs on the server's DISPLAY. No DevTools
// connection, login automation, browser credentials, or sandbox bypass is used.
export function createRemoteLauncher({ launch = spawn, startupDelay = 800, closeTimeout = 8000, killTimeout = 2000 } = {}) {
  const active = new Map();
  let shuttingDown = false;

  function start(entry, config, primary) {
    let child;
    try { child = launch(config.executable, config.args, { detached: false, stdio: 'ignore', shell: false, windowsHide: false }); }
    catch { throw new Error('服务器浏览器无法启动，请检查浏览器安装和桌面服务。'); }
    entry.children.add(child);
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
        if (primary && active.get(entry.id) === entry) active.delete(entry.id);
        entry.children.delete(child);
        if (primary) entry.resolveExit();
        finish(new Error('服务器浏览器无法启动，请检查浏览器安装和桌面服务。'));
      });
      child.once('exit', (code, signal) => {
        entry.children.delete(child);
        if (primary) {
          entry.exited = true;
          entry.resolveExit();
          if (active.get(entry.id) === entry) active.delete(entry.id);
          for (const helper of entry.children) helper.kill('SIGTERM');
        }
        // Only a secondary Chrome invocation may exit after handing its URL to
        // the primary. A primary early exit must never appear as an active tab.
        finish(primary || signal || code !== 0
          ? new Error('服务器浏览器启动后退出，请检查桌面服务、内存和环境目录是否被占用。') : null);
      });
    });
  }

  async function open(options) {
    if (shuttingDown) throw new Error('服务器正在停止，请稍后重试。');
    const config = await configuration(options);
    if (shuttingDown) throw new Error('服务器正在停止，请稍后重试。');
    let entry = active.get(config.id);
    if (entry && (entry.closing || entry.signature !== config.signature)) throw new Error('环境正在运行，请先关闭后再修改设置。');
    if (!entry && active.size) throw new Error('服务器一次只运行一个浏览器环境。请先关闭当前环境，再打开另一个。');
    if (!entry) {
      entry = { id: config.id, signature: config.signature, children: new Set(), closing: false, exited: false };
      entry.exit = new Promise(resolve => { entry.resolveExit = resolve; });
      active.set(config.id, entry);
      try { entry.ready = start(entry, config, true); }
      catch (error) { active.delete(config.id); throw error; }
      try { await entry.ready; }
      catch (error) { if (active.get(config.id) === entry) active.delete(config.id); throw error; }
    } else {
      await entry.ready;
      if (entry.closing || active.get(config.id) !== entry) throw new Error('浏览器已经关闭，请重新打开。');
      await start(entry, config, false);
    }
    if (entry.closing || active.get(config.id) !== entry) throw new Error('浏览器已经关闭，请重新打开。');
    return { ok: true, active: true, pid: entry.child.pid, remote: true, pageLoadVerified: false };
  }

  async function waitForExit(entry, milliseconds) {
    if (entry.exited) return true;
    let timer;
    try {
      return await Promise.race([entry.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    } finally { clearTimeout(timer); }
  }

  async function close(profileId) {
    const entry = active.get(profileId);
    if (!entry) return { ok: true, closed: false };
    if (entry.closing) return entry.closeResult;
    entry.closing = true;
    entry.closeResult = (async () => {
      // The spawn and event listeners are installed synchronously before open
      // yields, so closing during startup also terminates the tracked process.
      for (const child of entry.children) child.kill('SIGTERM');
      if (await waitForExit(entry, closeTimeout)) return { ok: true, closed: true, forced: false };
      for (const child of entry.children) child.kill('SIGKILL');
      if (await waitForExit(entry, killTimeout)) return { ok: true, closed: true, forced: true };
      entry.closing = false;
      return { ok: false, closed: false, code: 'CLOSE_FAILED', message: '服务器浏览器尚未退出，请在远程桌面关闭窗口后重试。' };
    })();
    return entry.closeResult;
  }

  return {
    open, close,
    isActive: profileId => active.has(profileId),
    closeAll: () => { shuttingDown = true; return Promise.all([...active.keys()].map(close)); },
  };
}
