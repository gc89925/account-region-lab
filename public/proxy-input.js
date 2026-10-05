const addressError = '代理地址格式无效。请填写带明确端口的 HTTP / SOCKS5 地址；认证链接中的特殊字符请使用 URL 百分号编码。';
const credentialError = 'SOCKS5 认证需要完整的用户名和密码，各为 1–255 个 UTF-8 字节，不能包含控制字符。';

export function parseProxyInput(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(addressError);
  const input = value.trim();
  if (!input) return { proxy: '', hasCredentials: false };
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error(addressError);
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)\/?$/i.exec(input);
  if (!match) throw new Error(addressError);
  const protocol = match[1].toLowerCase();
  if (!['http', 'socks5'].includes(protocol)) throw new Error(addressError);
  const authority = match[2];
  const separator = authority.lastIndexOf('@');
  const hasCredentials = separator !== -1;
  if (hasCredentials && protocol !== 'socks5') {
    throw new Error('当前仅支持 SOCKS5 用户名密码认证。HTTP 认证代理请先在本地代理客户端配置认证，再填写本地转发地址。');
  }
  const endpoint = hasCredentials ? authority.slice(separator + 1) : authority;
  const hostPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
  if (!hostPort || /[\s;\\]/.test(endpoint)) throw new Error(addressError);
  const port = Number(hostPort[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(addressError);
  let url;
  try { url = new URL(`${protocol}://${endpoint}`); } catch { throw new Error(addressError); }
  if (!url.hostname || url.username || url.password || url.search || url.hash) throw new Error(addressError);
  const proxy = `${protocol}://${url.hostname}:${port}`;
  if (proxy.length > 260) throw new Error(addressError);
  if (!hasCredentials) return { proxy, hasCredentials: false };
  const userInfo = authority.slice(0, separator);
  const passwordSeparator = userInfo.indexOf(':');
  if (passwordSeparator < 1) throw new Error(credentialError);
  let proxyUsername, proxyPassword;
  try {
    proxyUsername = decodeURIComponent(userInfo.slice(0, passwordSeparator));
    proxyPassword = decodeURIComponent(userInfo.slice(passwordSeparator + 1));
  } catch { throw new Error('代理认证的百分号编码无效。请重新复制完整链接，或分别填写用户名和密码。'); }
  const encoder = new TextEncoder();
  if (!proxyUsername || !proxyPassword || encoder.encode(proxyUsername).length > 255 || encoder.encode(proxyPassword).length > 255 || /[\x00-\x1f\x7f]/.test(proxyUsername + proxyPassword)) {
    throw new Error(credentialError);
  }
  return { proxy, hasCredentials: true, proxyUsername, proxyPassword };
}

export function applyProxyInput({ proxy, username, password, clearAuth }, value) {
  if (proxy.disabled || proxy.readOnly || username.readOnly || password.readOnly ||
      ((username.disabled || password.disabled) && !clearAuth?.checked)) {
    return { applied: false, reason: 'locked' };
  }
  let parsed;
  try { parsed = parseProxyInput(value); } catch (error) {
    // A malformed credential link must not remain visible in the address field.
    if (typeof value === 'string' && value.includes('@')) proxy.value = '';
    throw error;
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
