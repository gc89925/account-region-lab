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
  const started = Date.now();
  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl', curlArgs(proxy), { windowsHide: true, timeout: 21000, maxBuffer: 65536,
      env: { ...process.env, ALL_PROXY: '', all_proxy: '', HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '' } }));
  } catch (error) {
    throw new Error(probeErrorMessage(error));
  }
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('出口检测服务返回了无效数据，未启动浏览器。'); }
  if (!isIP(data.ip)) throw new Error('出口检测未返回有效 IP，未启动浏览器。');
  return { ip: data.ip, country: countryCode(data.country), latencyMs: Date.now() - started };
}

export function probeErrorMessage(error) {
  const messages = {
    ENOENT: '没有找到 curl。请安装 curl，或修复系统 PATH 后重新启动工作台。',
    5: '无法解析代理主机。请检查代理地址是否填错。',
    6: '代理无法解析出口检测服务。请检查线路的 DNS 设置。',
    7: '无法连接代理端口。请先启动代理软件，确认 HTTP / SOCKS5 端口与填写的地址一致。',
    22: '出口检测服务返回错误。请检查线路，或稍后重试。',
    28: '代理出口检测超时。请确认该线路可以访问外网，再重试。',
    35: '代理线路的 TLS 连接失败。请检查线路后重试。',
    60: '出口检测的 HTTPS 证书校验失败。请检查系统时间或网络证书配置。',
    97: 'SOCKS5 代理握手失败。请核对协议与端口；有密码的代理请先在本地客户端配置认证。',
  };
  return (messages[error?.code] || '代理出口检测失败。请检查代理端口和网络；也可能是检测服务暂时不可用。') + ' 未启动浏览器。';
}

export async function probeGoogle(proxy) {
  const args = curlArgs(proxy);
  args[args.indexOf('--max-time') + 1] = '8';
  args[args.indexOf('--connect-timeout') + 1] = '5';
  args[args.length - 1] = 'https://accounts.google.com/';
  args.push('--head', '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}');
  try {
    const {stdout} = await execFileAsync('curl',args,{windowsHide:true,timeout:10000,maxBuffer:65536,
      env:{...process.env,ALL_PROXY:'',all_proxy:'',HTTPS_PROXY:'',https_proxy:'',HTTP_PROXY:'',http_proxy:'',NO_PROXY:'',no_proxy:''}});
    const code=Number(stdout.trim());
    return code>=200&&code<400;
  } catch { return false; }
}

export function launchBrowser(browserPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserPath, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    let timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (error) reject(error);
      else resolve({ pid: child.pid });
    };
    child.once('error', () => finish(new Error('无法启动浏览器。请确认已安装 Chrome / Edge，或检查 BROWSER_PATH。')));
    child.once('exit', (code, signal) => {
      if (signal || code !== 0) finish(new Error('浏览器启动后立即退出。请检查浏览器是否可正常打开，以及该环境目录是否被其他程序占用。'));
      // Chromium may pass the URL to an existing process and exit successfully.
      else finish();
    });
    child.once('spawn', () => { timer = setTimeout(() => finish(), 800); });
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
