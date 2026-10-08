import { getProxySessionOptions } from './proxy-session.js';

const addressError = '代理地址格式无效。请填写带明确端口的 HTTP / SOCKS5 地址，或 主机:端口:用户名:密码；认证链接中的特殊字符请使用 URL 百分号编码。';
const credentialError = 'SOCKS5 认证需要完整的用户名和密码，各为 1–255 个 UTF-8 字节，不能包含控制字符。';
const batchError = '检测到多条代理，但分隔位置不明确。请将每条完整代理放在单独一行后重新粘贴。';
const httpAuthError = '当前仅支持 SOCKS5 用户名密码认证。若供应商同时支持 SOCKS5，请选择 SOCKS5 并核对其端口；否则请使用支持认证的转发客户端。';
const rawPattern = /^(\[[^\]]+\]|[^:\s/\\;?#@]+):(\d+)(?::([^:]*):(.*))?$/;
const knownResidentialHost = 'geo.iproyal.com';
const maxEntries = 100;

function credentials(proxyUsername, proxyPassword) {
  const encoder = new TextEncoder();
  if (typeof proxyUsername !== 'string' || typeof proxyPassword !== 'string' || !proxyUsername || !proxyPassword || encoder.encode(proxyUsername).length > 255 || encoder.encode(proxyPassword).length > 255 || /[\x00-\x1f\x7f]/.test(proxyUsername + proxyPassword)) {
    throw new Error(credentialError);
  }
  return { proxyUsername, proxyPassword };
}

function normalizedProxy(protocol, endpoint) {
  const hostPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
  if (!hostPort || /[\s;\\/?#@]/.test(endpoint)) throw new Error(addressError);
  const port = Number(hostPort[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(addressError);
  let url;
  try { url = new URL(`${protocol}://${endpoint}`); } catch { throw new Error(addressError); }
  if (!url.hostname || url.username || url.password || url.search || url.hash) throw new Error(addressError);
  const proxy = `${protocol}://${url.hostname}:${port}`;
  if (proxy.length > 260) throw new Error(addressError);
  return proxy;
}

function residentialMetadata(parsed) {
  if (!parsed.hasCredentials || new URL(parsed.proxy).hostname.toLowerCase() !== knownResidentialHost) return parsed;
  const country = /(?:^|_)country-([a-z]{2})(?=_|$)/i.exec(parsed.proxyPassword)?.[1];
  const session = /(?:^|_)session-([a-z0-9]+)(?=_|$)/i.exec(parsed.proxyPassword)?.[1];
  return {
    ...parsed,
    ...(country ? { country: country.toUpperCase() } : {}),
    ...(session ? { sessionHint: session.length > 5 ? `${session.slice(0, 2)}…${session.slice(-2)}` : '••••' } : {})
  };
}

function parseSingle(input, protocolOption) {
  if (input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw new Error(addressError);
  const uri = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)\/?$/i.exec(input);
  if (uri) {
    const protocol = uri[1].toLowerCase();
    if (!['http', 'socks5'].includes(protocol)) throw new Error(addressError);
    const authority = uri[2];
    const separator = authority.lastIndexOf('@');
    const hasCredentials = separator !== -1;
    if (hasCredentials && authority.indexOf('@') !== separator) throw new Error(batchError);
    if (hasCredentials && protocol !== 'socks5') throw new Error(httpAuthError);
    const endpoint = hasCredentials ? authority.slice(separator + 1) : authority;
    const proxy = normalizedProxy(protocol, endpoint);
    if (!hasCredentials) return { proxy, hasCredentials: false };
    const userInfo = authority.slice(0, separator);
    const passwordSeparator = userInfo.indexOf(':');
    if (passwordSeparator < 1) throw new Error(credentialError);
    let proxyUsername, proxyPassword;
    try {
      proxyUsername = decodeURIComponent(userInfo.slice(0, passwordSeparator));
      proxyPassword = decodeURIComponent(userInfo.slice(passwordSeparator + 1));
    } catch { throw new Error('代理认证的百分号编码无效。请重新复制完整链接，或分别填写用户名和密码。'); }
    return residentialMetadata({ proxy, hasCredentials: true, ...credentials(proxyUsername, proxyPassword) });
  }
  const raw = rawPattern.exec(input);
  if (!raw) throw new Error(addressError);
  const hasCredentials = raw[3] !== undefined;
  // Port 12321 on IPRoyal's current residential gateway supports SOCKS5 as
  // well as HTTP. Never infer a protocol for an unknown provider or port.
  // https://iproyal.com/quick-start-guides/ip-whitelisting-authentication/
  const protocolAssumed = protocolOption === 'auto';
  const knownSocksEndpoint = raw[1].toLowerCase() === knownResidentialHost && Number(raw[2]) === 12321;
  if (protocolAssumed && !knownSocksEndpoint) {
    throw new Error('这段代理没有协议，无法仅凭端口判断。请先选择供应商提供的 SOCKS5 或 HTTP 协议，再重新粘贴。');
  }
  const protocol = protocolAssumed ? 'socks5' : protocolOption;
  if (hasCredentials && protocol !== 'socks5') throw new Error(httpAuthError);
  const proxy = normalizedProxy(protocol, `${raw[1]}:${raw[2]}`);
  return residentialMetadata({
    proxy, hasCredentials,
    ...(hasCredentials ? credentials(raw[3], raw[4]) : {}),
    ...(protocolAssumed ? { protocolAssumed: true } : {})
  });
}

function splitLine(input) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    // A second scheme cannot safely be treated as part of a pasted URI's password.
    if ((input.match(/[a-z][a-z0-9+.-]*:\/\//gi) || []).length > 1) throw new Error(batchError);
    return [input];
  }
  const raw = rawPattern.exec(input);
  if (!raw || raw[3] === undefined) return [input];
  const endpointPrefix = `${raw[1]}:${raw[2]}:`;
  const search = input.toLowerCase();
  const prefix = endpointPrefix.toLowerCase();
  const boundaries = [];
  let from = endpointPrefix.length;
  for (;;) {
    const at = search.indexOf(prefix, from);
    if (at === -1) break;
    boundaries.push(at);
    from = at + endpointPrefix.length;
  }
  if (!boundaries.length) {
    // A different endpoint pasted directly after a password is ambiguous.
    // Reject endpoint-looking tails rather than silently storing the next row as a password.
    if (/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+\.[a-z0-9.-]+):\d{1,5}:[^:\s]+:/i.test(raw[4])) throw new Error(batchError);
    return [input];
  }
  if (raw[1].toLowerCase() !== knownResidentialHost || ![12321, 32325].includes(Number(raw[2]))) throw new Error(batchError);
  const starts = [0, ...boundaries];
  const entries = starts.map((start, index) => input.slice(start, starts[index + 1] ?? input.length));
  // Accept complete provider routing suffixes in any documented order. Each
  // row must independently contain a valid session/lifetime boundary; the next
  // endpoint must never become part of a password or an optional route value.
  if (!entries.every(entry => {
    const part = rawPattern.exec(entry);
    if (!part || !part[3] || `${part[1]}:${part[2]}:`.toLowerCase() !== prefix) return false;
    try {
      const options = getProxySessionOptions(`socks5://${part[1]}:${part[2]}`, { username: part[3], password: part[4] });
      return Boolean(options.session && options.lifetime);
    } catch { return false; }
  })) throw new Error(batchError);
  return entries;
}

export function parseProxyInputs(value, { protocol = 'auto' } = {}) {
  if (typeof value !== 'string' || value.length > 65536 || !['auto', 'http', 'socks5'].includes(protocol)) throw new Error(addressError);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(addressError);
  const lines = value.trim().split(/\r?\n|\r/).map(line => line.trim()).filter(Boolean);
  const entries = lines.flatMap(splitLine);
  if (entries.length > maxEntries) throw new Error(`一次最多导入 ${maxEntries} 条代理，请分批粘贴。`);
  return entries.map(input => parseSingle(input, protocol));
}

export function parseProxyInput(value, options) {
  const entries = parseProxyInputs(value, options);
  if (entries.length > 1) throw new Error('检测到多条代理。请使用批量导入列表选择其中一条，或仅粘贴一条完整代理。');
  return entries[0] || { proxy: '', hasCredentials: false };
}

export function applyParsedProxyInput({ proxy, username, password, clearAuth }, parsed) {
  if (proxy.disabled || proxy.readOnly || username.readOnly || password.readOnly ||
      ((username.disabled || password.disabled) && !clearAuth?.checked)) {
    return { applied: false, reason: 'locked' };
  }
  // Validate again before changing fields; callers may edit a parsed item's
  // protocol after choosing it from a batch selector.
  if (!parsed || typeof parsed.proxy !== 'string') throw new Error(addressError);
  let protocol;
  try { protocol = new URL(parsed.proxy || 'socks5://placeholder.invalid:1').protocol.slice(0, -1); } catch { throw new Error(addressError); }
  if (!['http', 'socks5'].includes(protocol)) throw new Error(addressError);
  if (parsed.hasCredentials) {
    if (protocol !== 'socks5') throw new Error(httpAuthError);
    credentials(parsed.proxyUsername, parsed.proxyPassword);
  }
  if (parsed.proxy) {
    const verified = parseProxyInput(parsed.proxy);
    if (verified.hasCredentials) throw new Error(addressError);
  }
  proxy.value = parsed.proxy;
  if (parsed.hasCredentials) {
    username.value = parsed.proxyUsername;
    password.value = parsed.proxyPassword;
    username.disabled = false;
    password.disabled = false;
    if (clearAuth) clearAuth.checked = false;
  }
  return { ...parsed, applied: true };
}

export function applyProxyInput(fields, value, options) {
  const { proxy, username, password, clearAuth } = fields;
  if (proxy.disabled || proxy.readOnly || username.readOnly || password.readOnly ||
      ((username.disabled || password.disabled) && !clearAuth?.checked)) {
    return { applied: false, reason: 'locked' };
  }
  let parsed;
  try { parsed = parseProxyInput(value, options); } catch (error) {
    // Neither invalid URIs nor raw credential exports may remain visible.
    if (typeof value === 'string' && (value.includes('@') || /:[^:]*:/.test(value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')))) proxy.value = '';
    throw error;
  }
  return applyParsedProxyInput(fields, parsed);
}
