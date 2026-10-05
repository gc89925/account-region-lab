import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createSocksBridge } from '../lib/socks-bridge.js';

const credentials={username:'测试-user',password:'dummy-密碼🔑-@%'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Independent reader for the fake peer: collect data events rather than using
// the bridge's paused-mode frame reader, so transport bugs cannot hide in both.
function peer(socket) {
  let bytes=Buffer.alloc(0), ended=false;const requests=[];
  function flush() {
    while(requests.length) {
      const request=requests[0];
      if(bytes.length<request.size) {
        if(ended) {requests.shift();request.reject(new Error('peer closed'));continue;}
        break;
      }
      requests.shift();const result=bytes.subarray(0,request.size);bytes=bytes.subarray(request.size);request.resolve(result);
    }
  }
  socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);flush();});
  socket.on('error',()=>{});
  socket.on('close',()=>{ended=true;flush();});
  socket.on('end',()=>{ended=true;flush();});
  return {read:size=>new Promise((resolve,reject)=>{requests.push({size,resolve,reject});flush();})};
}

async function listener(t,handler) {
  const sockets=new Set(),errors=[];
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
    Promise.resolve(handler(socket)).catch(error=>{errors.push(error);socket.destroy();});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;
  const close=async()=>{for(const socket of sockets) socket.destroy();if(server.listening) await new Promise(resolve=>server.close(resolve));};
  t.after(close);
  return {server,port,proxy:`socks5://127.0.0.1:${port}`,sockets,errors,close};
}

async function client(t,proxy) {
  const socket=net.connect({host:'127.0.0.1',port:Number(new URL(proxy).port)});
  const reader=peer(socket);t.after(()=>socket.destroy());await once(socket,'connect');
  return {socket,reader};
}

async function fragmented(socket,bytes) {
  for(const value of bytes) {socket.write(Buffer.from([value]));await tick();}
}

async function upstreamAuthentication(socket,expected=credentials,{fragment=false,reject=false}={}) {
  const reader=peer(socket);
  assert.deepEqual(await reader.read(3),Buffer.from([5,1,2]));
  const send=bytes=>fragment?fragmented(socket,bytes):socket.write(Buffer.from(bytes));
  await send([5,2]);
  const header=await reader.read(2);assert.equal(header[0],1);
  const username=(await reader.read(header[1])).toString('utf8');
  const passwordLength=(await reader.read(1))[0];
  const password=(await reader.read(passwordLength)).toString('utf8');
  assert.deepEqual({username,password},expected);
  await send([1,reject?1:0]);
  return reader;
}

function destination(host,port=443) {
  const name=Buffer.from(host),end=Buffer.alloc(2);end.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5,1,0,3,name.length]),name,end]);
}

test('SOCKS bridge authenticates UTF-8 credentials and preserves fragmented frames and pipelined TLS bytes', {timeout:10000},async t=>{
  const outgoing=Buffer.from([0x16,0x03,0x01,0,8,0,255,128,42,0,2,3,4]);
  const incoming=Buffer.from([0x16,0x03,0x03,0,8,255,0,42,128,4,3,2,1]);
  const request=destination('must-resolve-at-proxy.invalid');
  const upstream=await listener(t,async socket=>{
    const reader=await upstreamAuthentication(socket,credentials,{fragment:true});
    assert.deepEqual(await reader.read(request.length),request,'destination and remote DNS must be preserved');
    const reply=Buffer.from([5,0,0,1,127,0,0,1,0,1]);
    await fragmented(socket,reply.subarray(0,5));
    socket.write(Buffer.concat([reply.subarray(5),incoming]));
    assert.deepEqual(await reader.read(outgoing.length),outgoing,'TLS bytes pipelined after CONNECT cannot be consumed as a frame');
    socket.write(outgoing);
  });
  const bridge=await createSocksBridge(upstream.proxy,credentials);t.after(()=>bridge.close());
  const {socket,reader}=await client(t,bridge.proxy);
  await fragmented(socket,Buffer.from([5,1,0]));assert.deepEqual(await reader.read(2),Buffer.from([5,0]));
  socket.write(Buffer.concat([request,outgoing]));
  assert.deepEqual(await reader.read(10),Buffer.from([5,0,0,1,127,0,0,1,0,1]));
  assert.deepEqual(await reader.read(incoming.length),incoming,'upstream bytes following the CONNECT reply cannot be lost');
  assert.deepEqual(await reader.read(outgoing.length),outgoing);
  assert.equal(bridge.lastError,null);assert.deepEqual(upstream.errors,[]);
});

test('a rejected password returns a sanitized diagnostic and never directly contacts the target', {timeout:10000},async t=>{
  let directConnections=0;
  const target=await listener(t,socket=>{directConnections++;socket.destroy();});
  const wrong={username:'dummy-user',password:'dummy-wrong-password'};
  const upstream=await listener(t,async socket=>{await upstreamAuthentication(socket,wrong,{reject:true});});
  const bridge=await createSocksBridge(upstream.proxy,wrong);t.after(()=>bridge.close());
  const {socket,reader}=await client(t,bridge.proxy);
  socket.write(Buffer.from([5,1,0]));await reader.read(2);
  socket.write(destination('127.0.0.1',target.port));
  const reply=await reader.read(10);assert.equal(reply[0],5);assert.notEqual(reply[1],0);
  assert.equal(bridge.lastError.code,'proxy_auth_rejected');
  assert.ok(!JSON.stringify(bridge.lastError).includes(wrong.password));
  assert.ok(!JSON.stringify(bridge.lastError).includes(wrong.username));
  assert.equal(directConnections,0);assert.deepEqual(upstream.errors,[]);
});

test('an unreachable upstream fails closed even when the requested target is reachable', {timeout:10000},async t=>{
  let directConnections=0;
  const target=await listener(t,socket=>{directConnections++;socket.destroy();});
  const unavailable=await listener(t,()=>{});await unavailable.close();
  const bridge=await createSocksBridge(unavailable.proxy,credentials);t.after(()=>bridge.close());
  const {socket,reader}=await client(t,bridge.proxy);
  socket.write(Buffer.from([5,1,0]));await reader.read(2);
  socket.write(destination('127.0.0.1',target.port));
  const reply=await reader.read(10).catch(()=>null);
  if(reply) assert.notEqual(reply[1],0);
  await tick();assert.equal(bridge.lastError.code,'proxy_connect_failed');assert.equal(directConnections,0);
});

test('handshake timeout closes both sockets and reports timeout instead of exposing credentials', {timeout:10000},async t=>{
  const upstream=await listener(t,socket=>socket.resume());
  const bridge=await createSocksBridge(upstream.proxy,credentials,{handshakeTimeout:100});t.after(()=>bridge.close());
  const {socket,reader}=await client(t,bridge.proxy);
  socket.write(Buffer.from([5,1,0]));await reader.read(2);socket.write(destination('example.invalid'));
  await once(socket,'close');await tick();
  assert.equal(bridge.lastError.code,'proxy_timeout');assert.equal(upstream.sockets.size,0);
  assert.ok(!JSON.stringify(bridge.lastError).includes(credentials.password));
});

test('closing a bridge cleans established tunnels and incomplete handshakes, and is idempotent', {timeout:10000},async t=>{
  const upstream=await listener(t,async socket=>{
    const reader=await upstreamAuthentication(socket);
    const header=await reader.read(5);await reader.read(header[4]+2);
    socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,1]));
  });
  const bridge=await createSocksBridge(upstream.proxy,credentials);t.after(()=>bridge.close());
  const established=await client(t,bridge.proxy);
  established.socket.write(Buffer.from([5,1,0]));await established.reader.read(2);
  established.socket.write(destination('example.invalid'));await established.reader.read(10);
  const incomplete=await client(t,bridge.proxy);
  const establishedClosed=once(established.socket,'close'),incompleteClosed=once(incomplete.socket,'close');
  await Promise.all([bridge.close(),bridge.close(),establishedClosed,incompleteClosed]);await tick();
  assert.equal(upstream.sockets.size,0);
  await assert.rejects(client(t,bridge.proxy),error=>error.code==='ECONNREFUSED');
});
