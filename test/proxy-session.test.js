import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProxySession, prepareProxySession } from '../public/proxy-session.js';

const proxy = 'socks5://geo.iproyal.com:12321';
const base = 'synthetic-secret%40+base';
const auth = { username: 'synthetic-user', password: `${base}_country-id_session-DemoAb12_lifetime-168h_streaming-1` };

test('session inspection exposes routing metadata without either credential or full session', () => {
  const session = inspectProxySession(proxy, auth);
  assert.deepEqual({ ...session, sessionFingerprint: null }, {
    provider: 'iproyal', country: 'ID', countries: ['ID'], sessionHint: 'De…12', sessionFingerprint: null,
    lifetime: '168h', hours: 168, killswitch: false, streaming: true, rotating: false, issues: []
  });
  const serialized = JSON.stringify(session);
  for (const secret of [auth.username, base, 'DemoAb12']) assert.ok(!serialized.includes(secret));
  assert.equal(session.sessionFingerprint, inspectProxySession(proxy, { username: 'another-user', password: auth.password.replace(base, 'different-secret') }).sessionFingerprint);
  assert.notEqual(session.sessionFingerprint, inspectProxySession(proxy, { ...auth, password: auth.password.replace('DemoAb12', 'DemoAb13') }).sessionFingerprint);
});

test('strict preparation preserves all routing parameters and literal auth, adding only killswitch', () => {
  const result = prepareProxySession(proxy, auth, { strictIp: true, country: 'ID' });
  assert.equal(result.proxy, proxy);
  assert.equal(result.auth.username, auth.username);
  assert.equal(result.auth.password, `${auth.password}_killswitch-1`);
  assert.equal(result.changed, true);
  assert.equal(result.session.killswitch, true);
  assert.equal(auth.password.endsWith('_killswitch-1'), false);
  const repeated = prepareProxySession(proxy, result.auth, { strictIp: true, country: 'id' });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.auth, result.auth);
});

test('an explicitly disabled killswitch is replaced once without losing trailing options', () => {
  const original = { ...auth, password: auth.password.replace('_streaming-1', '_killswitch-0_streaming-1_city-jakarta') };
  const result = prepareProxySession(proxy, original, { strictIp: true, country: 'ID' });
  assert.equal(result.auth.password, original.password.replace('_killswitch-0', '_killswitch-1'));
  assert.equal(result.proxy, proxy);
});

test('non-strict and unrelated provider configurations are returned untouched', () => {
  const rotatingAuth = { ...auth, password: `${base}_country-id` };
  assert.equal(prepareProxySession(proxy, rotatingAuth).auth, rotatingAuth);
  assert.equal(inspectProxySession(proxy, rotatingAuth).rotating, true);
  for (const endpoint of ['socks5://other.example:1080', 'http://geo.iproyal.com.attacker.example:12321', 'invalid']) {
    const result = prepareProxySession(endpoint, auth, { strictIp: true, country: 'ID' });
    assert.equal(result.auth, auth);
    assert.equal(result.proxy, endpoint);
    assert.equal(result.session.provider, null);
    assert.deepEqual(result.session.issues, []);
  }
});

test('missing, duplicate, malformed and unknown parameters fail closed with redacted errors', () => {
  for (const password of [
    base, `${base}_country-id_session-DemoAb12`, `${base}_country-id_lifetime-1h`,
    auth.password.replace('_country-id', ''), auth.password.replace('DemoAb12', 'short'),
    auth.password + '_country-in', auth.password + '_session-Other123',
    auth.password + '_lifetime-1h', auth.password + '_killswitch-1_killswitch-0',
    auth.password + '_streaming-1', auth.password + '_unexpected-private-secret',
    auth.password + '_broken', auth.password + '_killswitch-', auth.password + '_streaming-2',
    auth.password.replace('_session-', '_SESSION-'),
    auth.password.replace(base, `${base}\n`)
  ]) {
    assert.throws(() => prepareProxySession(proxy, { ...auth, password }, { strictIp: true, country: 'ID' }), error => {
      assert.equal(error.name, 'ProxySessionError');
      assert.ok(error.sessionIssues.length > 0);
      assert.equal(error.code, undefined);
      assert.ok(!error.message.includes(base));
      assert.ok(!error.message.includes(auth.username));
      assert.ok(!error.message.includes('private-secret'));
      return true;
    });
  }
  assert.throws(() => prepareProxySession(proxy, {}, { strictIp: true, country: 'ID' }), /完整用户名/);
  assert.throws(() => prepareProxySession(proxy, { ...auth, username: '界'.repeat(86) }, { strictIp: true, country: 'ID' }), /UTF-8 字节/);
});

test('lifetime accepts only one integer unit within the inclusive one-second to seven-day range', () => {
  for (const [lifetime, hours] of [['1s', 1 / 3600], ['60m', 1], ['168h', 168], ['7d', 168], ['604800s', 168]]) {
    const session = inspectProxySession(proxy, { ...auth, password: auth.password.replace('168h', lifetime) });
    assert.equal(session.lifetime, lifetime);
    assert.equal(session.hours, hours);
    assert.deepEqual(session.issues, []);
  }
  for (const value of ['0s', '8d', '169h', '604801s', '1h30m', '1.5h', '-1h', '1w', '1H', 'Infinityh', '9999999999999999999999999s']) {
    assert.throws(() => prepareProxySession(proxy, { ...auth, password: auth.password.replace('168h', value) }, { strictIp: true, country: 'ID' }), /1 秒至 7 天/);
  }
});

test('strict country matching rejects unknown target, multiple countries and intentional randomization', () => {
  const multi = { ...auth, password: auth.password.replace('_country-id', '_country-id,in') };
  assert.deepEqual(inspectProxySession(proxy, multi).countries, ['ID', 'IN']);
  assert.equal(prepareProxySession(proxy, multi).auth, multi);
  assert.throws(() => prepareProxySession(proxy, multi, { strictIp: true, country: 'ID' }), /多个国家/);
  assert.throws(() => prepareProxySession(proxy, auth, { strictIp: true, country: 'IN' }), /与环境国家 IN 不符/);
  assert.throws(() => prepareProxySession(proxy, auth, { strictIp: true }), /目标国家/);
  assert.throws(() => prepareProxySession(proxy, { ...auth, password: `${auth.password}_forcerandom-1` }, { strictIp: true, country: 'ID' }), /强制随机/);
  assert.equal(prepareProxySession(proxy, { ...auth, password: `${auth.password}_forcerandom-0` }, { strictIp: true, country: 'ID' }).session.rotating, false);
});

test('metadata and preparation keep original protocol and port even when provider docs disagree', () => {
  for (const endpoint of ['socks5://geo.iproyal.com:12321', 'socks5://geo.iproyal.com:32325', 'http://geo.iproyal.com:12321']) {
    assert.equal(prepareProxySession(endpoint, auth, { strictIp: true, country: 'ID' }).proxy, endpoint);
  }
});

test('adding protection cannot silently exceed the SOCKS5 credential byte limit', () => {
  const suffix = auth.password.slice(base.length);
  const long = { ...auth, password: 'a'.repeat(255 - suffix.length) + suffix };
  assert.throws(() => prepareProxySession(proxy, long, { strictIp: true, country: 'ID' }), /255 字节/);
});
