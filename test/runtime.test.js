import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { acquireLock, curlArgs, diagnoseProxy, launchBrowser, probeErrorMessage, probeProxy, proxyErrorDetails } from '../lib/runtime.js';

test('proxy probe disables curl configuration and environment bypasses and resolves SOCKS DNS through the proxy', () => {
  for (const proxy of ['http://127.0.0.1:18080', 'socks5://127.0.0.1:1080']) {
    const args = curlArgs(proxy);
    assert.equal(args[0], '--disable', 'curl must ignore user .curlrc before reading any other argument');
    assert.equal(args[args.indexOf('--noproxy') + 1], '', 'Even inherited NO_PROXY must not bypass the selected proxy');
    assert.equal(args[args.indexOf('--proxy') + 1], proxy.replace(/^socks5:/, 'socks5h:'));
    assert.equal(args.filter(argument => argument.startsWith('https://')).length, 1);
    assert.equal(args[args.indexOf('--proto') + 1], '=https');
    assert.ok(!args.includes('--location'), 'The probe must not follow arbitrary redirects');
    assert.ok(!args.some(argument => argument.includes('direct://')), 'No direct connection fallback may be configured');
    assert.ok(Number(args[args.indexOf('--max-time') + 1]) > 0);
  }
  assert.throws(() => curlArgs(''));
  assert.throws(() => curlArgs('http://user:password@localhost:1080'));
});

test('a data directory has one active writer and can be reopened after its lock is released', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'account-region-lab-lock-test-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const release = acquireLock(dataDir);
  try { assert.throws(() => acquireLock(dataDir)); } finally { release(); }
  const releaseAgain = acquireLock(dataDir);
  releaseAgain();
});

test('native launcher surfaces process failures instead of reporting a successful spawn', async () => {
  await assert.rejects(launchBrowser(process.execPath, ['-e', 'process.exit(7)']), /立即退出/);
  await assert.rejects(launchBrowser('missing-arl-browser-executable', []), /无法启动/);
  assert.ok((await launchBrowser(process.execPath, ['-e', 'process.exit(0)'])).pid);
});

test('proxy failures give actionable errors without exposing raw subprocess output', () => {
  assert.match(probeErrorMessage({code:7}), /启动代理软件/);
  assert.match(probeErrorMessage({code:28}), /超时/);
  assert.match(probeErrorMessage({code:'ENOENT'}), /curl/);
  assert.ok(!probeErrorMessage({code:99,stderr:'private proxy information'}).includes('private'));
});

test('curl SOCKS errors distinguish authentication, protocol mismatch and target failures without echoing stderr', () => {
  const cases = [
    ['No authentication method was acceptable.', 'proxy_auth_required', 'proxy_auth'],
    ['SOCKS5: no acceptable authentication method is available.', 'proxy_auth_required', 'proxy_auth'],
    ['User was rejected by the SOCKS5 server (1 1).', 'proxy_auth_rejected', 'proxy_auth'],
    ['Received invalid version in initial SOCKS5 response.', 'proxy_protocol_mismatch', 'proxy_protocol'],
    ['cannot complete SOCKS5 connection to secret.invalid. (2)', 'socks_target_denied', 'target_connect'],
    ['cannot complete SOCKS5 connection to secret.invalid. (3)', 'socks_network_unreachable', 'target_connect'],
    ['cannot complete SOCKS5 connection to secret.invalid. (4)', 'socks_host_unreachable', 'target_connect'],
    ['cannot complete SOCKS5 connection to secret.invalid. (5)', 'socks_target_refused', 'target_connect'],
    ['Failed to resolve "secret.invalid" for SOCKS5 connect.', 'target_dns_failed', 'target_dns'],
  ];
  for (const [stderr, code, stage] of cases) {
    const details = proxyErrorDetails({ code: 97, stderr: `${stderr}\nprivate-password=secret` });
    assert.equal(details.code, code);
    assert.equal(details.stage, stage);
    assert.ok(!JSON.stringify(details).includes('secret'));
  }
  assert.equal(proxyErrorDetails({ code: 56, stderr: 'CONNECT tunnel failed, response 407' }).stage, 'proxy_auth');
  assert.equal(proxyErrorDetails({ code: 56, stderr: 'CONNECT tunnel failed, response 403' }).code, 'http_connect_rejected');
  assert.equal(proxyErrorDetails({ code: 28 }).stage, 'timeout');
});

test('a blocked geo provider falls back through the same proxy to a second HTTPS provider', async () => {
  const calls = [];
  const runCurl = async (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) throw Object.assign(new Error('private stderr'), { code: 97, stderr: 'cannot complete SOCKS5 connection to api.country.is. (4)' });
    return { stdout: JSON.stringify({ success: true, ip: '203.0.113.8', country_code: 'US' }) };
  };
  const result = await probeProxy('socks5://127.0.0.1:1080', { runCurl });
  assert.equal(result.country, 'US');
  assert.equal(result.ip, '203.0.113.8');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.args.at(-1)), ['https://api.country.is/', 'https://ipwho.is/']);
  for (const { args, options } of calls) {
    assert.equal(args[args.indexOf('--proxy') + 1], 'socks5h://127.0.0.1:1080');
    assert.equal(args[args.indexOf('--noproxy') + 1], '');
    assert.equal(options.env.ALL_PROXY, '');
    assert.ok(!args.includes('--insecure'));
  }
});

test('invalid geo data cannot become a passed probe and fallback does not hide auth failure', async () => {
  let calls = 0;
  const invalid = async () => { calls += 1; return { stdout: '{"ip":"not-an-ip","country":"US"}' }; };
  await assert.rejects(probeProxy('http://127.0.0.1:8080', { runCurl: invalid }), error => error.diagnostic.code === 'probe_invalid_response');
  assert.equal(calls, 2);
  calls = 0;
  const needsAuth = async () => {
    calls += 1;
    throw { code: 97, stderr: 'No authentication method was acceptable.' };
  };
  const diagnosis = await diagnoseProxy('socks5://127.0.0.1:1080', { runCurl: needsAuth });
  assert.equal(diagnosis.error.code, 'proxy_auth_required');
  assert.equal(diagnosis.alternateProtocol, undefined);
  assert.equal(calls, 1, 'An authentication reply proves SOCKS, so do not try a different protocol or host');
});

test('diagnosis suggests a tested alternate protocol without changing the failed configured protocol', async () => {
  const calls = [];
  const runCurl = async (_command, args) => {
    const proxy = args[args.indexOf('--proxy') + 1];
    calls.push(proxy);
    if (proxy.startsWith('socks5h:')) throw { code: 97, stderr: 'Received invalid version in initial SOCKS5 response.' };
    return { stdout: '{"ip":"203.0.113.9","country":"JP"}' };
  };
  const result = await diagnoseProxy('socks5://127.0.0.1:8080', { runCurl });
  assert.equal(result.ok, false);
  assert.equal(result.configuredProtocol, 'socks5');
  assert.equal(result.suggestedProtocol, 'http');
  assert.equal(result.alternateProtocol.ok, true);
  assert.equal(result.alternateProtocol.probe.country, 'JP');
  assert.deepEqual(calls, ['socks5h://127.0.0.1:8080', 'http://127.0.0.1:8080']);
  const strict = await diagnoseProxy('socks5://127.0.0.1:8080', { runCurl, tryAlternateProtocol: false });
  assert.equal(strict.suggestedProtocol, undefined);
});

async function fakeProxy(t, respond) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    respond(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `socks5://127.0.0.1:${server.address().port}`;
}

test('real curl distinguishes a SOCKS server requesting authentication from an HTTP port', async t => {
  const auth = await fakeProxy(t, socket => socket.once('data', () => socket.end(Buffer.from([5, 255]))));
  const authResult = await diagnoseProxy(auth);
  assert.equal(authResult.error.code, 'proxy_auth_required');
  const http = await fakeProxy(t, socket => socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')));
  const protocolResult = await diagnoseProxy(http, { tryAlternateProtocol: false });
  assert.equal(protocolResult.error.code, 'proxy_protocol_mismatch');
});

test('real curl target rejection is not mislabeled as a SOCKS handshake or password failure', async t => {
  let requests = 0;
  const proxy = await fakeProxy(t, socket => {
    socket.once('data', () => {
      socket.write(Buffer.from([5, 0]));
      socket.once('data', () => {
        requests += 1;
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
  });
  const result = await diagnoseProxy(proxy);
  assert.equal(result.error.code, 'socks_target_refused');
  assert.equal(result.error.socksReply, 5);
  assert.equal(requests, 2, 'Try each HTTPS geo target once, with no direct connection or protocol switch');
  assert.equal(result.alternateProtocol, undefined);
});
