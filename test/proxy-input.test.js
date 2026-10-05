import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProxyInput, parseProxyInput } from '../public/proxy-input.js';

function fields() {
  return {
    proxy: { value: 'socks5://old.example:1080', disabled: false, readOnly: false },
    username: { value: 'previous-user', disabled: false, readOnly: false },
    password: { value: 'previous-password', disabled: false, readOnly: false },
    clearAuth: { checked: false }
  };
}

test('full SOCKS5 credential URI splits into a credential-free address and exact auth fields', () => {
  assert.deepEqual(parseProxyInput('  socks5://dummy-user:dummy-password@192.0.2.8:50123  '), {
    proxy: 'socks5://192.0.2.8:50123', hasCredentials: true,
    proxyUsername: 'dummy-user', proxyPassword: 'dummy-password'
  });
  const result = parseProxyInput('socks5://%20demo%3Auser%20:demo%40p%3A%2F%25%23%3F%20%2B@[2001:db8::5]:1080/');
  assert.equal(result.proxy, 'socks5://[2001:db8::5]:1080');
  assert.equal(result.proxyUsername, ' demo:user ');
  assert.equal(result.proxyPassword, 'demo@p:/%#? +');
  assert.equal(parseProxyInput('socks5://dummy:literal+plus@proxy.example:1080').proxyPassword, 'literal+plus');
});

test('plain addresses normalize explicit ports without inventing credentials', () => {
  for (const [input, proxy] of [
    ['', ''], ['http://proxy.example:80', 'http://proxy.example:80'],
    ['SOCKS5://proxy.example:01080/', 'socks5://proxy.example:1080'],
    ['socks5://[2001:db8::2]:65535', 'socks5://[2001:db8::2]:65535']
  ]) assert.deepEqual(parseProxyInput(input), { proxy, hasCredentials: false });
});

test('unsupported and malformed credential inputs fail without echoing credentials', () => {
  const inputs = [
    'http://dummy-user:dummy-secret@proxy.example:80',
    'socks4://dummy-user:dummy-secret@proxy.example:1080',
    'socks5://dummy-user:dummy-secret@proxy.example',
    'socks5://dummy-user:dummy-secret@proxy.example:0',
    'socks5://dummy-user:dummy-secret@proxy.example:65536',
    'socks5://dummy-user:dummy-secret@2001:db8::5:1080',
    'socks5://dummy-user:dummy-secret@proxy.example:1080/path',
    'socks5://dummy-user:dummy-secret@proxy.example:1080?query',
    'socks5://dummy-user:dummy-secret@proxy.example:1080#fragment',
    'socks5://dummy-user:dummy-secret%ZZ@proxy.example:1080',
    'socks5://dummy-user:dummy-secret%C3%28@proxy.example:1080',
    'socks5://dummy-user:dummy-secret%00@proxy.example:1080',
    'socks5://dummy-user:dummy-secret%0A@proxy.example:1080',
    'socks5://dummy-user:dummy-secret@proxy.\nexample:1080',
    'socks5://:dummy-secret@proxy.example:1080',
    'socks5://dummy-user:@proxy.example:1080',
    'socks5://dummy-secret@proxy.example:1080'
  ];
  for (const input of inputs) assert.throws(() => parseProxyInput(input), error => {
    assert.ok(!error.message.includes('dummy-secret'));
    assert.ok(!error.message.includes('dummy-user'));
    return true;
  });
  assert.throws(() => parseProxyInput(inputs[0]), /仅支持 SOCKS5/);
});

test('credential byte limits use decoded UTF-8 instead of encoded URL length', () => {
  const allowed = '界'.repeat(85);
  assert.equal(parseProxyInput(`socks5://${encodeURIComponent(allowed)}:dummy@proxy.example:1080`).proxyUsername, allowed);
  assert.throws(() => parseProxyInput(`socks5://${encodeURIComponent('界'.repeat(86))}:dummy@proxy.example:1080`), /1–255/);
  assert.throws(() => parseProxyInput(`socks5://dummy:${encodeURIComponent('界'.repeat(86))}@proxy.example:1080`), /1–255/);
});

test('import replaces both prior credentials and cancels pending authentication removal', () => {
  const form = fields();
  form.clearAuth.checked = true;
  form.username.disabled = true;
  form.password.disabled = true;
  const result = applyProxyInput(form, 'socks5://new-user:new-password@proxy.example:1080');
  assert.equal(result.applied, true);
  assert.equal(form.proxy.value, 'socks5://proxy.example:1080');
  assert.equal(form.username.value, 'new-user');
  assert.equal(form.password.value, 'new-password');
  assert.equal(form.clearAuth.checked, false);
  assert.equal(form.username.disabled, false);
  assert.equal(form.password.disabled, false);
});

test('importing a plain proxy address preserves separately entered authentication', () => {
  const form = fields();
  applyProxyInput(form, 'socks5://proxy.example:1080');
  assert.equal(form.proxy.value, 'socks5://proxy.example:1080');
  assert.equal(form.username.value, 'previous-user');
  assert.equal(form.password.value, 'previous-password');
});

test('failed credential import removes visible URI and keeps existing auth unchanged', () => {
  const form = fields();
  form.proxy.value = 'socks5://dummy-user:dummy-secret%ZZ@proxy.example:1080';
  assert.throws(() => applyProxyInput(form, form.proxy.value), /编码无效/);
  assert.equal(form.proxy.value, '');
  assert.equal(form.username.value, 'previous-user');
  assert.equal(form.password.value, 'previous-password');
});

test('locked or readonly fields are never changed by automatic proxy import', () => {
  for (const [field, attribute] of [['proxy', 'disabled'], ['proxy', 'readOnly'], ['username', 'readOnly'], ['password', 'readOnly'], ['username', 'disabled']]) {
    const form = fields();
    form[field][attribute] = true;
    const before = structuredClone(form);
    assert.deepEqual(applyProxyInput(form, 'socks5://new-user:new-password@proxy.example:1080'), { applied: false, reason: 'locked' });
    assert.deepEqual(form, before);
  }
});
