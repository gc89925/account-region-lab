import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { countryCode, validateProxy } from './model.js';

const execFileAsync = promisify(execFile);
export function defaultDataDir() {
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'AccountRegionLab');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'AccountRegionLab');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'AccountRegionLab');
}

export function detectBrowser() {
  const candidates = process.env.BROWSER_PATH ? [[process.env.BROWSER_PATH, '自定义浏览器']] : [
    [join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), 'Google Chrome'],
    [join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'), 'Google Chrome'],
    [join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'), 'Microsoft Edge'],
    [join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'), 'Microsoft Edge'],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
    ['/usr/bin/google-chrome', 'Google Chrome'], ['/usr/bin/chromium', 'Chromium'], ['/usr/bin/chromium-browser', 'Chromium'],
  ];
  const found = candidates.find(([file]) => existsSync(file));
  return found ? { path: found[0], name: found[1] } : null;
}

export function curlArgs(proxy) {
  const normalized = validateProxy(proxy);
  if (!normalized) throw new Error('请先配置固定代理。');
  return ['--disable', '--silent', '--show-error', '--fail', '--max-time', '18', '--connect-timeout', '10',
    '--max-filesize', '65536', '--proto', '=https', '--proxy', normalized.replace(/^socks5:/, 'socks5h:'),
    '--noproxy', '', 'https://api.country.is/'];
}

export async function probeProxy(proxy) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl', curlArgs(proxy), { windowsHide: true, timeout: 21000, maxBuffer: 65536,
      env: { ...process.env, ALL_PROXY: '', all_proxy: '', HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '' } }));
  } catch {
    throw new Error('代理出口检测失败。请检查代理端口和网络；也可能是检测服务暂时不可用。未启动浏览器。');
  }
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('出口检测服务返回了无效数据，未启动浏览器。'); }
  if (!isIP(data.ip)) throw new Error('出口检测未返回有效 IP，未启动浏览器。');
  return { ip: data.ip, country: countryCode(data.country) };
}

export function launchBrowser(browserPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserPath, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.once('error', () => reject(new Error('无法启动浏览器，请检查 BROWSER_PATH。')));
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }); });
  });
}

export function atomicSave(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

export function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, '.server.lock');
  try { writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const oldPid = Number(readFileSync(file, 'utf8'));
    let active = Number.isInteger(oldPid) && oldPid > 0;
    if (active) { try { process.kill(oldPid, 0); } catch (e) { if (e.code === 'ESRCH') active = false; } }
    if (active) throw new Error('该数据目录已有管理器在运行。请使用原窗口，或退出原进程后重试。');
    unlinkSync(file);
    writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch {} };
}
