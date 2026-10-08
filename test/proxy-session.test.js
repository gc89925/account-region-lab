import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProxySessionOptions, getProxySessionOptions, inspectProxySession, prepareProxySession } from '../public/proxy-session.js';

const proxy = 'socks5://geo.iproyal.com:12321';
const base = 'synthetic-secret%40+base';
const auth = { username: 'synthetic-user', password: `${base}_country-id_session-DemoAb12_lifetime-168h_streaming-1` };

test('session inspection exposes routing metadata without either credential or full session', () => {
  const session = inspectProxySession(proxy, auth);
  assert.deepEqual({ ...session, sessionFingerprint: null }, {
    provider: 'iproyal', country: 'ID', countries: ['ID'], sessionHint: 'De…12', sessionFingerprint: null,
    lifetime: '168h', hours: 168, killswitch: false, streaming: true, rotating: false,
    options: { country: 'id', lifetime: '168h', streaming: '1' }, issues: []
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

test('route editing preserves original credentials, order, and untouched session bytes', () => {
  const original = { ...auth, password: `${auth.password}_city-jakarta_killswitch-1`, marker: 'local-only' };
  const changed = applyProxySessionOptions(proxy, original, { lifetime: '24h', streaming: false, session: undefined, region: 'asiapacific' });
  assert.deepEqual(changed, {
    username: original.username, marker: 'local-only',
    password: `${base}_country-id_session-DemoAb12_lifetime-24h_city-jakarta_killswitch-1_region-asiapacific`
  });
  assert.equal(original.password, `${auth.password}_city-jakarta_killswitch-1`);
  assert.equal(applyProxySessionOptions(proxy, original, {}).password, original.password);
  assert.equal(applyProxySessionOptions(proxy, original, { session: undefined }), original);
  assert.equal(applyProxySessionOptions(proxy, original, { city: 'jakarta' }), original);
  const specialBase = { ...auth, password: auth.password.replace(base, 'literal_with-dashes%40+') };
  assert.equal(applyProxySessionOptions(proxy, specialBase, { streaming: false }).password, specialBase.password.replace('_streaming-1', ''));
});

test('only explicit edits remove or enable parameters, and do not invent a session', () => {
  const changed = applyProxySessionOptions(proxy, auth, { streaming: null, session: '', killswitch: true, country: 'NG' });
  assert.equal(changed.password, `${base}_country-ng_lifetime-168h_killswitch-1`);
  assert.deepEqual(getProxySessionOptions(proxy, changed), { country: 'ng', lifetime: '168h', killswitch: '1' });
  assert.equal(inspectProxySession(proxy, changed).rotating, true);
  const emptyRoutes = applyProxySessionOptions(proxy, { username: 'user', password: base }, { city: undefined });
  assert.equal(emptyRoutes.password, base);
  assert.throws(() => applyProxySessionOptions(proxy, auth, { session: false }), /文本值/);
});

test('local editor can access complete route values but public metadata never includes a full session', () => {
  const original = { username: 'user', password: 'base_country-ng_session-AbCd1234_lifetime-1h_region-africa_city-lagos_isp-exampleisp' };
  const local = getProxySessionOptions(proxy, original);
  assert.equal(local.session, 'AbCd1234');
  assert.equal(local.city, 'lagos');
  assert.ok(!Object.hasOwn(local, 'username'));
  assert.ok(!Object.hasOwn(local, 'password'));
  const metadata = inspectProxySession(proxy, original);
  assert.equal(metadata.options.city, 'lagos');
  assert.equal(metadata.options.isp, 'exampleisp');
  assert.equal(metadata.options.region, 'africa');
  assert.equal(metadata.options.session, undefined);
  assert.ok(!JSON.stringify(metadata).includes('AbCd1234'));
  assert.ok(!JSON.stringify(metadata).includes('base_'));
});

test('new route syntax is checked even without strict IP and dependencies must be satisfied', () => {
  for (const updates of [
    { region: 'not-a-region' }, { city: 'bad_city' }, { city: 'new york' }, { state: 'state_session-NewSess1' },
    { isp: 'contains space' }, { isp: 'exampleisp' }, { set: 'nikeeu,courir' }, { set: '_session-DemoAb12' },
    { geolocation: '90.1,0,10' }, { geolocation: '0,180.1,10' }, { geolocation: '0,0,9' },
    { geolocation: '0,0,10,loose' }, { geolocation: '0,0,Infinity' }, { geolocation: '0,0,10,strict,extra' },
    { geolocation: '0,0,10_session-Injected' }, { skipipslist: 'not-ulid' },
    { lifetime: '8d' }, { session: 'short' }, { streaming: '3' }, { country: 'nigeria' }
  ]) assert.throws(() => applyProxySessionOptions(proxy, auth, updates), { name: 'ProxySessionError' });
  const withoutCountry = { username: 'user', password: 'base_session-DemoAb12_lifetime-1h' };
  assert.throws(() => applyProxySessionOptions(proxy, withoutCountry, { city: 'lagos' }), /country/);
  assert.throws(() => applyProxySessionOptions(proxy, withoutCountry, { state: 'armavir' }), /country/);
  const withIsp = applyProxySessionOptions(proxy, auth, { city: 'jakarta', isp: 'exampleisp' });
  assert.equal(getProxySessionOptions(proxy, withIsp).isp, 'exampleisp');
  assert.throws(() => applyProxySessionOptions(proxy, withIsp, { city: '' }), /country 和 city/);
  assert.throws(() => applyProxySessionOptions(proxy, withIsp, { country: null }), /country/);
  const foreignState = applyProxySessionOptions(proxy, auth, { country: 'am', state: 'armavir' });
  assert.equal(getProxySessionOptions(proxy, foreignState).state, 'armavir');
});

test('documented optional routes round-trip without automatic permission-gated defaults', () => {
  const original = { username: 'user', password: 'base_country-us_session-AbCd1234_lifetime-1h' };
  const updates = {
    region: 'northamerica', city: 'newyork', state: 'newyork', isp: 'exampleisp',
    geolocation: '40.68,-74.01,10,strict',
    skipispstatic: true, streaming: true, set: 'nikena'
  };
  const changed = applyProxySessionOptions(proxy, original, updates);
  const options = getProxySessionOptions(proxy, changed);
  assert.equal(options.session, 'AbCd1234');
  for (const [key, value] of Object.entries(updates)) assert.equal(options[key], value === true ? '1' : value);
  assert.equal(getProxySessionOptions(proxy, original).streaming, undefined);
  assert.equal(getProxySessionOptions(proxy, original).skipispstatic, undefined);
  const skipped = applyProxySessionOptions(proxy, original, { skipipslist: '01GRBHR1DMBFRH8VW7APEWD5BQ' });
  assert.equal(getProxySessionOptions(proxy, skipped).skipipslist, '01GRBHR1DMBFRH8VW7APEWD5BQ');
  assert.throws(() => prepareProxySession(proxy, changed, { strictIp: true, country: 'US' }), /set 国家集合/);
  const withoutSet = applyProxySessionOptions(proxy, changed, { set: '', isp: '', skipipslist: '', geolocation: '' });
  assert.equal(prepareProxySession(proxy, withoutSet, { strictIp: true, country: 'US' }).session.killswitch, true);
  for (const value of ['-90,-180,10', '90,180,10,strict', '.5,-.5,12.5']) {
    assert.equal(getProxySessionOptions(proxy, applyProxySessionOptions(proxy, original, { geolocation: value })).geolocation, value);
  }
});

test('malformed source routes and unknown patch keys fail closed without exposing values', () => {
  for (const original of [
    { ...auth, password: `${auth.password}_unexpected-private-secret` },
    { ...auth, password: `${auth.password}_city-one_city-two` },
    { ...auth, password: `${auth.password}_broken` }
  ]) {
    for (const action of [() => getProxySessionOptions(proxy, original), () => applyProxySessionOptions(proxy, original, { streaming: false })]) {
      assert.throws(action, error => error.name === 'ProxySessionError' && !error.message.includes('private-secret') && !error.message.includes(base));
    }
  }
  for (const updates of [null, [], 1, 'country-ng', { username: 'secret' }, { password: 'secret' }, { COUNTRY: 'ng' }, { country: {} }, JSON.parse('{"__proto__":"secret"}')]) {
    assert.throws(() => applyProxySessionOptions(proxy, auth, updates), error => error.name === 'ProxySessionError' && !error.message.includes('secret'));
  }
  assert.deepEqual(getProxySessionOptions('socks5://other.example:1080', auth), {});
  assert.throws(() => applyProxySessionOptions('socks5://other.example:1080', auth, { country: 'ng' }), /仅适用于/);
  assert.throws(() => getProxySessionOptions(proxy, null), /完整用户名/);
  assert.throws(() => applyProxySessionOptions(proxy, null, { country: 'ng' }), /完整用户名/);
  const huge = { ...auth, password: 'b'.repeat(180) + '_country-id_session-DemoAb12_lifetime-168h' };
  assert.throws(() => applyProxySessionOptions(proxy, huge, { geolocation: '40.7128000000,-74.0060000000,10,strict' }), /255/);
});
