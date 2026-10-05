import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog as createCatalogImpl, parseVpnGateCsv, parseOpenVpnTcpEndpoint, parseVpnGateConnectionLinks } from '../lib/catalog.js';

const createCatalog = options => createCatalogImpl({ connectionFetchImpl: async () => new Response('<html></html>'), ...options });
const encoded = text => Buffer.from(text).toString('base64');
const officialLink = "https://www.vpngate.net/en/do_openvpn.aspx?fqdn=vpn-example.opengw.net&ip=8.8.8.8&tcp=443&udp=0&sid=1791169474611&hid=27127336";

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
    transport: 'VPN / OpenVPN（需要客户端转换）', residentialStatus: '住宅未验证', sourceUrl: 'https://www.vpngate.net/en/',
    candidateType: 'volunteer_candidate', candidateReason: '未命中公共运营节点规则；仅作为志愿者候选，未验证住宅归属',
    tcpEndpoint: null, connectionGuideUrl: 'https://www.vpngate.net/en/howto_openvpn.aspx',
    officialConfigPageUrl: null, connectionUrl: null, configUrl: null,
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
  assert.equal(first.country, 'ALL');
  assert.equal(first.cached, false);
  assert.equal(first.total, 2);
  assert.equal(first.nodes.length, 2);
  assert.equal(first.matched, 2);
  assert.equal(first.emptyReason, null);
  assert.deepEqual(first.countryCounts, { IN: 1, NG: 1 });
  assert.deepEqual(first.countries, [
    { country: 'IN', countryName: 'India', count: 1 },
    { country: 'NG', countryName: 'Nigeria', count: 1 },
  ]);
  first.nodes[0].ip = 'tampered';
  first.countries[0].count = 999;
  first.countryCounts.IN = 999;
  const second = await catalog.list('ng');
  assert.equal(second.cached, true);
  assert.equal(second.nodes[0].country, 'NG');
  assert.equal((await catalog.list('IN')).nodes[0].ip, '8.8.8.8');
  const absent = await catalog.list('JP');
  assert.equal(absent.nodes.length, 0);
  assert.equal(absent.total, 2);
  assert.equal(absent.matched, 0);
  assert.equal(absent.emptyReason, 'country_unavailable');
  assert.equal(absent.countryCounts.IN, 1);
  assert.equal(absent.countries[0].count, 1);
  assert.equal((await catalog.list('all')).nodes.length, 2);
  assert.equal(calls, 1);
});

test('catalog distinguishes a downloaded empty directory from a country with no listed relays', async () => {
  const catalog = createCatalog({ fetchImpl: async () => new Response(csv()) });
  for (const country of ['ALL', 'IN']) {
    const result = await catalog.list(country);
    assert.equal(result.total, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.emptyReason, 'source_empty');
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.countryCounts, {});
    assert.deepEqual(result.countries, []);
  }
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

test('TCP metadata only accepts a single matching public IPv4 endpoint and TCP protocol', () => {
  assert.deepEqual(parseOpenVpnTcpEndpoint(encoded('client\nproto tcp\nremote 8.8.8.8 443\n<ca>\nremote 127.0.0.1 1\n</ca>\n'), '8.8.8.8'), { ip: '8.8.8.8', port: 443 });
  assert.deepEqual(parseOpenVpnTcpEndpoint(encoded('proto tcp4-client\nremote 8.8.8.8 1194 tcp # comment'), '8.8.8.8'), { ip: '8.8.8.8', port: 1194 });
  for (const config of [
    'proto udp\nremote 8.8.8.8 443', 'proto tcp\nremote localhost 443',
    'proto tcp\nremote 1.1.1.1 443', 'proto tcp\nremote 8.8.8.8 65536',
    'proto tcp\nremote 8.8.8.8 0', 'proto tcp\nremote 8.8.8.8 443\nremote 127.0.0.1 443',
    'proto tcp\nproto udp\nremote 8.8.8.8 443', 'proto tcp\nremote 8.8.8.8 443 udp',
  ]) assert.equal(parseOpenVpnTcpEndpoint(encoded(config), '8.8.8.8'), null, config);
  assert.equal(parseOpenVpnTcpEndpoint(encoded('proto tcp\nremote 127.0.0.1 443'), '127.0.0.1'), null);
  assert.equal(parseOpenVpnTcpEndpoint('not base64', '8.8.8.8'), null);
});

test('catalog labels operator patterns without claiming other nodes are residential', () => {
  const nodes = parseVpnGateCsv(csv(row({ HostName: 'public-vpn-123' }), row({ IP: '219.100.37.50' }), row({ HostName: 'vpn-volunteer', IP: '1.1.1.1', OpenVPN_ConfigData_Base64: encoded('proto tcp\nremote 1.1.1.1 443') })));
  assert.deepEqual(nodes.map(node => node.candidateType), ['operator_server', 'operator_server', 'volunteer_candidate']);
  assert.ok(nodes.every(node => node.residentialStatus === '住宅未验证'));
  assert.deepEqual(nodes[2].tcpEndpoint, { ip: '1.1.1.1', port: 443 });
});

test('connection links only use exact official HTTPS pages with observed required parameters', () => {
  const links = parseVpnGateConnectionLinks(`<a href="${officialLink.replaceAll('&', '&amp;')}">config</a>
    <a href="${officialLink.replace('www.vpngate.net', 'evil.example')}">fake</a>
    <a href="${officialLink.replace('8.8.8.8', '127.0.0.1')}">local</a>
    <a href="${officialLink.replace('&hid=27127336', '')}">incomplete</a>`);
  assert.equal(links.size, 1);
  assert.deepEqual(links.get('vpn-example.opengw.net:8.8.8.8'), { connectionUrl: officialLink, tcpPort: 443 });
});

test('catalog joins official links and candidate counts while keeping snapshots immutable', async () => {
  const catalog = createCatalog({
    fetchImpl: async () => new Response(csv(row({ OpenVPN_ConfigData_Base64: encoded('proto tcp\nremote 8.8.8.8 443') }), row({ HostName: 'public-vpn-5', IP: '1.1.1.1' }))),
    connectionFetchImpl: async (url, options) => { assert.equal(url, 'https://www.vpngate.net/en/'); assert.equal(options.redirect, 'error'); return new Response(`<a href='${officialLink}'>config</a>`); },
  });
  const first = await catalog.list();
  assert.equal(first.linksStatus, 'available');
  assert.equal(first.nodes[0].connectionUrl, officialLink);
  assert.equal(first.nodes[0].officialConfigPageUrl, officialLink);
  assert.equal(first.nodes[0].configUrl, null);
  assert.deepEqual(first.candidateCountryCounts, { IN: 1 });
  assert.equal(first.candidateTotal, 1);
  first.nodes[0].tcpEndpoint.port = 1;
  assert.equal((await catalog.list()).nodes[0].tcpEndpoint.port, 443);
});

test('official page failures or five-second timeout do not hide successfully downloaded nodes', async t => {
  const failing = createCatalog({ fetchImpl: async () => new Response(good()), connectionFetchImpl: async () => { throw new Error('offline'); } });
  const failedLinks = await failing.list();
  assert.equal(failedLinks.total, 2);
  assert.equal(failedLinks.linksStatus, 'unavailable');
  assert.ok(failedLinks.nodes.every(node => node.connectionUrl === null && node.connectionGuideUrl));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const hanging = createCatalog({ fetchImpl: async () => new Response(good()), connectionFetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const result = hanging.list();
  t.mock.timers.tick(5_000);
  const recovered = await result;
  assert.equal(signal.aborted, true);
  assert.equal(recovered.total, 2);
  assert.equal(recovered.linksStatus, 'unavailable');
});
