import net from 'node:net';
import { once } from 'node:events';
import { validateProxy } from './model.js';
import { validateProxyAuth } from './proxy-auth.js';

function failure(code, message, stage = 'authentication') {
  const error = new Error(message);
  error.diagnostic = { code, stage, message, retryable: false };
  return error;
}

// Read exact frame lengths so split TCP packets and pipelined TLS bytes survive.
export function readBytes(socket, size) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('readable', read); socket.off('error', fail); socket.off('close', closed); socket.off('end', closed); };
    const fail = error => { cleanup(); reject(error); };
    const closed = () => fail(failure('proxy_closed', '代理在握手完成前关闭了连接。', 'connection'));
    const read = () => {
      const value = socket.read(size);
      if (value !== null) { cleanup(); resolve(value); }
      else if (socket.destroyed || socket.readableEnded) closed();
    };
    socket.on('readable', read); socket.once('error', fail); socket.once('close', closed); socket.once('end', closed);
    read();
  });
}

async function addressBytes(socket, type) {
  if (type === 1) return readBytes(socket, 6);
  if (type === 4) return readBytes(socket, 18);
  if (type === 3) {
    const length = await readBytes(socket, 1);
    if (!length[0]) throw failure('proxy_protocol', 'SOCKS5 地址格式无效。', 'protocol');
    return Buffer.concat([length, await readBytes(socket, length[0] + 2)]);
  }
  throw failure('proxy_protocol', 'SOCKS5 地址类型不受支持。', 'protocol');
}

export async function createSocksBridge(proxy, auth, { handshakeTimeout = 10000, port = 0 } = {}) {
  const endpoint = new URL(validateProxy(proxy));
  if (endpoint.protocol !== 'socks5:') throw new Error('当前认证转发支持 SOCKS5；HTTP 认证请先使用本地代理客户端。');
  validateProxyAuth(auth.username, auth.password);
  const username = Buffer.from(auth.username), password = Buffer.from(auth.password);
  const sockets = new Set();
  let lastError = null;
  const server = net.createServer(client => {
    if (sockets.size >= 256) { client.destroy(); return; }
    sockets.add(client);
    client.on('error', () => {});
    let upstream, established = false;
    const deadline = setTimeout(() => {
      const error = failure('proxy_timeout', '代理连接或认证超时。', 'connection');
      client.destroy(error); upstream?.destroy(error);
    }, handshakeTimeout);
    deadline.unref();
    client.once('close', () => { clearTimeout(deadline); sockets.delete(client); upstream?.destroy(); });
    (async () => {
      try {
        const hello = await readBytes(client, 2);
        if (hello[0] !== 5 || !hello[1]) throw failure('proxy_protocol', '本地转发仅接受 SOCKS5。', 'protocol');
        const methods = await readBytes(client, hello[1]);
        if (!methods.includes(0)) { client.end(Buffer.from([5, 255])); return; }
        client.write(Buffer.from([5, 0]));
        const request = await readBytes(client, 4);
        if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) {
          client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return;
        }
        const destination = await addressBytes(client, request[3]);
        // Only the configured proxy is contacted; target DNS is left to it.
        upstream = net.connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port) });
        sockets.add(upstream);
        upstream.on('error', () => {});
        upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
        await once(upstream, 'connect');
        upstream.write(Buffer.from([5, 1, 2]));
        const selection = await readBytes(upstream, 2);
        if (selection[0] !== 5) throw failure('proxy_protocol', '该端口没有返回 SOCKS5 协议响应，请核对协议和端口。', 'protocol');
        if (selection[1] !== 2) throw failure('proxy_auth_method', '该 SOCKS5 服务不接受用户名密码认证，请核对服务商的认证方式。');
        upstream.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
        const accepted = await readBytes(upstream, 2);
        if (accepted[0] !== 1 || accepted[1] !== 0) throw failure('proxy_auth_rejected', '代理拒绝了用户名或密码，请核对认证信息及服务商的 IP 白名单。');
        upstream.write(Buffer.concat([request, destination]));
        const reply = await readBytes(upstream, 4);
        if (reply[0] !== 5 || reply[2] !== 0) throw failure('proxy_protocol', '代理返回了无效 SOCKS5 连接响应。', 'protocol');
        const bound = await addressBytes(upstream, reply[3]);
        if (client.destroyed) return;
        client.write(Buffer.concat([reply, bound]));
        if (reply[1] !== 0) { client.end(); upstream.destroy(); return; }
        clearTimeout(deadline); established = true; lastError = null;
        client.setTimeout(600000, () => client.destroy());
        upstream.setTimeout(600000, () => upstream.destroy());
        client.pipe(upstream); upstream.pipe(client);
      } catch (error) {
        if (!established) {
          lastError = error.diagnostic || { code: 'proxy_connect_failed', stage: 'connection', message: '无法连接配置的代理，或代理提前关闭了连接。', retryable: true };
          if (!client.destroyed) client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
        upstream?.destroy();
      } finally { if (!established) clearTimeout(deadline); }
    })();
  });
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('本地认证转发端口无效。');
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  let closing;
  return {
    proxy: `socks5://127.0.0.1:${server.address().port}`,
    get lastError() { return lastError; },
    close() {
      return closing ||= new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => { username.fill(0); password.fill(0); resolve(); });
      });
    },
  };
}
