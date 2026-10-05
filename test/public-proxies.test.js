import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicProxies, createPublicProxyCatalog } from '../lib/public-proxies.js';

const item=(host='8.8.8.8',country='US',extra={})=>({host,port:1080,protocol:'socks5',username:null,password:null,geolocation:{country:{iso_code:country}},...extra});

test('public proxy directory accepts only supported unauthenticated public IPv4 endpoints',()=>{
  const nodes=parsePublicProxies([item(),item(),item('127.0.0.1'),item('192.168.1.1'),item('10.0.0.1'),item('203.0.113.1'),item('8.8.4.4','JP',{password:'secret'}),item('1.1.1.1','KR',{protocol:'socks4'}),item('8.8.4.4','CN'),item('1.1.1.1','JP',{port:'1080'}),item('1.0.0.1','KR',{protocol:'http'})]);
  assert.equal(nodes.length,2);assert.equal(nodes[0].proxy,'socks5://8.8.8.8:1080');
  assert.equal(nodes[0].residentialStatus,'未验证');assert.equal(nodes[0].latencyMs,null);
});

test('only nodes in a fixed directory can be tested and a successful IP check is insufficient',async()=>{
  let googleOk=false, country='US', requests=[];
  const catalog=createPublicProxyCatalog({supplemental:false,fetchImpl:async(url,options)=>{requests.push(url);assert.equal(options.redirect,'error');return new Response(JSON.stringify([item()]));},
    probe:async()=>({ip:'8.8.8.8',country,latencyMs:14}),google:async()=>googleOk});
  const list=await catalog.list('ALL');assert.deepEqual(list.countryCounts,{US:1,JP:0,KR:0});
  const node=list.nodes[0];
  assert.equal((await catalog.check(node.id,'US')).ok,false);
  googleOk=true;country='JP';assert.equal((await catalog.check(node.id,'US')).ok,false);
  country='US';const checked=await catalog.check(node.id,'US');assert.equal(checked.ok,true);assert.equal(checked.googleReachable,true);
  await assert.rejects(catalog.check('http://127.0.0.1:9','US'));
  await assert.rejects(catalog.check('a'.repeat(24),'US'),/最新目录/);
  assert.equal(requests.length,1);assert.equal(requests[0],'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json');
});

test('public directory failures remain errors and failed probes do not become verified',async()=>{
  await assert.rejects(createPublicProxyCatalog({fetchImpl:async()=>new Response('failed',{status:503})}).list('US'),/加载失败/);
  const catalog=createPublicProxyCatalog({supplemental:false,fetchImpl:async()=>new Response(JSON.stringify([item()])),probe:async()=>{throw new Error('connection failed');},google:async()=>{throw new Error('must not run');}});
  const list=await catalog.list('US');const result=await catalog.check(list.nodes[0].id,'US');
  assert.equal(result.ok,false);assert.equal(result.googleReachable,false);assert.equal(result.error,'connection failed');
});

test('malformed supplemental rows do not discard valid public candidates or admit authenticated URLs',async()=>{
  const catalog=createPublicProxyCatalog({fetchImpl:async url=>new Response(JSON.stringify(url.includes('monosans')?[]:[null,{ip:'8.8.8.8',port:1080,protocol:'socks5',geolocation:{country:'JP'}},{ip:'1.1.1.1',port:1080,protocol:'socks5',proxy:'socks5://user:pass@1.1.1.1:1080',geolocation:{country:'JP'}}]))});
  const result=await catalog.list('JP');assert.equal(result.nodes.length,1);assert.equal(result.nodes[0].ip,'8.8.8.8');
});

test('a probe from an expired directory cannot mark the refreshed directory as verified',async()=>{
  let clock=0, country='US', release;
  const wait=new Promise(resolve=>{release=resolve;});
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const catalog=createPublicProxyCatalog({supplemental:false,now:()=>clock,fetchImpl:async()=>new Response(JSON.stringify([item('8.8.8.8',country)])),probe:async()=>{entered();await wait;return {ip:'8.8.8.8',country:'US'};},google:async()=>true});
  const node=(await catalog.list('US')).nodes[0];const checking=catalog.check(node.id,'US');await started;
  clock=120001;country='JP';await catalog.list('JP');release();await checking;
  assert.equal((await catalog.list('JP')).nodes[0].verification,null);
});
