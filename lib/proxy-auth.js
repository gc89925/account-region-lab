import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/protect-secret.ps1', import.meta.url));

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

export function createCredentialVault() {
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
