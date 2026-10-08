// Shared browser/server inspection. Metadata never includes authentication
// values; the fingerprint is only a display identifier for country + session.
// Provider semantics: https://docs.iproyal.com/proxies/residential/proxy/rotation
const providerHost = 'geo.iproyal.com';
const knownKeys = new Set(['country', 'session', 'lifetime', 'streaming', 'killswitch', 'forcerandom', 'region', 'city', 'state', 'isp', 'geolocation', 'skipipslist', 'skipispstatic']);
const suffixStart = /_(?:country|session|lifetime|streaming|killswitch|forcerandom|region|city|state|isp|geolocation|skipipslist|skipispstatic)-/i;
const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 };

function isProvider(proxy) {
  try { return new URL(proxy).hostname.toLowerCase() === providerHost; } catch { return false; }
}

function issue(issues, code, message) {
  if (!issues.some(item => item.code === code && item.message === message)) issues.push({ code, message });
}

function parseOptions(password, issues) {
  const match = suffixStart.exec(password);
  const options = new Map();
  if (!match) return options;
  if (match.index === 0) issue(issues, 'missing_password', 'IPRoyal 认证缺少基础密码。请重新粘贴供应商导出的完整代理。');
  for (const token of password.slice(match.index + 1).split('_')) {
    const pair = /^([a-z][a-z0-9]*)-(.*)$/i.exec(token);
    if (!pair) {
      issue(issues, 'malformed_parameter', 'IPRoyal 参数格式不完整。请重新粘贴供应商导出的完整代理。');
      continue;
    }
    const key = pair[1].toLowerCase();
    if (!knownKeys.has(key)) {
      issue(issues, 'unknown_parameter', 'IPRoyal 代理包含未识别的参数。请核对供应商导出的完整代理，避免手工拼接。');
      continue;
    }
    if (key !== pair[1]) issue(issues, 'invalid_parameter_name', 'IPRoyal 参数名称需要使用供应商导出的原始小写格式。请重新粘贴完整代理。');
    if (options.has(key)) {
      issue(issues, 'duplicate_parameter', `IPRoyal 的 ${key} 参数重复。请只保留一条完整代理后重新粘贴。`);
      continue;
    }
    options.set(key, pair[2]);
    if (!pair[2]) issue(issues, 'empty_parameter', `IPRoyal 的 ${key} 参数缺少值。请重新粘贴完整代理。`);
  }
  return options;
}

// Non-security identifier. Hash only public routing metadata, never the base
// password or username; the server must use its own secret binding identifier.
function fingerprint(country, session) {
  let hash = 2166136261;
  for (const char of `${country || ''}:${session}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function inspectProxySession(proxy, auth = {}) {
  const result = {
    provider: null, country: null, countries: [], sessionHint: null,
    sessionFingerprint: null, lifetime: null, hours: null,
    killswitch: false, streaming: false, rotating: false, issues: []
  };
  if (!isProvider(proxy)) return result;
  result.provider = 'iproyal';
  const password = typeof auth?.password === 'string' ? auth.password : '';
  const username = typeof auth?.username === 'string' ? auth.username : '';
  if (!password || !username) issue(result.issues, 'missing_auth', 'IPRoyal 固定出口需要完整用户名和密码参数。请重新粘贴供应商导出的完整代理。');
  const encoder = new TextEncoder();
  if (/[\x00-\x1f\x7f]/.test(username + password) || encoder.encode(username).length > 255 || encoder.encode(password).length > 255) {
    issue(result.issues, 'invalid_auth', 'IPRoyal 认证字段不能包含控制字符，且用户名和密码各不能超过 255 个 UTF-8 字节。请重新粘贴完整代理。');
  }
  const options = parseOptions(password, result.issues);
  const country = options.get('country');
  if (country === undefined) {
    issue(result.issues, 'missing_country', '缺少 IPRoyal 的 country 国家参数。请重新导出指定单个国家的代理。');
  } else if (!/^[a-z]{2}(?:,[a-z]{2})*$/i.test(country)) {
    issue(result.issues, 'invalid_country', 'IPRoyal 的 country 参数必须是两个字母的国家代码，多国之间使用逗号。');
  } else {
    result.countries = country.toUpperCase().split(',');
    if (result.countries.length === 1) result.country = result.countries[0];
  }
  const session = options.get('session');
  if (session === undefined) {
    issue(result.issues, 'missing_session', '缺少 IPRoyal 的 session 参数；未配置固定会话时出口可能逐次变化。请粘贴含固定会话的完整代理。');
  } else if (!/^[a-z0-9]{8}$/i.test(session)) {
    issue(result.issues, 'invalid_session', 'IPRoyal 的 session 必须是 8 位字母或数字。请重新粘贴供应商导出的完整固定会话代理。');
  } else {
    result.sessionHint = `${session.slice(0, 2)}…${session.slice(-2)}`;
    result.sessionFingerprint = fingerprint(country?.toUpperCase(), session);
  }
  const lifetime = options.get('lifetime');
  if (lifetime === undefined) {
    issue(result.issues, 'missing_lifetime', '缺少 IPRoyal 的 lifetime 参数。请指定固定会话期限后重新导出代理。');
  } else {
    const duration = /^(\d+)([smhd])$/.exec(lifetime);
    const seconds = duration ? Number(duration[1]) * unitSeconds[duration[2]] : NaN;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800) {
      issue(result.issues, 'invalid_lifetime', 'IPRoyal 的 lifetime 必须是 1 秒至 7 天的整数时长，只使用一种单位 s、m、h 或 d（例如 168h）。');
    } else {
      result.lifetime = lifetime;
      result.hours = seconds / 3600;
    }
  }
  for (const key of ['streaming', 'killswitch', 'forcerandom', 'skipispstatic']) {
    const value = options.get(key);
    if (value !== undefined && !/^[01]$/.test(value)) issue(result.issues, `invalid_${key}`, `IPRoyal 的 ${key} 参数必须是 0 或 1。请核对完整代理。`);
  }
  result.killswitch = options.get('killswitch') === '1';
  result.streaming = options.get('streaming') === '1';
  result.rotating = !result.sessionFingerprint || options.get('forcerandom') === '1';
  return result;
}

export function prepareProxySession(proxy, auth = {}, { strictIp = false, country } = {}) {
  let session = inspectProxySession(proxy, auth);
  if (!strictIp || session.provider !== 'iproyal') return { proxy, auth, session, changed: false };
  const issues = [...session.issues];
  if (session.countries.length > 1) issue(issues, 'multiple_countries', '固定出口模式不能使用多个国家的随机选择。请重新导出单个国家的代理。');
  const expectedCountry = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(expectedCountry)) {
    issue(issues, 'missing_target_country', '固定出口模式需要先选择环境的目标国家。');
  } else if (session.country && session.country !== expectedCountry) {
    issue(issues, 'country_mismatch', `代理参数指定 ${session.country}，与环境国家 ${expectedCountry} 不符。请核对国家或重新导出代理。`);
  }
  if (session.rotating && session.sessionFingerprint) issue(issues, 'forced_rotation', 'IPRoyal 的 forcerandom-1 会强制随机出口，与固定出口模式冲突。请关闭该参数后重新粘贴。');
  if (issues.length) {
    const error = new Error(issues.map(item => item.message).join(' '));
    error.name = 'ProxySessionError';
    error.sessionIssues = issues;
    throw error;
  }
  const password = /_killswitch-[^_]*/i.test(auth.password)
    ? auth.password.replace(/_killswitch-[^_]*/i, '_killswitch-1')
    : `${auth.password}_killswitch-1`;
  if (new TextEncoder().encode(password).length > 255) {
    const error = new Error('补充固定出口参数后认证密码超过 SOCKS5 的 255 字节限制。请从供应商重新导出更短的完整代理。');
    error.name = 'ProxySessionError';
    error.sessionIssues = [{ code: 'password_too_long', message: error.message }];
    throw error;
  }
  const changed = password !== auth.password;
  const preparedAuth = changed ? { ...auth, password } : auth;
  session = inspectProxySession(proxy, preparedAuth);
  return { proxy, auth: preparedAuth, session, changed };
}
