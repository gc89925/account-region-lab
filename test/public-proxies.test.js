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

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function finishScan(catalog) {
  for(let i=0;i<1000&&catalog.scanStatus().running;i++) await tick();
  assert.equal(catalog.scanStatus().running,false,'scan should finish');
  return catalog.scanStatus();
}

test('batch scan checks country and Google with a shared concurrency limit and country rotation',async()=>{
  const rows=['US','JP','KR'].flatMap((country,c)=>Array.from({length:3},(_,i)=>item(`8.8.${c+1}.${i+1}`,country)));
  const hosts=new Map(rows.map(row=>[row.host,row.geolocation.country.iso_code]));
  let active=0,maxActive=0;const releases=[],started=[];
  const catalog=createPublicProxyCatalog({supplemental:false,fetchImpl:async()=>new Response(JSON.stringify(rows)),
    probe:async proxy=>{const ip=new URL(proxy).hostname;active++;maxActive=Math.max(active,maxActive);started.push(ip);await new Promise(resolve=>releases.push(resolve));active--;return {ip,country:hosts.get(ip)};},
    google:async proxy=>new URL(proxy).hostname!=='8.8.2.1'});
  const first=await catalog.startScan('ALL',{limit:6});
  assert.equal(first.total,6);assert.equal(first.active,3);assert.deepEqual(started.map(ip=>hosts.get(ip)),['US','JP','KR']);
  await assert.rejects(catalog.startScan('US'),/正在检测/);
  const unstarted=(await catalog.list('US')).nodes.find(node=>!started.includes(node.ip));
  await assert.rejects(catalog.check(unstarted.id,'US'),/3 个节点/);
  releases.splice(0).forEach(resolve=>resolve());await tick();
  assert.equal(catalog.scanStatus().completed,3);assert.equal(catalog.scanStatus().active,3);
  releases.splice(0).forEach(resolve=>resolve());const done=await finishScan(catalog);
  assert.equal(maxActive,3);assert.equal(done.total,6);assert.equal(done.completed,6);
  assert.equal(done.passed,5);assert.equal(done.failed,1);assert.equal(done.verifiedNodes.length,5);
  assert.ok(done.verifiedNodes.every(node=>node.verification.usable&&node.verification.googleReachable));
});

test('cancelling a scan stops queued probes while keeping in-flight outcomes visible',async()=>{
  const rows=Array.from({length:10},(_,i)=>item(`8.8.1.${i+1}`));const releases=[];let started=0;
  const catalog=createPublicProxyCatalog({supplemental:false,fetchImpl:async()=>new Response(JSON.stringify(rows)),
    probe:async proxy=>{started++;await new Promise(resolve=>releases.push(resolve));return {ip:new URL(proxy).hostname,country:'US'};},google:async()=>true});
  await catalog.startScan('US',{limit:10});const cancelled=catalog.cancelScan();
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.queued,0);assert.equal(cancelled.active,3);
  releases.splice(0).forEach(resolve=>resolve());await tick();
  assert.equal(started,3);assert.equal(catalog.scanStatus().state,'cancelled');assert.equal(catalog.scanStatus().active,0);
  assert.equal(catalog.scanStatus().completed,3);assert.equal(catalog.scanStatus().verifiedNodes.length,3);
});

test('repeat scans advance beyond failed candidates, bound the batch, and explicitly report exhaustion',async()=>{
  const rows=Array.from({length:35},(_,i)=>item(`8.8.1.${i+1}`));const started=[];
  const catalog=createPublicProxyCatalog({supplemental:false,fetchImpl:async()=>new Response(JSON.stringify(rows)),
    probe:async proxy=>{started.push(proxy);throw new Error('unreachable');},google:async()=>true});
  await assert.rejects(catalog.startScan('US',{limit:31}),/1 至 30/);
  assert.equal((await catalog.startScan('US')).total,30);let done=await finishScan(catalog);
  assert.equal(done.remaining,5);assert.equal(done.failed,30);assert.equal(done.verifiedNodes.length,0);
  assert.equal((await catalog.startScan('US')).total,5);done=await finishScan(catalog);
  assert.equal(done.failed,5);assert.equal(new Set(started).size,35);
  done=await catalog.startScan('US');assert.equal(done.state,'completed');assert.equal(done.total,0);assert.equal(done.exhausted,true);
});

test('verified results expire explicitly and cannot remain in the usable-node view',async()=>{
  let clock=0;
  const catalog=createPublicProxyCatalog({supplemental:false,now:()=>clock,fetchImpl:async()=>new Response(JSON.stringify([item()])),
    probe:async()=>({ip:'8.8.8.8',country:'US'}),google:async()=>true});
  await catalog.startScan('US');let done=await finishScan(catalog);
  assert.equal(done.verifiedNodes.length,1);assert.equal(done.results[0].verification.expiresAt,new Date(120000).toISOString());
  clock=120000;done=catalog.scanStatus();
  assert.equal(done.results[0].verification.ok,true);assert.equal(done.results[0].verification.fresh,false);
  assert.equal(done.results[0].verification.usable,false);assert.equal(done.verifiedNodes.length,0);
  const list=await catalog.list('US');assert.equal(list.nodes[0].verification.fresh,false);assert.equal(list.nodes[0].verification.usable,false);
});

test('a scan cancelled while its catalog loads never launches a probe',async()=>{
  let release,started=0;
  const wait=new Promise(resolve=>{release=resolve;});
  const catalog=createPublicProxyCatalog({supplemental:false,fetchImpl:async()=>{await wait;return new Response(JSON.stringify([item()]));},
    probe:async()=>{started++;return {ip:'8.8.8.8',country:'US'};},google:async()=>true});
  const pending=catalog.startScan('US');assert.equal(catalog.scanStatus().state,'loading');
  catalog.cancelScan();release();await pending;
  assert.equal(catalog.scanStatus().state,'cancelled');assert.equal(started,0);
});
