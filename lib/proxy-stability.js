import { isIP } from 'node:net';
import { countryCode } from './model.js';

const FAILED_SAMPLE = '代理出口采样失败，请检查线路后重试。';
const INVALID_SAMPLE = '出口检测服务未返回有效的 IP 和国家数据。';

function normalizedIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  // Compare IPv6 addresses by value rather than their compressed spelling.
  try { return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value; }
  catch { return null; }
}

function safeDiagnostic(error, proxy) {
  let message = error?.diagnostic?.message;
  if (typeof message !== 'string' || !message.trim()) return FAILED_SAMPLE;
  // Raw Error.message/stderr can contain curl arguments, URLs and passwords.
  // Only accept the structured diagnostic, and redact any accidentally included
  // connection address or credentials before it can reach logs or the UI.
  const secrets = [typeof proxy === 'string' ? proxy : ''];
  try {
    const url = new URL(proxy);
    for (const value of [url.username, url.password]) {
      if (value) secrets.push(value);
      try { if (value) secrets.push(decodeURIComponent(value)); } catch {}
    }
  } catch {}
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[已隐藏]');
  }
  message = message
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'，。；]+/gi, '[已隐藏连接地址]')
    .replace(/\b[^\s:]+:\d{1,5}:[^\s:]+:[^\s，。；]+/g, '[已隐藏代理配置]')
    .replace(/\b(?:password|passwd|pwd|username|user|token|secret)\s*[:=]\s*[^\s，。；]+/gi, '[已隐藏认证信息]')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  return message.trim().slice(0, 400) || FAILED_SAMPLE;
}

function safeSource(value) {
  if (typeof value !== 'string') return undefined;
  if (/^[a-z\d._-]{1,100}$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch {}
  return undefined;
}

function sampleResult(value, proxy) {
  const failed = error => ({ ok: false, ip: null, country: null, error });
  if (value instanceof Error || value?.ok === false) {
    return failed(safeDiagnostic(value?.error ?? value, proxy));
  }
  const ip = normalizedIp(value?.ip);
  let country;
  try { country = countryCode(value?.country); } catch { return failed(INVALID_SAMPLE); }
  if (!ip) return failed(INVALID_SAMPLE);
  const source = safeSource(value?.source);
  return { ok: true, ip, country, ...(source ? { source } : {}) };
}

// The caller supplies a probe that opens a fresh connection on every call. The
// first result belongs to the same diagnostic run; no previous IP is reused as
// an observation. Three successful samples only establish short-term stability.
export async function sampleProxyStability(proxy, { first, probe, sampleCount = 3 } = {}) {
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 3) {
    throw new RangeError('出口采样次数必须为 1–3。');
  }
  if (sampleCount > 1 && typeof probe !== 'function') throw new TypeError('需要提供出口采样方法。');
  const samples = [sampleResult(first, proxy)];
  for (let index = 1; index < sampleCount; index += 1) {
    try {
      samples.push(sampleResult(await probe(proxy), proxy));
    } catch (error) {
      samples.push({ ok: false, ip: null, country: null, error: safeDiagnostic(error, proxy) });
    }
  }
  const successful = samples.filter(sample => sample.ok);
  const uniqueIps = [...new Set(successful.map(sample => sample.ip))];
  const countries = [...new Set(successful.map(sample => sample.country))];
  const complete = samples.length === sampleCount && successful.length === sampleCount;
  return {
    samples, uniqueIps, complete,
    stable: complete && uniqueIps.length === 1 && countries.length === 1,
    observedCountry: countries.length === 1 ? countries[0] : null,
  };
}

export function createStabilityHistory({ now = () => Date.now(), ttlMs = 10 * 60 * 1000, maxEntries = 100 } = {}) {
  if (typeof now !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0
      || !Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('出口历史配置无效。');
  const entries = new Map();
  return {
    compare(key, stability) {
      if (typeof key !== 'string' || !key || key.length > 256) throw new TypeError('出口历史标识无效。');
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new TypeError('出口历史时间无效。');
      for (const [storedKey, entry] of entries) {
        if (timestamp - entry.createdAt >= ttlMs || timestamp < entry.createdAt) entries.delete(storedKey);
      }
      const ips = [...new Set((Array.isArray(stability?.uniqueIps) ? stability.uniqueIps : []).map(normalizedIp).filter(Boolean))];
      const previous = entries.get(key);
      if (previous) {
        return {
          comparedWithPrevious: true,
          changedSincePrevious: ips.some(ip => ip !== previous.ip),
          previousIp: previous.ip,
        };
      }
      // Failed/rotating samples cannot establish or replace a fixed-IP baseline.
      if (stability?.complete === true && stability?.stable === true && ips.length === 1) {
        while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        entries.set(key, { ip: ips[0], createdAt: timestamp });
      }
      return { comparedWithPrevious: false, changedSincePrevious: false };
    },
  };
}
