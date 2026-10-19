import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION = /^[a-f0-9]{32}$/;
const MAX_BYTES = 12 * 1024;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function failure(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}
const unavailable = () => failure('CLIPBOARD_UNAVAILABLE', '远程剪贴板暂不可用，请检查服务器剪贴板组件后重试。');
const stale = () => failure('DESKTOP_STALE', '此环境已关闭或重新启动，请刷新远程窗口后重试。', 409);

// Each environment has its own X server and authority file. Keep xclip in the
// foreground so its selection owner can be replaced, expired and stopped by us.
export function createRemoteClipboard({
  runtimeRoot = process.env.REGION_LAB_DESKTOP_RUNTIME || '/run/account-region-lab/desktops',
  spawnProcess = spawn,
  resolveDesktop,
  persistenceSeconds = 120,
  operationTimeout = 3000,
  readTimeout = 600,
  pollInterval = 30,
  stopTimeout = 150,
} = {}) {
  if (!path.isAbsolute(runtimeRoot) || typeof resolveDesktop !== 'function') throw new TypeError('剪贴板需要绝对运行目录和桌面解析器。');
  for (const value of [persistenceSeconds, operationTimeout, readTimeout, pollInterval, stopTimeout]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('剪贴板超时必须为正数。');
  }
  const owners = new Map();
  const children = new Set();
  const queues = new Map();
  let closed = false;
  let closePromise;
  let notifyClosed;
  const closing = new Promise(resolve => { notifyClosed = resolve; });

  function assertOpen() {
    if (closed) throw failure('CLIPBOARD_CLOSED', '远程剪贴板服务正在停止，请稍后重试。');
  }

  async function bounded(promise, milliseconds, timeoutValue) {
    let timer;
    try {
      const result = await Promise.race([promise, closing, new Promise(resolve => { timer = setTimeout(() => resolve(timeoutValue), milliseconds); })]);
      assertOpen();
      return result;
    } finally { clearTimeout(timer); }
  }

  async function desktopPort(request, expected) {
    assertOpen();
    assertAuthorized(request);
    let port;
    try { port = await bounded(resolveDesktop({ profileId: request.profileId, generation: request.generation }), operationTimeout, null); }
    catch { assertOpen(); throw stale(); }
    assertOpen();
    assertAuthorized(request);
    if (!Number.isInteger(port) || port < 6101 || port > 6105 || (expected !== undefined && expected !== port)) throw stale();
    return port;
  }

  function assertAuthorized(request) {
    let authorized = false;
    try { authorized = request.isAuthorized(); } catch {}
    if (!authorized) throw failure('CLIPBOARD_UNAUTHORIZED', '登录会话已失效，请重新登录后重试。', 401);
  }

  async function authority(request, port) {
    const directory = path.join(runtimeRoot, `${request.profileId}-${request.generation}`);
    const authFile = path.join(directory, 'Xauthority');
    try {
      const actualRoot = await realpath(runtimeRoot);
      const expectedRoot = path.resolve(runtimeRoot);
      if ((process.platform === 'win32' ? actualRoot.toLowerCase() !== expectedRoot.toLowerCase() : actualRoot !== expectedRoot)) throw unavailable();
      for (const [filename, isDirectory, mode] of [[runtimeRoot, true, 0o700], [directory, true, 0o700], [authFile, false, 0o600]]) {
        const stat = await lstat(filename);
        if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())
            || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode))) throw unavailable();
      }
    } catch { throw unavailable(); }
    // Do not inherit another environment's DISPLAY or session credentials.
    return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      DISPLAY: `:${200 + port - 6101}`, XAUTHORITY: authFile, XDG_RUNTIME_DIR: directory };
  }

  function launch(executable, args, env, { input, capture = false } = {}) {
    assertOpen();
    let child;
    try {
      child = spawnProcess(executable, args, {
        env, shell: false, windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch { throw unavailable(); }
    const entry = { child, exited: false, overflow: false, output: [], size: 0 };
    entry.done = new Promise(resolve => { entry.finish = resolve; });
    children.add(entry);
    const finish = code => {
      if (entry.exited) return;
      entry.exited = true;
      entry.code = code;
      children.delete(entry);
      entry.finish(code);
    };
    child.once('error', () => finish(-1));
    child.once('close', code => finish(code));
    if (capture) child.stdout?.on('data', chunk => {
      if (entry.overflow) return;
      const bytes = Buffer.from(chunk);
      entry.size += bytes.length;
      if (entry.size > MAX_BYTES) {
        entry.overflow = true;
        entry.output = [];
        try { child.kill('SIGKILL'); } catch {}
      } else entry.output.push(bytes);
    });
    if (input !== undefined) {
      child.stdin?.on('error', () => {});
      try { child.stdin.end(input); }
      catch { void stop(entry); throw unavailable(); }
    }
    return entry;
  }

  async function stop(entry) {
    if (!entry || entry.exited) return true;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { entry.child.kill(signal); } catch {}
      await Promise.race([entry.done, delay(stopTimeout)]);
      if (entry.exited) return true;
    }
    return false;
  }

  async function release(profileId, entry) {
    clearTimeout(entry.timer);
    const stopped = await stop(entry.process);
    if (stopped && owners.get(profileId) === entry) owners.delete(profileId);
    return stopped;
  }

  async function readSelection(env, milliseconds) {
    const entry = launch('xclip', ['-selection', 'clipboard', '-out', '-target', 'UTF8_STRING'], env, { capture: true });
    const timedOut = Symbol('timeout');
    const result = await bounded(entry.done, milliseconds, timedOut);
    if (result === timedOut) { await stop(entry); return null; }
    if (result !== 0 || entry.overflow) return null;
    return Buffer.concat(entry.output);
  }

  async function perform(request, bytes) {
    assertOpen();
    assertAuthorized(request);
    const port = await desktopPort(request);
    const env = await authority(request, port);
    await desktopPort(request, port);
    const previous = owners.get(request.profileId);
    if (previous && !await release(request.profileId, previous)) throw unavailable();
    assertOpen();
    assertAuthorized(request);
    if (owners.size >= 5) throw failure('CLIPBOARD_BUSY', '远程剪贴板已达到并发上限，请稍后重试。', 429);
    const entry = { generation: request.generation };
    owners.set(request.profileId, entry);
    try {
      entry.process = launch('xclip', ['-selection', 'clipboard', '-in', '-target', 'UTF8_STRING', '-quiet'], env, { input: bytes });
      const deadline = Date.now() + operationTimeout;
      let verified = false;
      while (Date.now() < deadline) {
        assertOpen();
        assertAuthorized(request);
        if (entry.process.exited) throw unavailable();
        const readback = await readSelection(env, Math.min(readTimeout, Math.max(1, deadline - Date.now())));
        if (readback?.equals(bytes)) { verified = true; break; }
        await delay(pollInterval);
      }
      if (!verified) throw failure('CLIPBOARD_TIMEOUT', '远程剪贴板写入验证超时，请重试。', 504);
      await desktopPort(request, port);
      if (entry.process.exited) throw unavailable();
      if (request.paste) {
        assertAuthorized(request);
        const paste = launch('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], env);
        const timedOut = Symbol('timeout');
        const result = await bounded(paste.done, operationTimeout, timedOut);
        if (result === timedOut) {
          await stop(paste);
          throw failure('CLIPBOARD_TIMEOUT', '远程粘贴超时，请重新选择输入框后重试。', 504);
        }
        if (result !== 0) throw unavailable();
      }
      assertOpen();
      entry.timer = setTimeout(() => { void release(request.profileId, entry); }, persistenceSeconds * 1000);
      entry.timer.unref?.();
      // If another app replaces the selection, xclip exits by itself.
      void entry.process.done.then(() => {
        clearTimeout(entry.timer);
        if (owners.get(request.profileId) === entry) owners.delete(request.profileId);
      });
      return { ok: true, pasted: request.paste, persistenceSeconds };
    } catch (error) {
      await release(request.profileId, entry);
      if (error?.code?.startsWith('CLIPBOARD_') || error?.code === 'DESKTOP_STALE') throw error;
      throw unavailable();
    }
  }

  function send(request = {}) {
    const { profileId, generation, text, paste = false, isAuthorized = () => true } = request || {};
    if (typeof profileId !== 'string' || !UUID.test(profileId) || typeof generation !== 'string' || !GENERATION.test(generation)
        || typeof text !== 'string' || !text.length || !text.isWellFormed() || text.includes('\0') || typeof paste !== 'boolean' || typeof isAuthorized !== 'function'
        || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      return Promise.reject(failure('CLIPBOARD_INVALID', '请提供有效环境和不超过 12 KB 的纯文本。', 400));
    }
    // Reject overlapping sends instead of queuing keystrokes for a later focus.
    // Other profiles can still send to their own isolated displays concurrently.
    if (queues.has(profileId)) return Promise.reject(failure('CLIPBOARD_BUSY', '此环境正在传送文本，请稍后重试。', 409));
    const pending = Promise.resolve().then(() => perform({ profileId, generation, paste, isAuthorized }, Buffer.from(text, 'utf8')));
    queues.set(profileId, pending);
    void pending.finally(() => { if (queues.get(profileId) === pending) queues.delete(profileId); }).catch(() => {});
    return pending;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    notifyClosed();
    closePromise = (async () => {
      for (const entry of owners.values()) clearTimeout(entry.timer);
      await Promise.all([...children].map(stop));
      await Promise.allSettled([...queues.values()]);
      await Promise.all([...children].map(stop));
      owners.clear();
    })();
    return closePromise;
  }

  return { send, close };
}
