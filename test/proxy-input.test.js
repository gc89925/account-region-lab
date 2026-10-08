import test from 'node:test';
import assert from 'node:assert/strict';
import { applyParsedProxyInput, applyProxyInput, parseProxyInput, parseProxyInputs } from '../public/proxy-input.js';

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
    'socks5://dummy-user:dummy-secret@proxy.example:1080dummy-user:another@proxy.example:1080',
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

test('residential raw export fills all fields without altering literal password characters', () => {
  const parsed = parseProxyInput('geo.iproyal.com:12321:demo-user:demo%40+pass_country-id_session-DemoAb12_lifetime-168h_streaming-1');
  assert.equal(parsed.proxy, 'socks5://geo.iproyal.com:12321');
  assert.equal(parsed.proxyUsername, 'demo-user');
  assert.equal(parsed.proxyPassword, 'demo%40+pass_country-id_session-DemoAb12_lifetime-168h_streaming-1');
  assert.equal(parsed.country, 'ID');
  assert.equal(parsed.sessionHint, 'De…12');
  assert.equal(parsed.protocolAssumed, true);
  const form = fields();
  applyParsedProxyInput(form, parsed);
  assert.equal(form.username.value, 'demo-user');
  assert.equal(form.password.value, parsed.proxyPassword);
  assert.equal(form.proxy.value, parsed.proxy);
});

test('raw formats use an explicit protocol for unknown hosts and never silently change ports', () => {
  for (const input of ['proxy.example:12321:demo-user:demo-password', 'geo.iproyal.com:32325:demo-user:demo-password']) {
    assert.throws(() => parseProxyInput(input), /先选择.*SOCKS5.*HTTP/);
    const parsed = parseProxyInput(input, { protocol: 'socks5' });
    assert.equal(parsed.proxy, `socks5://${input.split(':').slice(0, 2).join(':')}`);
    assert.equal(parsed.protocolAssumed, undefined);
  }
  assert.deepEqual(parseProxyInput('proxy.example:8080', { protocol: 'http' }), { proxy: 'http://proxy.example:8080', hasCredentials: false });
  assert.deepEqual(parseProxyInput('[2001:db8::3]:1080:user:pass:with:colon', { protocol: 'socks5' }), {
    proxy: 'socks5://[2001:db8::3]:1080', hasCredentials: true, proxyUsername: 'user', proxyPassword: 'pass:with:colon'
  });
  assert.equal(parseProxyInput('proxy.example:1080:user:https://notes.example/a?b#c+%20:tail', { protocol: 'socks5' }).proxyPassword, 'https://notes.example/a?b#c+%20:tail');
  assert.throws(() => parseProxyInput('geo.iproyal.com:12321:demo-user:demo-password', { protocol: 'http' }), /仅支持 SOCKS5/);
  assert.equal(parseProxyInput('http://proxy.example:8080', { protocol: 'socks5' }).proxy, 'http://proxy.example:8080');
});

test('pasted consecutive residential sessions split only at recognized repeated gateway boundaries', () => {
  const prefix = 'geo.iproyal.com:12321:demo-user:';
  const rows = ['FirstA11', 'Second22', 'ThirdC33'].map(session => `${prefix}demo-password_country-id_session-${session}_lifetime-168h_streaming-1`);
  const parsed = parseProxyInputs(rows.join(''));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map(item => item.proxyPassword), rows.map(row => row.slice(prefix.length)));
  assert.deepEqual(parsed.map(item => item.country), ['ID', 'ID', 'ID']);
  assert.deepEqual(parsed.map(item => item.sessionHint), ['Fi…11', 'Se…22', 'Th…33']);
  assert.ok(parsed.every(item => !item.proxy.includes('demo-user') && !item.proxy.includes('demo-password')));
  assert.throws(() => parseProxyInput(rows.join('')), /多条代理/);
  assert.equal(parseProxyInputs(rows[0] + rows[1].replace('geo.iproyal.com', 'GEO.IPROYAL.COM')).length, 2);
});

test('newline imports handle different gateways and protocols and preserve single-entry compatibility', () => {
  const input = '\r\nsocks5://demo:one@proxy.example:1080\r\n\nhttp://other.example:8080\ngeo.iproyal.com:12321:demo:two_country-in_session-X_lifetime-1h_streaming-0\r';
  const parsed = parseProxyInputs(input);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].hasCredentials, false);
  assert.equal(parsed[2].country, 'IN');
  assert.equal(parsed[2].sessionHint, '••••');
  assert.deepEqual(parseProxyInputs(' \r\n '), []);
  assert.deepEqual(parseProxyInput(' \r\n '), { proxy: '', hasCredentials: false });
  assert.deepEqual(parseProxyInputs('socks5://demo:one@proxy.example:1080'), [parseProxyInput('socks5://demo:one@proxy.example:1080')]);
});

test('ambiguous concatenation fails without storing another row inside the password or echoing credentials', () => {
  for (const input of [
    'geo.iproyal.com:12321:demo-user:demo-secretgeo.iproyal.com:12321:demo-user:another-secret',
    'proxy.example:1080:demo-user:demo-secretproxy.example:1080:demo-user:another-secret',
    'proxy.example:1080:demo-user:demo-secretother.example:1080:demo-user:another-secret',
    'proxy.example:1080:demo-user:demo%pass://other.example:1080:other-user:other-secret',
    'socks5://demo-user:demo-secret@proxy.example:1080socks5://demo-user:another-secret@proxy.example:1080',
    'geo.iproyal.com:12321:demo-user:demo-secret_country-id_session-FirstA11_lifetime-168h_streaming-1geo.iproyal.com:12321:demo-user:broken-secret'
  ]) {
    assert.throws(() => parseProxyInputs(input, { protocol: 'socks5' }), error => {
      assert.match(error.message, /分隔位置不明确/);
      assert.ok(!error.message.includes('demo-user'));
      assert.ok(!error.message.includes('demo-secret'));
      return true;
    });
    const form = fields();
    form.proxy.value = input;
    assert.throws(() => applyProxyInput(form, input, { protocol: 'socks5' }));
    assert.equal(form.proxy.value, '');
    assert.equal(form.password.value, 'previous-password');
  }
});

test('batch import is bounded and rejects a malformed row as a whole', () => {
  const line = 'socks5://demo:pass@proxy.example:1080';
  assert.equal(parseProxyInputs(Array(100).fill(line).join('\n')).length, 100);
  assert.throws(() => parseProxyInputs(Array(101).fill(line).join('\n')), /最多导入 100/);
  assert.throws(() => parseProxyInputs(`${line}\ninvalid-secret-row`), /格式无效/);
  assert.throws(() => parseProxyInputs('x'.repeat(65537)), /格式无效/);
  assert.throws(() => parseProxyInputs(line, { protocol: 'https' }), /格式无效/);
});

test('parsed imports reject invalid protocol edits before changing fields', () => {
  const parsed = parseProxyInput('geo.iproyal.com:12321:demo-user:demo-password');
  for (const proxy of ['http://geo.iproyal.com:12321', 'socks4://geo.iproyal.com:12321', 'invalid-demo-secret']) {
    const form = fields();
    const before = structuredClone(form);
    assert.throws(() => applyParsedProxyInput(form, { ...parsed, proxy }), error => !error.message.includes('demo-secret'));
    assert.deepEqual(form, before);
  }
  const locked = fields();
  locked.proxy.readOnly = true;
  assert.deepEqual(applyParsedProxyInput(locked, parsed), { applied: false, reason: 'locked' });
});
