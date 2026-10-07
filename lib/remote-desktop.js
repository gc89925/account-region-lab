import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READY = 'REGION_LAB_DESKTOP_READY';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// A detached POSIX process group includes the browser/desktop descendants. A
// slot must remain reserved until that entire group has stopped, not just its
// launcher process. Test doubles and Windows use the child's lifetime instead.
export function trackOwnedProcess(child, group = false) {
  const owned = { child, exited: false, group };
  child.once('exit', () => { owned.exited = true; });
  child.once('error', () => { owned.exited = true; });
  owned.alive = () => {
    if (!group) return !owned.exited;
    if (!child.pid) return !owned.exited;
    try {
      process.kill(-child.pid, 0);
      if (!owned.exited || process.platform !== 'linux') return true;
      // A terminated orphan can briefly remain as a zombie until PID 1 reaps
      // it. Zombies hold no sockets, displays or profile locks and must not
      // permanently consume an environment slot.
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        let stat;
        try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === child.pid && !['Z', 'X'].includes(fields[0])) return true;
      }
      return false;
    }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  owned.signal = signal => {
    if (!owned.alive()) return;
    try {
      if (group && child.pid && (signal === 'SIGKILL' || owned.exited)) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  return owned;
}

export async function stopOwnedProcess(owned, closeTimeout = 8000, killTimeout = 2000) {
  async function wait(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (owned.alive() && Date.now() < deadline) await pause(Math.min(20, Math.max(1, deadline - Date.now())));
    return !owned.alive();
  }
  if (!owned.alive()) return { ok: true, forced: false };
  owned.signal('SIGTERM');
  if (await wait(closeTimeout)) return { ok: true, forced: false };
  owned.signal('SIGKILL');
  return { ok: await wait(killTimeout), forced: true };
}

export function createDesktopManager({
  maxEnvironments = 5,
  runtimeRoot = process.env.REGION_LAB_DESKTOP_RUNTIME || '/run/account-region-lab/desktops',
  scriptPath = fileURLToPath(new URL('../deploy/linux/start-desktop.sh', import.meta.url)),
  launch = spawn,
  processGroups = launch === spawn && process.platform === 'linux',
  // Allow both bounded readiness stages to complete on a small shared VPS.
  readyTimeout = 45000,
  closeTimeout = 7000,
  killTimeout = 2000,
} = {}) {
  if (!Number.isInteger(maxEnvironments) || maxEnvironments < 1 || maxEnvironments > 5) throw new Error('并发环境数量必须介于 1 和 5 之间。');
  if (!path.isAbsolute(runtimeRoot) || !path.isAbsolute(scriptPath)) throw new Error('桌面运行目录和启动脚本必须使用绝对路径。');
  const entries = new Map();
  let shuttingDown = false;

  async function prepare(entry) {
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(runtimeRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || (process.platform !== 'win32' && ((rootStat.mode & 0o077) || rootStat.uid !== process.getuid()))) {
      throw new Error('桌面运行目录必须由服务用户独占。');
    }
    if (entry.closing) throw new Error('桌面启动已取消。');
    await mkdir(entry.directory, { mode: 0o700 });
    entry.createdDirectory = true;
    if (entry.closing) throw new Error('桌面启动已取消。');
    const env = { ...process.env, ...entry.runtime.env,
      REGION_LAB_DISPLAY: entry.runtime.env.DISPLAY,
      REGION_LAB_VNC_PORT: String(5902 + entry.slot),
      REGION_LAB_DESKTOP_PORT: String(entry.runtime.port),
    };
    delete env.NOTIFY_SOCKET;
    delete env.RUNTIME_DIRECTORY;
    const child = launch('/bin/bash', [scriptPath], { detached: processGroups, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env });
    entry.owned = trackOwnedProcess(child, processGroups);
    let output = '';
    child.stdout?.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 4096) output = output.slice(-4096);
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      if (lines.includes(READY)) entry.resolveReady();
    });
    child.once('error', () => {
      entry.rejectReady(new Error('服务器桌面无法启动，请检查桌面组件安装和运行目录。'));
      entry.resolveExit();
      queueMicrotask(() => { void close(entry.id); });
    });
    child.once('exit', () => {
      entry.rejectReady(new Error('服务器桌面已退出，请检查内存和桌面组件。'));
      entry.resolveExit();
      queueMicrotask(() => { void close(entry.id); });
    });
  }

  async function open(id) {
    if (!UUID.test(id || '')) throw new Error('环境 ID 必须是 UUID。');
    if (shuttingDown) throw new Error('服务器桌面正在停止。');
    const existing = entries.get(id);
    if (existing) {
      if (existing.closing) throw new Error('环境桌面正在关闭，请稍后重试。');
      return existing.ready;
    }
    const used = new Set([...entries.values()].map(entry => entry.slot));
    const slot = Array.from({ length: maxEnvironments }, (_, index) => index).find(index => !used.has(index));
    if (slot === undefined) throw new Error(`最多同时运行 ${maxEnvironments} 个服务器环境，请先关闭一个环境。`);
    const generation = randomBytes(16).toString('hex');
    const directory = path.join(runtimeRoot, `${id}-${generation}`);
    const entry = { id, slot, directory, closing: false, readyState: false };
    const exited = new Promise(resolve => { entry.resolveExit = resolve; });
    entry.runtime = { port: 6101 + slot, generation,
      // X clients may try TCP port 6000 + display before the Unix socket is
      // ready. Keep that fallback range distinct from the noVNC listeners.
      env: { DISPLAY: `:${200 + slot}`, XDG_RUNTIME_DIR: directory, XAUTHORITY: path.join(directory, 'Xauthority') }, exited };
    entry.marker = new Promise((resolve, reject) => { entry.resolveReady = resolve; entry.rejectReady = reject; });
    // Consume early failures even when filesystem preparation has not completed.
    entry.marker.catch(() => {});
    entries.set(id, entry);
    entry.prepared = prepare(entry);
    entry.ready = (async () => {
      let timer;
      try {
        await Promise.race([
          entry.prepared.then(() => entry.marker),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('服务器桌面启动超时，请检查内存和桌面组件。')), readyTimeout); }),
        ]);
        if (entry.closing || !entry.owned?.alive()) throw new Error('桌面启动已取消。');
        entry.readyState = true;
        return entry.runtime;
      } catch (error) {
        await close(id);
        throw error;
      } finally { clearTimeout(timer); }
    })();
    return entry.ready;
  }

  async function close(id) {
    const entry = entries.get(id);
    if (!entry) return { ok: true, closed: false };
    if (entry.closeResult) return entry.closeResult;
    entry.closing = true;
    entry.readyState = false;
    entry.rejectReady(new Error('桌面启动已取消。'));
    entry.closeResult = (async () => {
      await entry.prepared.catch(() => {});
      const result = entry.owned ? await stopOwnedProcess(entry.owned, closeTimeout, killTimeout) : { ok: true, forced: false };
      if (!result.ok) {
        entry.closeResult = null;
        return { ok: false, closed: false, code: 'DESKTOP_CLOSE_FAILED', message: '环境桌面仍在退出，端口已保留，请稍后重试关闭。' };
      }
      entry.resolveExit();
      if (entry.createdDirectory) await rm(entry.directory, { recursive: true, force: true });
      if (entries.get(id) === entry) entries.delete(id);
      return { ok: true, closed: true, forced: result.forced };
    })().catch(() => {
      entry.closeResult = null;
      return { ok: false, closed: false, code: 'DESKTOP_CLOSE_FAILED', message: '环境桌面清理尚未完成，端口已保留，请稍后重试关闭。' };
    });
    return entry.closeResult;
  }

  return {
    maxEnvironments, open, close,
    get: id => { const entry = entries.get(id); return entry?.readyState && !entry.closing ? entry.runtime : null; },
    closeAll: () => { shuttingDown = true; return Promise.all([...entries.keys()].map(close)); },
  };
}
