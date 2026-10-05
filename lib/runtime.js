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

const GEO_PROVIDERS = [
  { url: 'https://api.country.is/', parse: data => ({ ip: data.ip, country: data.country }) },
  { url: 'https://ipwho.is/', parse: data => data.success === true ? { ip: data.ip, country: data.country_code } : null },
];

const curlEnv = () => ({ ...process.env, ALL_PROXY: '', all_proxy: '', HTTPS_PROXY: '', https_proxy: '',
  HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '' });

export function curlArgs(proxy, url = GEO_PROVIDERS[0].url) {
  const normalized = validateProxy(proxy);
  if (!normalized) throw new Error('请先配置固定代理。');
  return ['--disable', '--silent', '--show-error', '--fail', '--max-time', '8', '--connect-timeout', '5',
    '--max-filesize', '65536', '--proto', '=https', '--proxy', normalized.replace(/^socks5:/, 'socks5h:'),
    '--noproxy', '', url];
}

function diagnostic(code, stage, message, curlCode = null, extra = {}) {
  return { code, stage, message, curlCode, retryable: false, ...extra };
}

// Read only known curl error signatures; never return raw stderr, URLs or credentials.
export function proxyErrorDetails(error) {
  const curlCode = Number.isInteger(Number(error?.code)) ? Number(error.code) : null;
  const stderr = String(error?.stderr || '').slice(0, 65536);
  if (error?.code === 'ENOENT') return diagnostic('curl_missing', 'setup', '没有找到 curl。请安装 curl，或修复系统 PATH 后重新启动工作台。');
  if (/No authentication method was acceptable|no acceptable authentication method|BASIC authentication proposed but not enabled/i.test(stderr)) {
    return diagnostic('proxy_auth_required', 'proxy_auth', 'SOCKS5 代理不接受无认证连接，需要提供代理账号密码或供应商要求的认证方式。', curlCode);
  }
  if (/User was rejected by the SOCKS5 server/i.test(stderr)) {
    return diagnostic('proxy_auth_rejected', 'proxy_auth', 'SOCKS5 代理拒绝了账号密码认证。请检查凭据、授权来源 IP 和套餐是否有效。', curlCode);
  }
  if (/GSSAPI|GSS-API/i.test(stderr) && curlCode === 97) {
    return diagnostic('proxy_auth_unsupported', 'proxy_auth', 'SOCKS5 代理要求 GSSAPI 认证，当前连接方式不支持。请使用供应商的本地客户端。', curlCode);
  }
  if (/invalid version in initial SOCKS5|SOCKS5 reply has wrong version|Unknown SOCKS5 mode|SOCKS5 reply has wrong address type/i.test(stderr)) {
    return diagnostic('proxy_protocol_mismatch', 'proxy_protocol', '端口返回的内容不符合 SOCKS5 协议。可能填入了 HTTP 代理端口；请运行协议诊断后再修改。', curlCode);
  }
  const reply = /cannot complete SOCKS5 connection[^\r\n]*\((\d+)\)/i.exec(stderr);
  if (reply) {
    const socksReply = Number(reply[1]);
    const replies = {
      1: ['socks_server_failure', 'SOCKS5 代理已响应，但代理服务器无法完成目标连接。'],
      2: ['socks_target_denied', 'SOCKS5 代理拒绝访问检测目标（规则或权限限制）。'],
      3: ['socks_network_unreachable', 'SOCKS5 代理已响应，但代理服务器无法连接目标网络。'],
      4: ['socks_host_unreachable', 'SOCKS5 代理已响应，但目标主机不可达；也可能是代理端 DNS 失败。'],
      5: ['socks_target_refused', 'SOCKS5 代理已响应，但到检测目标的连接被拒绝。'],
      6: ['socks_ttl_expired', 'SOCKS5 代理到目标的连接超时（TTL 已过期）。'],
      7: ['socks_command_unsupported', 'SOCKS5 代理不支持 CONNECT 连接命令。'],
      8: ['socks_address_unsupported', 'SOCKS5 代理不支持域名地址请求。请检查代理的远程 DNS 支持。'],
    };
    const [code, message] = replies[socksReply] || ['socks_unknown_reply', 'SOCKS5 代理返回了未定义的目标连接错误。'];
    return diagnostic(code, 'target_connect', message, curlCode, { socksReply, retryable: socksReply >= 1 && socksReply <= 6 });
  }
  if (/resolving SOCKS destination|Failed to resolve[^\r\n]*SOCKS5/i.test(stderr)) {
    return diagnostic('target_dns_failed', 'target_dns', '代理无法解析检测目标。请检查线路的 DNS 设置。', curlCode, { retryable: true });
  }
  const httpMatch = /(?:CONNECT tunnel failed, response|requested URL returned error:|Received HTTP code)\s*(\d{3})/i.exec(stderr);
  const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
  if (httpStatus === 407) return diagnostic('proxy_auth_required', 'proxy_auth', 'HTTP 代理要求账号密码认证（HTTP 407）。请检查代理凭据与来源 IP 授权。', curlCode, { httpStatus });
  if (httpStatus && /CONNECT tunnel|from proxy after CONNECT/i.test(stderr)) {
    return diagnostic('http_connect_rejected', 'target_connect', `HTTP 代理拒绝了 HTTPS 隧道请求（HTTP ${httpStatus}）。请检查目标访问规则或线路状态。`, curlCode, { httpStatus, retryable: httpStatus >= 500 });
  }
  const messages = {
    5: ['proxy_dns_failed', 'proxy_dns', '无法解析代理主机。请检查代理地址是否填错。'],
    6: ['target_dns_failed', 'target_dns', '代理无法解析出口检测服务。请检查线路的 DNS 设置。', true],
    7: ['proxy_unreachable', 'proxy_connect', '无法连接代理端口。请先启动代理软件，确认地址和端口可达。'],
    22: ['probe_http_failed', 'probe_service', '出口检测服务返回 HTTP 错误，可能是该检测站点被线路限制。', true],
    28: ['proxy_timeout', 'timeout', '代理连接或出口请求超时。请检查线路状态；超时本身不能证明协议或密码错误。', true],
    35: ['tls_failed', 'tls', '代理到检测目标的 TLS 连接失败。请检查线路。', true],
    52: ['proxy_empty_response', 'proxy_protocol', '连接未返回有效响应。可能是协议不匹配、代理拒绝连接或服务中断。'],
    56: ['proxy_receive_failed', 'proxy_protocol', '连接在接收响应时中断。请诊断协议，并检查代理的认证与访问限制。'],
    60: ['tls_certificate_invalid', 'tls', '出口检测的 HTTPS 证书校验失败。请检查系统时间或网络证书配置。'],
    97: ['socks_handshake_incomplete', 'proxy_protocol', 'SOCKS5 协商未完成，代理关闭连接或返回了不完整响应。请运行协议诊断查看是否为 HTTP 端口。'],
  };
  if (error?.killed) return diagnostic('proxy_timeout', 'timeout', '代理检测超过时间限制。请检查线路状态。', curlCode, { retryable: true });
  const [code, stage, message, retryable = false] = messages[curlCode] || ['proxy_probe_failed', 'proxy_connect', '代理出口检测失败。请检查代理端口和网络。'];
  return diagnostic(code, stage, message, curlCode, { retryable, ...(httpStatus ? { httpStatus } : {}) });
}

export function probeErrorMessage(error) {
  return proxyErrorDetails(error).message + ' 未启动浏览器。';
}

class ProxyProbeError extends Error {
  constructor(details) {
    super(details.message + ' 未启动浏览器。');
    this.diagnostic = details;
  }
}

export async function probeProxy(proxy, { runCurl = execFileAsync } = {}) {
  const normalized = validateProxy(proxy);
  if (!normalized) throw new Error('请先配置固定代理。');
  const started = Date.now();
  let lastError;
  for (const provider of GEO_PROVIDERS) {
    try {
      const { stdout } = await runCurl('curl', curlArgs(normalized, provider.url), {
        windowsHide: true, timeout: 9500, maxBuffer: 65536, env: curlEnv(),
      });
      let result;
      try {
        result = provider.parse(JSON.parse(stdout));
        if (!result || !isIP(result.ip)) throw new Error('Invalid IP');
        result.country = countryCode(result.country);
      } catch {
        throw new ProxyProbeError(diagnostic('probe_invalid_response', 'probe_service', '出口检测服务未返回有效的 IP 和国家数据。', null, { retryable: true }));
      }
      return { ...result, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error instanceof ProxyProbeError ? error : new ProxyProbeError(proxyErrorDetails(error));
      // Another HTTPS provider can distinguish a blocked probe host from a dead proxy.
      // A failed proxy connection/authentication is not repaired by changing the target.
      if (!lastError.diagnostic.retryable) throw lastError;
    }
  }
  throw lastError;
}

export async function diagnoseProxy(proxy, { tryAlternateProtocol = true, runCurl = execFileAsync } = {}) {
  const normalized = validateProxy(proxy);
  if (!normalized) throw new Error('请先配置固定代理。');
  const configuredProtocol = new URL(normalized).protocol.slice(0, -1);
  const result = { ok: false, configuredProtocol };
  try {
    result.probe = await probeProxy(normalized, { runCurl });
    result.ok = true;
  } catch (error) {
    result.error = error.diagnostic || proxyErrorDetails(error);
  }
  // A valid SOCKS reply (including authentication/target failure) already proves the
  // selected protocol. Only test the alternative for ambiguous protocol responses.
  if (!result.ok && tryAlternateProtocol && ['proxy_protocol', 'timeout'].includes(result.error.stage)) {
    const protocol = configuredProtocol === 'socks5' ? 'http' : 'socks5';
    const alternate = { protocol, ok: false };
    try {
      alternate.probe = await probeProxy(normalized.replace(/^[^:]+:/, `${protocol}:`), { runCurl });
      alternate.ok = true;
      result.suggestedProtocol = protocol;
    } catch (error) {
      alternate.error = error.diagnostic || proxyErrorDetails(error);
    }
    result.alternateProtocol = alternate;
  }
  return result;
}

export async function probeGoogle(proxy) {
  const args = curlArgs(proxy);
  args[args.indexOf('--max-time') + 1] = '8';
  args[args.indexOf('--connect-timeout') + 1] = '5';
  args[args.length - 1] = 'https://accounts.google.com/';
  args.push('--head', '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}');
  try {
    const {stdout} = await execFileAsync('curl',args,{windowsHide:true,timeout:10000,maxBuffer:65536,
      env:curlEnv()});
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
