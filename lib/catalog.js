import { isIP } from 'node:net';
import { countryCode } from './model.js';

const SOURCE_URL = 'https://www.vpngate.net/api/iphone/';
const SOURCE_PAGE = 'https://www.vpngate.net/en/';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 120_000;
const TIMEOUT_MS = 15_000;

// Parse CSV records without evaluating, downloading, or returning VPN configuration.
function csvRecords(text) {
  const rows = [];
  let row = [], field = '', quoted = false, closedQuote = false;
  const pushField = () => {
    row.push(field);
    if (row.length > 64) throw new Error('公共节点目录的列数过多。');
    field = ''; closedQuote = false;
  };
  const pushRow = () => { pushField(); if (row.some(Boolean)) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quoted && !closedQuote && !row.length && !field && (c === '*' || (c === '#' && !text.startsWith('#HostName,', i)))) {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else field += c;
    } else if (c === ',') pushField();
    else if (c === '\n' || c === '\r') {
      pushRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (closedQuote) throw new Error('公共节点目录包含无效 CSV 引号。');
    else if (c === '"') {
      if (field) throw new Error('公共节点目录包含无效 CSV 引号。');
      quoted = true;
    } else field += c;
    if (field.length > 262_144) throw new Error('公共节点目录的字段过长。');
  }
  if (quoted) throw new Error('公共节点目录的 CSV 引号未闭合。');
  if (field || row.length || closedQuote) pushRow();
  return rows;
}

function publicIpv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function numeric(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+(?:\.\d+)?$/.test(value) || value.length > 20) return null;
  const number = Number(value);
  return Number.isFinite(number) && number <= maximum ? number : null;
}

export function parseVpnGateCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('公共节点目录超过 2 MiB 或格式无效。');
  const records = csvRecords(text.replace(/^\uFEFF/, ''));
  const headerIndex = records.findIndex(row => row[0] === '#HostName');
  if (headerIndex < 0) throw new Error('公共节点目录缺少 CSV 表头。');
  const headers = records[headerIndex].map((s, i) => i === 0 ? s.slice(1) : s);
  const required = ['HostName', 'IP', 'CountryLong', 'CountryShort', 'Ping', 'Speed', 'Uptime', 'NumVpnSessions'];
  if (new Set(headers).size !== headers.length || required.some(key => !headers.includes(key))) throw new Error('公共节点目录的 CSV 表头不完整。');
  const columns = Object.fromEntries(required.map(key => [key, headers.indexOf(key)]));
  const nodes = [], seen = new Set();
  for (const row of records.slice(headerIndex + 1)) {
    if (row.length !== headers.length) continue;
    const value = key => row[columns[key]];
    const hostname = value('HostName'), ip = value('IP');
    if (hostname.length > 253 || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(hostname) ||
        hostname.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) || !publicIpv4(ip)) continue;
    let country;
    try { country = countryCode(value('CountryShort')); } catch { continue; }
    const countryName = value('CountryLong').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) || country;
    const id = `${country}:${hostname}:${ip}`;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id, hostname, ip, country, countryName,
      latencyMs: numeric(value('Ping'), 86_400_000),
      speedMbps: Math.round((numeric(value('Speed'), 1e15) ?? 0) / 1000) / 1000,
      uptimeHours: Math.round((numeric(value('Uptime')) ?? 0) / 36_000) / 100,
      sessions: Math.floor(numeric(value('NumVpnSessions'), 1e9) ?? 0),
      transport: 'VPN / OpenVPN（需要客户端转换）',
      residentialStatus: '未验证',
      sourceUrl: SOURCE_PAGE,
    });
  }
  return nodes;
}

async function readLimited(response, signal) {
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
    response.body?.cancel().catch(() => {});
    throw new Error('公共节点目录超过 2 MiB。');
  }
  if (!response.body?.getReader) throw new Error('公共节点目录没有可读取的响应流。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0, completed = false;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) { completed = true; break; }
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('公共节点目录超过 2 MiB。');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!completed) cancel();
    reader.releaseLock();
  }
}

export function createCatalog({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let snapshot = null, pending = null;
  async function refresh() {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('公共节点目录请求超时（15 秒）。');
        controller.abort(error); reject(error);
      }, TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(SOURCE_URL, { redirect: 'error', signal: controller.signal, headers: { Accept: 'text/csv, text/plain' } });
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          throw new Error(`公共节点目录请求失败（HTTP ${response.status}）。`);
        }
        const nodes = parseVpnGateCsv(await readLimited(response, controller.signal));
        controller.signal.throwIfAborted();
        const fetchedAtMs = now();
        return { nodes, fetchedAtMs, fetchedAt: new Date(fetchedAtMs).toISOString() };
      })()]);
    } finally { clearTimeout(timer); }
  }
  return {
    async list(country = 'IN') {
      country = countryCode(country);
      const age = snapshot ? now() - snapshot.fetchedAtMs : Infinity;
      let cached = age >= 0 && age < CACHE_MS;
      if (!cached) {
        if (!pending) pending = refresh().then(result => { snapshot = result; return result; }).finally(() => { pending = null; });
        try { await pending; }
        catch (cause) {
          const error = new Error(`无法更新公共节点目录：${cause.message}`, { cause });
          if (snapshot) error.lastFetchedAt = snapshot.fetchedAt;
          throw error;
        }
      }
      return {
        source: 'VPN Gate', sourceUrl: SOURCE_URL, fetchedAt: snapshot.fetchedAt,
        cached, total: snapshot.nodes.length, country,
        nodes: snapshot.nodes.filter(node => node.country === country).map(node => ({ ...node })),
      };
    },
  };
}
