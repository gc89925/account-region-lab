import test from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialVault, validateProxyAuth } from '../lib/proxy-auth.js';

test('SOCKS credentials use UTF-8 byte limits and validation errors never echo submitted values',()=>{
  assert.deepEqual(validateProxyAuth('dummy-user','dummy-密碼🔑'),{username:'dummy-user',password:'dummy-密碼🔑'});
  assert.equal(Buffer.byteLength(validateProxyAuth('界'.repeat(85),'p').username),255);
  for(const [username,password] of [['界'.repeat(86),'dummy-secret'],['dummy-user','界'.repeat(86)],['','dummy-secret'],['dummy-user',''],['dummy\nuser','dummy-secret'],['dummy-user','dummy-secret\0']]) {
    assert.throws(()=>validateProxyAuth(username,password),error=>{
      assert.match(error.message,/1–255/);assert.ok(!error.message.includes('dummy-secret'));return true;
    });
  }
});

test('credential vault rejects malformed envelopes without printing their contents',async()=>{
  const vault=createCredentialVault();
  for(const envelope of [null,{format:'plaintext',data:'dummy-secret'},{format:'windows-dpapi-v1',data:'dummy-secret!'},{format:'windows-dpapi-v1',data:'A'.repeat(8193)}]) {
    await assert.rejects(vault.open(envelope),error=>{
      assert.match(error.message,/认证数据无效/);assert.ok(!error.message.includes('dummy-secret'));return true;
    });
  }
});

test('Windows DPAPI seals and reopens dummy UTF-8 credentials and hides invalid ciphertext errors', {skip:process.platform!=='win32',timeout:45000},async()=>{
  const vault=createCredentialVault(),auth={username:'dummy-测试',password:'dummy-only-密碼🔑-@%'};
  const envelope=await vault.seal(auth);
  assert.equal(envelope.format,'windows-dpapi-v1');assert.match(envelope.data,/^[A-Za-z0-9+/=]+$/);
  assert.ok(!JSON.stringify(envelope).includes(auth.password));
  assert.notEqual(envelope.data,Buffer.from(JSON.stringify(auth)).toString('base64'));
  assert.deepEqual(await vault.open(envelope),auth);
  const corrupt=Buffer.from('dummy-only-invalid-ciphertext').toString('base64');
  await assert.rejects(vault.open({format:'windows-dpapi-v1',data:corrupt}),error=>{
    assert.match(error.message,/无法解密/);assert.ok(!error.message.includes(corrupt));assert.ok(!error.message.includes('dummy-only'));return true;
  });
});
