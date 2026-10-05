import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserArgs, countryCode, makeProfile, profileInput, validateProxy, withStats, LINKS } from '../lib/model.js';

test('proxy validation permits explicit HTTP/SOCKS5 endpoints without credentials', () => {
  assert.equal(validateProxy('http://127.0.0.1:18080'), 'http://127.0.0.1:18080');
  assert.equal(validateProxy('http://127.0.0.1:80'), 'http://127.0.0.1:80');
  assert.equal(validateProxy('socks5://localhost:1080/'), 'socks5://localhost:1080');
  assert.equal(validateProxy('socks5://[::1]:1080'), 'socks5://[::1]:1080');
  assert.equal(validateProxy(''), '');
});

test('proxy validation rejects credentials, unsupported schemes, fallback lists and extra arguments', () => {
  for (const proxy of [
    null, {}, 12, '127.0.0.1:1080', 'https://localhost:1080', 'file:///tmp/proxy',
    'http://user:secret@localhost:18080', 'socks5://user@localhost:1080',
    'http://localhost', 'http://localhost:0', 'http://localhost:65536',
    'http://localhost:1080/path', 'http://localhost:1080?direct=true',
    'http://localhost:1080#fragment', 'http://localhost:1080;direct://',
    'http://localhost:1080 --no-proxy-server', 'http://localhost:1080\n--no-proxy-server',
    'http://localhost:1080\\evil',
  ]) assert.throws(() => validateProxy(proxy), undefined, String(proxy));
});

test('profile input validates names and country codes and never imports caller IDs or history', () => {
  assert.equal(countryCode('in'), 'IN');
  for (const country of ['China', 'XX', 'IN ', '', null, 1]) assert.throws(() => countryCode(country));
  for (const label of ['', '  ', 'x'.repeat(81), 'bad\nname']) {
    assert.throws(() => profileInput({ label, country: 'IN', proxy: '' }));
  }
  const first = makeProfile({ id: '../escape', label: ' India ', country: 'in', proxy: '', checks: ['forged'] });
  const second = makeProfile({ label: 'India', country: 'IN', proxy: '' });
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.label, 'India');
  assert.deepEqual(first.checks, []);
  assert.equal(first.cycleStartedAt, null);
});

test('browser arguments require a proxy and only navigate to an allowed official destination', () => {
  const profile = makeProfile({ label: 'India', country: 'IN', proxy: 'socks5://127.0.0.1:1080' });
  for (const target of ['gmail', 'youtube', 'terms', 'appeal']) {
    const args = buildBrowserArgs(profile, 'C:/temporary test/profile-1', target);
    assert.equal(args.at(-1), LINKS[target]);
    assert.ok(args.includes('--user-data-dir=C:/temporary test/profile-1'));
    assert.ok(args.includes('--proxy-server=socks5://127.0.0.1:1080'));
    assert.ok(args.includes('--disable-quic'));
    assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(!args.includes('--no-proxy-server'));
  }
  for (const target of ['https://example.com/', 'faq', '__proto__', 'constructor']) {
    assert.throws(() => buildBrowserArgs(profile, 'profile', target));
  }
  assert.throws(() => buildBrowserArgs({ ...profile, proxy: '' }, 'profile', 'gmail'));
});

test('seven-day review calculations count only observations in the current cycle', () => {
  const started = '2026-10-05T00:00:00.000Z';
  const profile = {
    ...makeProfile({ label: 'Nigeria', country: 'NG', proxy: '' }),
    cycleStartedAt: started,
    observations: [{ at: '2026-10-04T23:59:59.000Z' }, { at: started }, { at: '2026-10-07T00:00:00.000Z' }],
  };
  const { stats } = withStats(profile, Date.parse('2026-10-12T12:00:00.000Z'));
  assert.deepEqual(stats, { elapsedDays: 7, nextReviewAt: '2026-10-12T00:00:00.000Z', observationCount: 2 });
  assert.equal(withStats(profile, Date.parse('2026-10-01T00:00:00.000Z')).stats.elapsedDays, 0);
});
