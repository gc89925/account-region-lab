import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvironment, environmentLockedEqual } from '../lib/environment.js';

test('environment country defaults remain stable and inputs are not mutated', () => {
  assert.deepEqual(normalizeEnvironment(), { engine: 'native', locale: 'en-IN', timezoneId: 'Asia/Kolkata', viewport: { width: 1365, height: 900 }, colorScheme: 'light' });
  assert.equal(normalizeEnvironment({}, 'NG').timezoneId, 'Africa/Lagos');
  assert.equal(normalizeEnvironment({}, 'NG').locale, 'en-NG');
  assert.equal(normalizeEnvironment({}, 'FR').locale, 'en-US');
  assert.equal(normalizeEnvironment({}, '__proto__').locale, 'en-US');
  const input = { viewport: { width: 1920 }, engine: 'managed', locale: 'en-in', colorScheme: 'system' };
  const result = normalizeEnvironment(input);
  assert.equal(result.locale, 'en-IN');
  assert.equal(result.viewport.height, 900);
  assert.deepEqual(input.viewport, { width: 1920 });
});

test('environment rejects invalid or extra settings instead of silently masking them', () => {
  for (const input of [null, [], 'test', { timezoneId: 'Europe/NotReal' }, { timezoneId: null }, { timezoneId: '+08:00' },
    { locale: 'invalid_locale' }, { locale: 'zz-ZZ' }, { locale: ['en-US'] }, { engine: 'stealth' },
    { userAgent: 'fake' }, { args: ['--no-sandbox'] }, { colorScheme: 'automatic' },
    { viewport: null }, { viewport: { width: '1280' } }, { viewport: { width: 639 } },
    { viewport: { width: 2561 } }, { viewport: { height: 479 } }, { viewport: { height: 1601 } },
    { viewport: { width: 1280.5 } }, { viewport: { mobile: true } },
    JSON.parse('{"__proto__": {"engine":"managed"}}')]) assert.throws(() => normalizeEnvironment(input));
  assert.equal(environmentLockedEqual({ locale: 'en-in' }, { locale: 'en-IN' }), true);
  assert.equal(environmentLockedEqual({}, { engine: 'managed' }), false);
});
