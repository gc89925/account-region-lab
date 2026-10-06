import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/protect-secret.ps1', import.meta.url));
const AES_FORMAT = 'aes-256-gcm-v1';
const AES_AAD = Buffer.from(`account-region-lab:proxy-auth:${AES_FORMAT}`);

export function validateProxyAuth(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !username || !password || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255 ||
      /[\x00-\x1f\x7f]/.test(username + password)) {
    throw new Error('SOCKS5 认证需要用户名和密码，各为 1–255 个 UTF-8 字节，不能包含控制字符。');
  }
  return { username, password };
}

function protect(mode, input) {
  if (process.platform !== 'win32') throw new Error('当前版本的认证保存需要 Windows。其他系统请使用本地代理客户端配置认证。');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script, '-Mode', mode],
      { windowsHide: true, timeout: 15000, maxBuffer: 16384 }, (error, stdout) => {
        if (error) return reject(new Error(mode === 'Seal' ? 'Windows 无法加密代理认证，配置未保存。' : '无法解密此代理认证。请在当前 Windows 用户下重新填写用户名和密码。'));
        resolve(stdout.trim());
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function windowsVault() {
  return {
    async seal(auth) {
      validateProxyAuth(auth.username, auth.password);
      const data = await protect('Seal', Buffer.from(JSON.stringify(auth)).toString('base64'));
      if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 8192) throw new Error('Windows 返回了无效的认证密文。');
      return { format: 'windows-dpapi-v1', data };
    },
    async open(envelope) {
      if (envelope?.format !== 'windows-dpapi-v1' || typeof envelope.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(envelope.data) || envelope.data.length > 8192) throw new Error('代理认证数据无效，请重新填写。');
      const raw = await protect('Open', envelope.data);
      let auth;
      try { auth = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { throw new Error('代理认证无法读取，请重新填写。'); }
      return validateProxyAuth(auth.username, auth.password);
    },
  };
}

function decodeField(value, maxBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('代理认证数据无效，请重新填写。');
  const result = Buffer.from(value, 'base64');
  if (!result.length || result.length > maxBytes || result.toString('base64') !== value) throw new Error('代理认证数据无效，请重新填写。');
  return result;
}

function validateKeyFile(stat) {
  // Windows does not implement POSIX permission bits. Linux deployments must
  // keep this regular file private to the account running the service.
  if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' &&
      ((stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())))) {
    throw new Error('Invalid key file');
  }
}

async function readKey(keyPath) {
  const before = await lstat(keyPath);
  if (before.isSymbolicLink()) throw new Error('Symbolic key file');
  validateKeyFile(before);
  let file;
  try {
    file = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await file.stat();
    validateKeyFile(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Key file changed');
    const key = await file.readFile();
    if (key.length !== 32) { key.fill(0); throw new Error('Invalid key length'); }
    return key;
  } finally { await file?.close(); }
}

async function createKey(keyPath) {
  const temporary = `${keyPath}.${randomBytes(12).toString('hex')}.tmp`;
  const key = randomBytes(32);
  let file;
  let created = false;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    await file.writeFile(key);
    await file.sync();
    await file.close();
    file = null;
    // Publishing a complete file with link is exclusive and atomic. A competing
    // service cannot observe an empty/partial key or overwrite the winning key.
    try { await link(temporary, keyPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    key.fill(0);
    await file?.close();
    if (created) await unlink(temporary);
  }
}

function linuxVault(keyPath) {
  async function keyFor(create) {
    try {
      try { return await readKey(keyPath); } catch (error) {
        if (!create || error.code !== 'ENOENT') throw error;
        await createKey(keyPath);
        return await readKey(keyPath);
      }
    } catch {
      throw new Error('代理认证密钥不可用。请检查密钥文件为当前服务用户所有的 0600 普通文件，或恢复原安装的密钥。');
    }
  }
  return {
    async seal(auth) {
      const value = validateProxyAuth(auth?.username, auth?.password);
      const key = await keyFor(true);
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(AES_AAD);
        const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return { format: AES_FORMAT, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      } finally { key.fill(0); }
    },
    async open(envelope) {
      if (envelope?.format !== AES_FORMAT) throw new Error('代理认证数据无效，请重新填写。');
      const iv = decodeField(envelope.iv, 12);
      const tag = decodeField(envelope.tag, 16);
      const data = decodeField(envelope.data, 2048);
      if (iv.length !== 12 || tag.length !== 16) throw new Error('代理认证数据无效，请重新填写。');
      const key = await keyFor(false);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(AES_AAD);
        decipher.setAuthTag(tag);
        const raw = Buffer.concat([decipher.update(data), decipher.final()]);
        try {
          const auth = JSON.parse(raw.toString('utf8'));
          return validateProxyAuth(auth?.username, auth?.password);
        } finally { raw.fill(0); }
      } catch {
        throw new Error('无法解密此代理认证。请恢复原安装的密钥或重新填写用户名和密码。');
      } finally { key.fill(0); }
    },
  };
}

export function createCredentialVault({ platform = process.platform, keyPath } = {}) {
  if (platform === 'linux' && keyPath !== undefined) {
    if (typeof keyPath !== 'string' || !isAbsolute(keyPath)) throw new Error('Linux 认证密钥必须配置为绝对文件路径。');
    return linuxVault(keyPath);
  }
  if (platform !== 'win32') {
    const unavailable = '当前系统尚未配置安全的认证存储。Linux 远程服务需要显式配置认证密钥文件。';
    return {
      async seal(auth) { validateProxyAuth(auth?.username, auth?.password); throw new Error(unavailable); },
      async open() { throw new Error(`代理认证数据无效。${unavailable}`); },
    };
  }
  // Existing Windows installations continue using current-user DPAPI. Linux
  // does not create an encryption key implicitly outside remote server mode.
  return windowsVault();
}
