import { randomUUID } from 'node:crypto';
import { normalizeEnvironment } from './environment.js';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const LINKS = Object.freeze({
  signin: 'https://accounts.google.com/',
  gmail: 'https://mail.google.com/',
  youtube: 'https://www.youtube.com/',
  terms: 'https://policies.google.com/terms',
  appeal: 'https://policies.google.com/country-association-form',
  faq: 'https://policies.google.com/faq?hl=zh-CN',
  devices: 'https://myaccount.google.com/device-activity',
});
export const DIAGNOSTICS_PATH = fileURLToPath(new URL('../public/diagnostics.html', import.meta.url));

export function targetUrl(profile, target) {
  if (target === 'diagnostics') return pathToFileURL(DIAGNOSTICS_PATH).href + '#' + encodeURIComponent(JSON.stringify(normalizeEnvironment(profile.environment, profile.country)));
  if (!Object.hasOwn(LINKS, target) || target === 'faq') throw new Error('不支持的打开目标。');
  return LINKS[target];
}
const COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));

export function countryCode(value) {
  if (typeof value !== 'string' || !COUNTRIES.has(value.toUpperCase())) throw new Error('请选择有效的 ISO 两位国家代码。');
  return value.toUpperCase();
}

export function validateProxy(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 260 || /[\s;\\]/.test(value)) throw new Error('代理格式应为 http://主机:端口 或 socks5://主机:端口。');
  let url;
  try { url = new URL(value); } catch { throw new Error('代理地址格式无效。'); }
  const explicitPort = /:(\d+)\/?$/.exec(value)?.[1];
  const port = url.port || (url.protocol === 'http:' && explicitPort && Number(explicitPort) === 80 ? '80' : '');
  if (!['http:', 'socks5:'].includes(url.protocol) || !url.hostname || !port || Number(port) < 1 || Number(port) > 65535 || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('仅支持明确端口的 HTTP / SOCKS5 代理，不支持带账号密码的 URL。请在本地转发器中设置认证。');
  }
  // URL normalization must never introduce a direct fallback or extra Chromium arguments.
  return `${url.protocol}//${url.hostname}:${port}`;
}

export function profileInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置无效。');
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 80 || /[\x00-\x1f]/.test(label)) throw new Error('环境名称应为 1–80 个字符。');
  const country = countryCode(input.country);
  const accountLabel = input.accountLabel ?? '';
  if (typeof accountLabel !== 'string' || accountLabel.length > 80 || /[\x00-\x1f]/.test(accountLabel)) throw new Error('本地账号代号最多 80 个字符。');
  if (input.strictIp !== undefined && typeof input.strictIp !== 'boolean') throw new Error('固定出口选项必须是布尔值。');
  return { label, country, proxy: validateProxy(input.proxy ?? ''), accountLabel: accountLabel.trim(), strictIp: input.strictIp ?? true, environment: normalizeEnvironment(input.environment, country) };
}

export function makeProfile(input) {
  return { id: randomUUID(), ...profileInput(input), createdAt: new Date().toISOString(), cycleStartedAt: null, checks: [], observations: [], launches: [], cycleHistory: [], expectedIp: null, deviceReviews: [] };
}

export function withStats(profile, now = Date.now()) {
  const started = profile.cycleStartedAt ? Date.parse(profile.cycleStartedAt) : null;
  return { ...profile, stats: {
    elapsedDays: started === null ? 0 : Math.max(0, Math.floor((now - started) / 86400000)),
    nextReviewAt: started === null ? null : new Date(started + 7 * 86400000).toISOString(),
    observationCount: profile.observations.filter(o => started === null || Date.parse(o.at) >= started).length,
  } };
}

export function buildBrowserArgs(profile, profileDir, target) {
  const proxy = validateProxy(profile.proxy);
  if (!proxy) throw new Error('请先配置该环境的固定代理。');
  const url = targetUrl(profile, target);
  const environment = normalizeEnvironment(profile.environment, profile.country);
  return [
    `--user-data-dir=${profileDir}`, `--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', `--lang=${environment.locale}`,
    `--window-size=${environment.viewport.width},${environment.viewport.height}`, '--new-window', url,
  ];
}
