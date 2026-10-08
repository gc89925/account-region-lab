// Shared browser/server inspection. Public metadata excludes credentials and
// the complete session; getProxySessionOptions is only for local form editing.
// https://docs.iproyal.com/proxies/residential/proxy/{location,rotation}
const providerHost = 'geo.iproyal.com';
const knownKeys = new Set(['country', 'session', 'lifetime', 'streaming', 'killswitch', 'forcerandom', 'region', 'city', 'state', 'isp', 'geolocation', 'skipipslist', 'skipispstatic', 'set']);
const booleanKeys = new Set(['streaming', 'killswitch', 'forcerandom', 'skipispstatic']);
const regions = new Set(['africa', 'arabstates', 'asiapacific', 'europe', 'middleeast', 'northamerica', 'southlatinamerica']);
const suffixStart = /_(?:country|session|lifetime|streaming|killswitch|forcerandom|region|city|state|isp|geolocation|skipipslist|skipispstatic|set)-/i;
const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 };

function isProvider(proxy) {
  try { return new URL(proxy).hostname.toLowerCase() === providerHost; } catch { return false; }
}

function issue(issues, code, message) {
  if (!issues.some(item => item.code === code && item.message === message)) issues.push({ code, message });
}

function fail(issues) {
  const error = new Error(issues.map(item => item.message).join(' '));
  error.name = 'ProxySessionError';
  error.sessionIssues = issues;
  throw error;
}

function parseOptions(password, issues) {
  const match = suffixStart.exec(password);
  const options = new Map();
  const tokens = [];
  if (!match) return { base: password, options, tokens };
  if (match.index === 0) issue(issues, 'missing_password', 'IPRoyal 认证缺少基础密码。请重新粘贴供应商导出的完整代理。');
  for (const token of password.slice(match.index + 1).split('_')) {
    const pair = /^([a-z][a-z0-9]*)-(.*)$/i.exec(token);
    if (!pair) {
      issue(issues, 'malformed_parameter', 'IPRoyal 参数格式不完整。请重新粘贴供应商导出的完整代理。');
      continue;
    }
    const key = pair[1].toLowerCase();
    if (!knownKeys.has(key)) {
      issue(issues, 'unknown_parameter', 'IPRoyal 代理包含未识别的参数，无法安全编辑。请核对供应商导出的完整代理。');
      continue;
    }
    if (key !== pair[1]) issue(issues, 'invalid_parameter_name', 'IPRoyal 参数名称需要使用供应商导出的原始小写格式。请重新粘贴完整代理。');
    if (options.has(key)) {
      issue(issues, 'duplicate_parameter', `IPRoyal 的 ${key} 参数重复。请只保留一条完整代理后重新粘贴。`);
      continue;
    }
    options.set(key, pair[2]);
    tokens.push({ key, raw: token });
    if (!pair[2]) issue(issues, 'empty_parameter', `IPRoyal 的 ${key} 参数缺少值。请重新粘贴完整代理。`);
  }
  return { base: password.slice(0, match.index), options, tokens };
}

function validateAuth(auth, issues) {
  const password = typeof auth?.password === 'string' ? auth.password : '';
  const username = typeof auth?.username === 'string' ? auth.username : '';
  if (!password || !username) issue(issues, 'missing_auth', 'IPRoyal 固定出口需要完整用户名和密码参数。请重新粘贴供应商导出的完整代理。');
  const encoder = new TextEncoder();
  if (/[\x00-\x1f\x7f]/.test(username + password) || encoder.encode(username).length > 255 || encoder.encode(password).length > 255) {
    issue(issues, 'invalid_auth', 'IPRoyal 认证字段不能包含控制字符，且用户名和密码各不能超过 255 个 UTF-8 字节。请重新粘贴完整代理。');
  }
  return password;
}

function validGeolocation(value) {
  const parts = value.split(',');
  if (parts.length !== 3 && !(parts.length === 4 && parts[3] === 'strict')) return false;
  if (!parts.slice(0, 3).every(part => /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(part))) return false;
  const [latitude, longitude, radius] = parts.map(Number);
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180 && Number.isFinite(radius) && radius >= 10;
}

function validateOptions(options, issues, { requireSticky = false } = {}) {
  const valid = new Map();
  const country = options.get('country');
  if (requireSticky) {
    if (country === undefined) issue(issues, 'missing_country', '缺少 IPRoyal 的 country 国家参数。请重新导出指定单个国家的代理。');
    if (!options.has('session')) issue(issues, 'missing_session', '缺少 IPRoyal 的 session 参数；未配置固定会话时出口可能逐次变化。请粘贴含固定会话的完整代理。');
    if (!options.has('lifetime')) issue(issues, 'missing_lifetime', '缺少 IPRoyal 的 lifetime 参数。请指定固定会话期限后重新导出代理。');
  }
  for (const [key, value] of options) {
    let message = null;
    if (key === 'country' && !/^[a-z]{2}(?:,[a-z]{2})*$/i.test(value)) message = 'IPRoyal 的 country 参数必须是两个字母的国家代码，多国之间使用逗号。';
    if (key === 'session' && !/^[a-z0-9]{8}$/i.test(value)) message = 'IPRoyal 的 session 必须是 8 位字母或数字。请重新粘贴供应商导出的完整固定会话代理。';
    if (key === 'lifetime') {
      const duration = /^(\d+)([smhd])$/.exec(value);
      const seconds = duration ? Number(duration[1]) * unitSeconds[duration[2]] : NaN;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800) message = 'IPRoyal 的 lifetime 必须是 1 秒至 7 天的整数时长，只使用一种单位 s、m、h 或 d（例如 168h）。';
    }
    // Official examples enable flags with 1. Existing 0 values stay intact;
    // new boolean false edits remove the option to restore the provider default.
    if (booleanKeys.has(key) && !/^[01]$/.test(value)) message = `IPRoyal 的 ${key} 参数必须是 0 或 1。请核对完整代理。`;
    if (key === 'region' && !regions.has(value)) message = 'IPRoyal 的 region 必须是供应商支持的大区代码；州名请填写 state。';
    if (['city', 'state', 'isp', 'set'].includes(key) && !/^[\p{L}\p{N}][\p{L}\p{N}.'-]*$/u.test(value)) message = `IPRoyal 的 ${key} 需要供应商提供的代码，不能包含空白、逗号或参数分隔符。`;
    if (key === 'geolocation' && !validGeolocation(value)) message = 'IPRoyal 的 geolocation 格式为 纬度,经度,半径[,strict]；纬度 -90 至 90，经度 -180 至 180，半径至少 10 英里。';
    if (key === 'skipipslist' && !/^[0-7][0-9a-hjkmnp-tv-z]{25}$/i.test(value)) message = 'IPRoyal 的 skipipslist 必须是供应商创建的 26 位 ULID 列表编号。';
    if (message) issue(issues, `invalid_${key}`, message);
    else valid.set(key, value);
  }
  if ((options.has('city') || options.has('state')) && !country) issue(issues, 'location_requires_country', 'IPRoyal 的 city / state 参数需要同时指定 country。');
  // The guide calls state US-only, but the official API lists non-US states.
  // Preserve imported provider codes instead of imposing that disputed limit.
  if (options.has('isp') && (!country || !options.get('city'))) issue(issues, 'isp_requires_location', 'IPRoyal 的 isp 参数需要同时指定 country 和 city，且须由供应商开通权限。');
  return valid;
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
    killswitch: false, streaming: false, rotating: false, options: {}, issues: []
  };
  if (!isProvider(proxy)) return result;
  result.provider = 'iproyal';
  const password = validateAuth(auth, result.issues);
  const { options } = parseOptions(password, result.issues);
  const valid = validateOptions(options, result.issues, { requireSticky: true });
  const country = valid.get('country');
  if (country) {
    result.countries = country.toUpperCase().split(',');
    if (result.countries.length === 1) result.country = result.countries[0];
  }
  const session = valid.get('session');
  if (session) {
    result.sessionHint = `${session.slice(0, 2)}…${session.slice(-2)}`;
    result.sessionFingerprint = fingerprint(country?.toUpperCase(), session);
  }
  const lifetime = valid.get('lifetime');
  if (lifetime) {
    result.lifetime = lifetime;
    result.hours = Number(lifetime.slice(0, -1)) * unitSeconds[lifetime.at(-1)] / 3600;
  }
  result.options = Object.fromEntries([...valid].filter(([key]) => key !== 'session'));
  result.killswitch = valid.get('killswitch') === '1';
  result.streaming = valid.get('streaming') === '1';
  result.rotating = !result.sessionFingerprint || valid.get('forcerandom') === '1';
  return result;
}

// Contains the full routing session, but never the base password or username.
// Use for newly pasted credentials in the local editor, not API responses.
export function getProxySessionOptions(proxy, auth = {}) {
  if (!isProvider(proxy)) return {};
  const issues = [];
  const password = validateAuth(auth, issues);
  const { options } = parseOptions(password, issues);
  validateOptions(options, issues);
  if (issues.length) fail(issues);
  return Object.fromEntries(options);
}

// undefined preserves; null/empty text removes; booleans enable/remove flags.
// No session is invented. Untouched tokens and base credentials retain bytes.
export function applyProxySessionOptions(proxy, auth = {}, updates = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) || ![Object.prototype, null].includes(Object.getPrototypeOf(updates))) {
    fail([{ code: 'invalid_options', message: 'IPRoyal 参数更新必须是参数对象。' }]);
  }
  const entries = Object.entries(updates);
  if (!entries.length) return auth;
  if (!isProvider(proxy)) fail([{ code: 'unsupported_provider', message: '这些供应商参数仅适用于 geo.iproyal.com。' }]);
  const issues = [];
  const password = validateAuth(auth, issues);
  const parsed = parseOptions(password, issues);
  // Refuse ambiguous source strings instead of silently losing unknown tokens.
  if (issues.length) fail(issues);
  const changes = new Map();
  for (const [key, value] of entries) {
    if (!knownKeys.has(key)) {
      issue(issues, 'unknown_update', 'IPRoyal 参数更新包含不支持的名称。');
      continue;
    }
    if (value === undefined) continue;
    if (value === null || value === '') { changes.set(key, null); continue; }
    if (typeof value === 'boolean' && booleanKeys.has(key)) { changes.set(key, value ? '1' : null); continue; }
    if (typeof value !== 'string') {
      issue(issues, 'invalid_update_value', `IPRoyal 的 ${key} 更新需要文本值。`);
      continue;
    }
    changes.set(key, key === 'country' ? value.toLowerCase() : value);
  }
  if (issues.length) fail(issues);
  const options = new Map(parsed.options);
  for (const [key, value] of changes) {
    if (value === null) options.delete(key);
    else options.set(key, value);
  }
  validateOptions(options, issues);
  if (issues.length) fail(issues);
  const tokens = parsed.tokens.flatMap(({ key, raw }) => {
    if (!changes.has(key)) return [raw];
    const value = changes.get(key);
    return value === null ? [] : [`${key}-${value}`];
  });
  for (const [key, value] of changes) if (!parsed.options.has(key) && value !== null) tokens.push(`${key}-${value}`);
  const nextPassword = parsed.base + (tokens.length ? `_${tokens.join('_')}` : '');
  const next = nextPassword === password ? auth : { ...auth, password: nextPassword };
  validateAuth(next, issues);
  if (issues.length) fail(issues);
  return next;
}

export function prepareProxySession(proxy, auth = {}, { strictIp = false, country } = {}) {
  let session = inspectProxySession(proxy, auth);
  if (!strictIp || session.provider !== 'iproyal') return { proxy, auth, session, changed: false };
  const issues = [...session.issues];
  if (session.countries.length > 1) issue(issues, 'multiple_countries', '固定出口模式不能使用多个国家的随机选择。请重新导出单个国家的代理。');
  if (session.options.set) issue(issues, 'country_set', '固定出口模式不能使用 set 国家集合，请移除集合并指定单个国家。');
  const expectedCountry = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(expectedCountry)) {
    issue(issues, 'missing_target_country', '固定出口模式需要先选择环境的目标国家。');
  } else if (session.country && session.country !== expectedCountry) {
    issue(issues, 'country_mismatch', `代理参数指定 ${session.country}，与环境国家 ${expectedCountry} 不符。请核对国家或重新导出代理。`);
  }
  if (session.rotating && session.sessionFingerprint) issue(issues, 'forced_rotation', 'IPRoyal 的 forcerandom-1 会强制随机出口，与固定出口模式冲突。请关闭该参数后重新粘贴。');
  if (issues.length) fail(issues);
  const password = /_killswitch-[^_]*/i.test(auth.password)
    ? auth.password.replace(/_killswitch-[^_]*/i, '_killswitch-1')
    : `${auth.password}_killswitch-1`;
  if (new TextEncoder().encode(password).length > 255) {
    fail([{ code: 'password_too_long', message: '补充固定出口参数后认证密码超过 SOCKS5 的 255 字节限制。请从供应商重新导出更短的完整代理。' }]);
  }
  const changed = password !== auth.password;
  const preparedAuth = changed ? { ...auth, password } : auth;
  session = inspectProxySession(proxy, preparedAuth);
  return { proxy, auth: preparedAuth, session, changed };
}
