import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, parseVpnGateCsv } from '../lib/catalog.js';

const header = '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64';
function row(overrides = {}) {
  const values = { HostName: 'vpn-example', IP: '8.8.8.8', Score: '123', Ping: '42', Speed: '12000000', CountryLong: 'India', CountryShort: 'IN', NumVpnSessions: '3', Uptime: '7200000', TotalUsers: '5', TotalTraffic: '500', LogType: '2weeks', Operator: 'volunteer', Message: 'Untrusted message', OpenVPN_ConfigData_Base64: 'SECRET_CONFIG', ...overrides };
  return header.slice(1).split(',').map(key => '"' + values[key].replace(/"/g, '""') + '"').join(',');
}
const csv = (...rows) => '\uFEFF*vpn_servers\r\n# ignored comment with "unbalanced quotation\r\n' + header + '\r\n' + rows.join('\r\n') + '\r\n*\r\n';
const good = () => csv(row(), row({ HostName: 'vpn-ng', IP: '1.1.1.1', CountryLong: 'Nigeria', CountryShort: 'NG', Ping: '-' }));

test('CSV accepts BOM, comments, escaped quotes, embedded newlines and CRLF; emits only permitted metadata', () => {
  const nodes = parseVpnGateCsv(csv(row({ CountryLong: 'India, "Test"\r\narea', Message: 'ignore\r\nthis, "message"' })));
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], {
    id: 'IN:vpn-example:8.8.8.8', hostname: 'vpn-example', ip: '8.8.8.8', country: 'IN', countryName: 'India, "Test"  area',
    latencyMs: 42, speedMbps: 12, uptimeHours: 2, sessions: 3,
    transport: 'VPN / OpenVPN（需要客户端转换）', residentialStatus: '未验证', sourceUrl: 'https://www.vpngate.net/en/',
  });
  assert.ok(!JSON.stringify(nodes).includes('SECRET_CONFIG'));
  assert.ok(!JSON.stringify(nodes).includes('message'));
});

test('CSV rejects nonpublic/malformed IPs, invalid countries and hostnames, and deduplicates records', () => {
  const badIps = ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.10.1', '172.31.1.1', '192.168.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.2', '198.18.0.1', '224.0.0.1', '255.255.255.255', '0.1.2.3', '::1', '8.8.8.8:80', '008.8.8.8', '999.1.1.1'];
  const invalid = [...badIps.map(IP => row({ IP })), row({ CountryShort: 'XX' }), row({ CountryShort: 'http://localhost' }), row({ HostName: 'x'.repeat(254) }), row({ HostName: 'a..b' }), row({ HostName: '<script>' })];
  assert.equal(parseVpnGateCsv(csv(...invalid, row(), row())).length, 1);
});

test('CSV bounds and normalizes untrusted metadata while tolerating missing numeric data', () => {
  const [node] = parseVpnGateCsv(csv(row({ CountryLong: 'A'.repeat(200), Ping: '-', Speed: 'Infinity', Uptime: '-9', NumVpnSessions: '=1+2' })));
  assert.equal(node.countryName.length, 80);
  assert.equal(node.latencyMs, null);
  assert.equal(node.speedMbps, 0);
  assert.equal(node.uptimeHours, 0);
  assert.equal(node.sessions, 0);
  assert.throws(() => parseVpnGateCsv('x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
  assert.throws(() => parseVpnGateCsv(csv(row({ Message: 'x'.repeat(262_145) }))), /字段过长/);
  assert.throws(() => parseVpnGateCsv('not a directory'), /表头/);
  assert.throws(() => parseVpnGateCsv(header + '\n"unterminated'), /未闭合/);
  assert.throws(() => parseVpnGateCsv(header + '\n"field"garbage'), /引号/);
  assert.deepEqual(parseVpnGateCsv(header + '\none,two'), []);
});

test('catalog only fetches fixed HTTPS URL with no redirects and filters countries locally', async () => {
  let calls = 0;
  const catalog = createCatalog({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://www.vpngate.net/api/iphone/');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(good());
  }, now: () => 1_000_000 });
  await assert.rejects(catalog.list('http://127.0.0.1'), /ISO/);
  assert.equal(calls, 0);
  const first = await catalog.list();
  assert.equal(first.country, 'IN');
  assert.equal(first.cached, false);
  assert.equal(first.total, 2);
  assert.equal(first.nodes.length, 1);
  first.nodes[0].ip = 'tampered';
  const second = await catalog.list('ng');
  assert.equal(second.cached, true);
  assert.equal(second.nodes[0].country, 'NG');
  assert.equal((await catalog.list('IN')).nodes[0].ip, '8.8.8.8');
  assert.equal((await catalog.list('JP')).nodes.length, 0);
  assert.equal(calls, 1);
});

test('catalog coalesces concurrent refreshes and expires cache at 120 seconds', async () => {
  let current = 100_000, calls = 0, resolve;
  const gate = new Promise(r => { resolve = r; });
  const catalog = createCatalog({ now: () => current, fetchImpl: async () => { calls++; await gate; return new Response(good()); } });
  const first = catalog.list('IN'), second = catalog.list('NG');
  assert.equal(calls, 1);
  resolve();
  assert.deepEqual((await Promise.all([first, second])).map(x => x.cached), [false, false]);
  current += 119_999;
  assert.equal((await catalog.list()).cached, true);
  current++;
  assert.equal((await catalog.list()).cached, false);
  assert.equal(calls, 2);
});

test('refresh failures are surfaced without destroying or silently serving the previous good snapshot', async () => {
  let current = 100_000, calls = 0;
  const catalog = createCatalog({ now: () => current, fetchImpl: async () => {
    calls++;
    if (calls === 2) throw new Error('network unavailable');
    if (calls === 3) return new Response('bad CSV');
    return new Response(good());
  } });
  const original = await catalog.list();
  current += 120_000;
  for (let i = 0; i < 2; i++) await assert.rejects(catalog.list(), error => {
    assert.equal(error.lastFetchedAt, original.fetchedAt);
    assert.match(error.message, /无法更新/);
    return true;
  });
  const recovered = await catalog.list();
  assert.equal(recovered.cached, false);
  assert.notEqual(recovered.fetchedAt, original.fetchedAt);
  assert.equal(calls, 4);
});

test('catalog limits both declared and streamed bytes and rejects HTTP failures', async () => {
  const oversized = 2 * 1024 * 1024 + 1;
  const cases = [
    new Response('', { headers: { 'Content-Length': String(oversized) } }),
    new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } })),
    new Response('', { status: 503 }),
    new Response(new Uint8Array([0xff, 0xfe])),
  ];
  for (const response of cases) {
    const catalog = createCatalog({ fetchImpl: async () => response });
    await assert.rejects(catalog.list(), /无法更新/);
  }
});

test('catalog aborts its fixed-source request after 15 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const catalog = createCatalog({ fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const failure = assert.rejects(catalog.list(), /15 秒/);
  t.mock.timers.tick(15_000);
  await failure;
  assert.equal(signal.aborted, true);
});
