import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleProxyStability, createStabilityHistory } from '../lib/proxy-stability.js';

const endpoint = 'socks5://127.0.0.1:12000';
const sample = (ip = '203.0.113.8', country = 'NG') => ({ ip, country });
const stable = ip => ({ stable: true, complete: true, uniqueIps: [ip] });

test('three independent sequential samples confirm a consistent IP and country', async () => {
  let count = 0, active = 0;
  const result = await sampleProxyStability(endpoint, { first: sample(), probe: async proxy => {
    assert.equal(proxy, endpoint);
    assert.equal(active++, 0);
    await Promise.resolve();
    active--; count++;
    return { ...sample(undefined, 'ng'), source: 'https://api.country.is/?private=ignored' };
  } });
  assert.equal(count, 2);
  assert.equal(result.samples.length, 3);
  assert.equal(result.complete, true);
  assert.equal(result.stable, true);
  assert.equal(result.observedCountry, 'NG');
  assert.deepEqual(result.uniqueIps, ['203.0.113.8']);
  assert.equal(result.samples[1].source, 'https://api.country.is');
});

test('rotating exits remain visible and sampling continues after the first IP change', async () => {
  const remaining = ['203.0.113.9', '203.0.113.10'];
  const result = await sampleProxyStability(endpoint, { first: sample(), probe: async () => sample(remaining.shift()) });
  assert.equal(result.complete, true);
  assert.equal(result.stable, false);
  assert.equal(result.observedCountry, 'NG');
  assert.deepEqual(result.uniqueIps, ['203.0.113.8', '203.0.113.9', '203.0.113.10']);
  assert.equal(remaining.length, 0);
});

test('a failed request makes the run incomplete without hiding other observations or printing raw errors', async () => {
  let count = 0;
  const result = await sampleProxyStability(endpoint, { first: sample(), probe: async () => {
    if (count++ === 0) throw new Error('curl command dummy-password-do-not-print');
    return sample();
  } });
  assert.equal(result.complete, false);
  assert.equal(result.stable, false);
  assert.deepEqual(result.samples.map(entry => entry.ok), [true, false, true]);
  assert.equal(result.observedCountry, 'NG');
  assert.ok(!JSON.stringify(result).includes('dummy-password'));
});

test('structured diagnostics retain useful text while credentials and connection addresses are redacted', async () => {
  const secretProxy = 'http://dummy-user:dummy%2Bsecret@proxy.example:12321';
  const result = await sampleProxyStability(secretProxy, { first: sample(), probe: async () => {
    throw Object.assign(new Error('ignored raw error'), { diagnostic: {
      message: `认证失败 ${secretProxy} password=dummy+secret proxy.example:12321:dummy-user:dummy+secret`,
    } });
  } });
  const text = JSON.stringify(result);
  assert.match(text, /认证失败/);
  for (const credential of ['dummy-user', 'dummy%2Bsecret', 'dummy+secret', 'proxy.example', 'ignored raw error']) {
    assert.ok(!text.includes(credential), credential);
  }
});

test('invalid first sample, malformed IP, and invalid country count as failed observations', async () => {
  let count = 0;
  const result = await sampleProxyStability(endpoint, { first: undefined, probe: async () => {
    return count++ === 0 ? sample('not-an-ip') : sample('203.0.113.8', 'ZZ');
  } });
  assert.equal(result.samples.length, 3);
  assert.equal(result.complete, false);
  assert.equal(result.stable, false);
  assert.deepEqual(result.uniqueIps, []);
  assert.equal(result.observedCountry, null);
});

test('inconsistent country observations do not confirm stability even for one IP', async () => {
  const result = await sampleProxyStability(endpoint, { first: sample(), probe: async () => sample(undefined, 'PH') });
  assert.equal(result.complete, true);
  assert.equal(result.stable, false);
  assert.equal(result.observedCountry, null);
});

test('equivalent IPv6 spellings compare as the same exit', async () => {
  const result = await sampleProxyStability(endpoint, { first: sample('2001:0db8:0:0:0:0:0:1'), probe: async () => sample('2001:db8::1') });
  assert.equal(result.stable, true);
  assert.deepEqual(result.uniqueIps, ['2001:db8::1']);
});

test('scoped IPv6 addresses are rejected as invalid exit observations without throwing', async () => {
  const result = await sampleProxyStability(endpoint, { first: sample('fe80::1%eth0'), probe: async () => sample() });
  assert.equal(result.complete, false);
  assert.equal(result.stable, false);
  assert.equal(result.samples[0].ok, false);
});

test('sampling refuses unbounded or invalid sample counts', async () => {
  for (const sampleCount of [0, 4, -1, 2.5, NaN]) {
    await assert.rejects(sampleProxyStability(endpoint, { first: sample(), probe: async () => sample(), sampleCount }), RangeError);
  }
});

test('history retains the first stable baseline across subsequent exit changes and failures', () => {
  const history = createStabilityHistory();
  assert.deepEqual(history.compare('opaque-a', stable('203.0.113.8')), { comparedWithPrevious: false, changedSincePrevious: false });
  assert.deepEqual(history.compare('opaque-a', stable('203.0.113.9')), {
    comparedWithPrevious: true, changedSincePrevious: true, previousIp: '203.0.113.8',
  });
  assert.equal(history.compare('opaque-a', stable('203.0.113.9')).previousIp, '203.0.113.8');
  assert.deepEqual(history.compare('opaque-a', { complete: false, stable: false, uniqueIps: [] }), {
    comparedWithPrevious: true, changedSincePrevious: false, previousIp: '203.0.113.8',
  });
  assert.equal(history.compare('opaque-a', { complete: false, stable: false, uniqueIps: ['203.0.113.10'] }).changedSincePrevious, true);
});

test('history expires from baseline creation, rather than sliding after repeated diagnostics', () => {
  let timestamp = 0;
  const history = createStabilityHistory({ now: () => timestamp, ttlMs: 100 });
  history.compare('opaque-a', stable('203.0.113.8'));
  timestamp = 90;
  assert.equal(history.compare('opaque-a', stable('203.0.113.9')).changedSincePrevious, true);
  timestamp = 100;
  assert.equal(history.compare('opaque-a', stable('203.0.113.9')).comparedWithPrevious, false);
  timestamp = 101;
  assert.equal(history.compare('opaque-a', stable('203.0.113.10')).previousIp, '203.0.113.9');
});

test('separate opaque configuration keys do not share baselines, and unstable runs cannot seed one', () => {
  const history = createStabilityHistory();
  history.compare('opaque-a', stable('203.0.113.8'));
  assert.equal(history.compare('opaque-b', stable('203.0.113.9')).comparedWithPrevious, false);
  history.compare('opaque-c', { stable: false, complete: true, uniqueIps: ['203.0.113.8', '203.0.113.9'] });
  assert.equal(history.compare('opaque-c', stable('203.0.113.10')).comparedWithPrevious, false);
  assert.equal(history.compare('opaque-a', stable('203.0.113.8')).changedSincePrevious, false);
  assert.equal(history.compare('opaque-b', stable('203.0.113.9')).previousIp, '203.0.113.9');
});

test('history has bounded entry count and evicts the oldest baseline', () => {
  const history = createStabilityHistory({ maxEntries: 2 });
  history.compare('opaque-a', stable('203.0.113.8'));
  history.compare('opaque-b', stable('203.0.113.9'));
  history.compare('opaque-a', stable('203.0.113.8'));
  history.compare('opaque-c', stable('203.0.113.10'));
  assert.equal(history.compare('opaque-b', stable('203.0.113.9')).comparedWithPrevious, true);
  assert.equal(history.compare('opaque-a', stable('203.0.113.8')).comparedWithPrevious, false);
});
