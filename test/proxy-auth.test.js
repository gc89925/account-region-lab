import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const LINUX_AUTH = {username:'dummy-linux-测试',password:'dummy-only-server-密碼🔑-@%'};

async function linuxFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'arl-vault-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const keyPath = join(dir, 'proxy-auth.key');
  const vault = createCredentialVault({platform:'linux',keyPath});
  return {dir,keyPath,vault};
}

function sanitized(error) {
  assert.ok(!error.message.includes(LINUX_AUTH.username));
  assert.ok(!error.message.includes(LINUX_AUTH.password));
  assert.ok(!error.message.includes('dummy-only'));
  return true;
}

test('Linux vault requires an explicit absolute key path instead of an implicit credential store',async()=>{
  const vault = createCredentialVault({platform:'linux'});
  await assert.rejects(vault.seal(LINUX_AUTH), /显式配置认证密钥/);
  for (const keyPath of ['', 'relative-key-file', null, 123]) {
    assert.throws(() => createCredentialVault({platform:'linux',keyPath}), /绝对文件路径/);
  }
});

test('Linux AES-GCM ciphertext survives a new vault instance and uses a private random installation key',async t=>{
  const {keyPath,vault} = await linuxFixture(t);
  const first = await vault.seal(LINUX_AUTH);
  const second = await vault.seal(LINUX_AUTH);
  assert.equal(first.format,'aes-256-gcm-v1');
  assert.notEqual(first.iv,second.iv);
  assert.notEqual(first.data,second.data);
  for (const envelope of [first,second]) {
    assert.equal(Buffer.from(envelope.iv,'base64').length,12);
    assert.equal(Buffer.from(envelope.tag,'base64').length,16);
    assert.ok(!JSON.stringify(envelope).includes(LINUX_AUTH.password));
    assert.notEqual(envelope.data,Buffer.from(JSON.stringify(LINUX_AUTH)).toString('base64'));
    assert.deepEqual(await createCredentialVault({platform:'linux',keyPath}).open(envelope),LINUX_AUTH);
  }
  const key = await readFile(keyPath);
  assert.equal(key.length,32);
  assert.ok(!key.equals(Buffer.alloc(32)));
  if(process.platform!=='win32') assert.equal((await lstat(keyPath)).mode & 0o777,0o600);
});

test('concurrent first writes publish one complete key and leave no temporary key files',async t=>{
  const {dir,keyPath} = await linuxFixture(t);
  const envelopes = await Promise.all(Array.from({length:12},()=>createCredentialVault({platform:'linux',keyPath}).seal(LINUX_AUTH)));
  assert.deepEqual(await readdir(dir),['proxy-auth.key']);
  const reopened = createCredentialVault({platform:'linux',keyPath});
  for(const envelope of envelopes) assert.deepEqual(await reopened.open(envelope),LINUX_AUTH);
});

test('Linux vault authenticates ciphertext, nonce and tag and rejects another installation key',async t=>{
  const {dir,keyPath,vault} = await linuxFixture(t);
  const envelope = await vault.seal(LINUX_AUTH);
  for(const field of ['data','iv','tag']) {
    const altered = Buffer.from(envelope[field],'base64');
    altered[0] ^= 1;
    await assert.rejects(vault.open({...envelope,[field]:altered.toString('base64')}),error=>{
      assert.match(error.message,/无法解密/);return sanitized(error);
    });
  }
  const other = createCredentialVault({platform:'linux',keyPath:join(dir,'other-installation.key')});
  await other.seal(LINUX_AUTH);
  await assert.rejects(other.open(envelope),error=>{assert.match(error.message,/无法解密/);return sanitized(error);});
  assert.deepEqual(await createCredentialVault({platform:'linux',keyPath}).open(envelope),LINUX_AUTH);
});

test('Linux vault rejects malformed envelopes before touching the key file',async t=>{
  const {dir,vault} = await linuxFixture(t);
  const validShape = {format:'aes-256-gcm-v1',iv:Buffer.alloc(12).toString('base64'),tag:Buffer.alloc(16).toString('base64'),data:Buffer.alloc(2).toString('base64')};
  for(const envelope of [null,{format:'plaintext',data:LINUX_AUTH.password},
    {...validShape,iv:'bad nonce'}, {...validShape,iv:Buffer.alloc(11).toString('base64')},
    {...validShape,tag:Buffer.alloc(15).toString('base64')}, {...validShape,data:'AAAA\n'},
    {...validShape,data:Buffer.alloc(2049).toString('base64')}, {...validShape,data:'AB=='},
  ]) {
    await assert.rejects(vault.open(envelope),error=>{assert.match(error.message,/认证数据无效/);return sanitized(error);});
  }
  assert.deepEqual(await readdir(dir),[]);
});

test('opening an existing envelope never replaces a missing or corrupt installation key',async t=>{
  const {keyPath,vault} = await linuxFixture(t);
  const envelope = await vault.seal(LINUX_AUTH);
  await unlink(keyPath);
  await assert.rejects(vault.open(envelope),error=>{assert.match(error.message,/密钥不可用/);return sanitized(error);});
  await assert.rejects(lstat(keyPath),{code:'ENOENT'});
  for(const key of [Buffer.alloc(0),Buffer.alloc(31),Buffer.alloc(33)]) {
    await writeFile(keyPath,key,{mode:0o600});
    await assert.rejects(vault.open(envelope),sanitized);
    await assert.rejects(vault.seal(LINUX_AUTH),sanitized);
    assert.deepEqual(await readFile(keyPath),key);
  }
});

test('Linux vault rejects symbolic links and leaves their target unchanged',async t=>{
  const {dir,keyPath,vault} = await linuxFixture(t);
  const target = join(dir,'target.key');
  const key = randomBytes(32);
  await writeFile(target,key,{mode:0o600});
  try { await symlink(target,keyPath,'file'); }
  catch(error) {
    if(process.platform==='win32' && ['EPERM','EACCES'].includes(error.code)) { t.skip('Windows account cannot create file symlinks');return; }
    throw error;
  }
  await assert.rejects(vault.seal(LINUX_AUTH),error=>{assert.match(error.message,/密钥不可用/);return sanitized(error);});
  assert.deepEqual(await readFile(target),key);
  assert.equal((await lstat(keyPath)).isSymbolicLink(),true);
});

test('Linux vault refuses permissive key files without silently changing their permissions', {skip:process.platform==='win32'},async t=>{
  const {keyPath,vault} = await linuxFixture(t);
  const envelope = await vault.seal(LINUX_AUTH);
  for(const mode of [0o644,0o666,0o640,0o700]) {
    await chmod(keyPath,mode);
    await assert.rejects(vault.open(envelope),sanitized);
    await assert.rejects(vault.seal(LINUX_AUTH),sanitized);
    assert.equal((await lstat(keyPath)).mode & 0o777,mode);
  }
  await chmod(keyPath,0o600);
  assert.deepEqual(await vault.open(envelope),LINUX_AUTH);
});

test('Linux vault reports key creation failure without exposing credentials or filesystem paths',async t=>{
  const {dir} = await linuxFixture(t);
  const keyPath = join(dir,'missing-parent','installation.key');
  const vault = createCredentialVault({platform:'linux',keyPath});
  await assert.rejects(vault.seal(LINUX_AUTH),error=>{
    assert.match(error.message,/密钥不可用/);
    assert.ok(!error.message.includes(dir));
    return sanitized(error);
  });
  assert.deepEqual(await readdir(dir),[]);
});
