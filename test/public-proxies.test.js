import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parsePublicProxies, parseProxiflyCsv, probePublicTcp, createPublicProxyCatalog } from '../lib/public-proxies.js';

const item=(host='8.8.8.8',country='US',extra={})=>({host,port:1080,protocol:'socks5',username:null,password:null,geolocation:{country:{iso_code:country}},...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fixture=(rows=[item()],options={})=>createPublicProxyCatalog({supplemental:false,connect:async()=>true,
  fetchImpl:async()=>new Response(JSON.stringify(rows)),probe:async proxy=>({ip:new URL(proxy).hostname,country:'US'}),google:async()=>true,...options});
async function settle(catalog) {
  for(let i=0;i<1000&&(catalog.scanStatus().running||catalog.scanStatus().active);i++) await tick();
  const result=catalog.scanStatus();assert.equal(result.running,false,'scan should finish');assert.equal(result.active,0);return result;
}
async function loaded(catalog,country='ALL') {
  let list=await catalog.list(country);
  for(let i=0;i<1000&&list.refreshing;i++) {await tick();list=await catalog.list(country);}
  assert.equal(list.refreshing,false);return list;
}

test('global public directory accepts real ISO countries and excludes private, reserved, credentialed and unsupported endpoints',()=>{
  const nodes=parsePublicProxies([item(),item(),item('127.0.0.1'),item('192.168.1.1'),item('10.0.0.1'),item('203.0.113.1'),
    item('8.8.4.4','JP',{password:'secret'}),item('1.1.1.1','KR',{protocol:'socks4'}),item('8.8.4.4','CN'),item('1.1.1.1','JP',{port:'1080'}),
    item('1.0.0.1','KR',{protocol:'http'}),item('9.9.9.9','NG'),item('4.2.2.1','IN'),item('4.2.2.2','ZZ')]);
  assert.deepEqual(nodes.map(node=>node.country),['US','CN','KR','NG','IN']);
  assert.ok(nodes.every(node=>node.residentialStatus==='未验证'&&node.latencyMs===null));
});

test('global compact CSV reads all countries without admitting authenticated URLs, private networks or forged fields',()=>{
  const nodes=parseProxiflyCsv(['socks5://8.8.8.8:1080,ID,Jakarta','http://1.1.1.1:80,DE,City,Extra',
    'socks5://user:password@9.9.9.9:1080,US,City','socks5://127.0.0.1:1080,US,City',
    'socks5://8.8.4.4:1080?x=1,US,City','https://4.2.2.1:443,US,City','garbage'].join('\n'));
  assert.deepEqual(nodes.map(node=>node.country),['ID','DE']);
  assert.equal(nodes[1].proxy,'http://1.1.1.1:80');
  assert.throws(()=>parseProxiflyCsv('<html>broken upstream</html>'),/未包含有效/);
});

test('dynamic countries, source latency metadata and a bounded globally balanced first page',async()=>{
  const countries=['US','JP','KR','NG','IN','DE','BR'];
  const rows=countries.flatMap((country,c)=>Array.from({length:150},(_,i)=>item(`8.${c+1}.1.${i+1}`,country,{timeout:i/10})));
  const catalog=fixture(rows);
  const list=await loaded(catalog);
  assert.equal(list.total,1050);assert.equal(list.nodes.length,300);assert.equal(list.countries.length,7);
  assert.equal(list.countryCounts.NG,150);assert.equal(new Set(list.nodes.map(node=>node.country)).size,7);
  assert.equal(list.defaultScanLimit,60);assert.equal(list.maxScanLimit,200);assert.deepEqual(list.concurrency,{connect:12,verify:4});
  assert.equal((await catalog.list('ng')).nodes.length,100);assert.equal((await catalog.list('ZA')).matched,0);
  await assert.rejects(catalog.list('ZZ'));
});

test('first source is usable before a slow second source finishes; global supplemental data merges and deduplicates',async()=>{
  const slow=deferred(),requests=[];
  const catalog=createPublicProxyCatalog({fetchImpl:async url=>{
    requests.push(url);
    if(url.includes('monosans')) return new Response(JSON.stringify([item()]));
    await slow.promise;
    return new Response('socks5://8.8.8.8:1080,US,Duplicate\nsocks5://1.1.1.1:1080,NG,Lagos');
  }});
  const first=await catalog.list();assert.equal(first.nodes.length,1);assert.equal(first.refreshing,true);
  assert.equal(first.nodes[0].verification,null);
  slow.resolve();const final=await loaded(catalog);
  assert.equal(final.total,2);assert.deepEqual(final.countryCounts,{US:1,NG:1});
  assert.equal(requests.length,2);assert.ok(requests.some(url=>url.endsWith('/proxies/all/data.csv')));
});

test('expired cache returns immediately during refresh and failed refresh retains the last known directory',async()=>{
  let clock=0,calls=0;const refresh=deferred();
  const catalog=fixture([item()],{now:()=>clock,fetchImpl:async()=>{
    calls++;if(calls===1) return new Response(JSON.stringify([item()]));await refresh.promise;return new Response('failure',{status:503});
  }});
  await loaded(catalog);clock=120001;
  const stale=await catalog.list();assert.equal(stale.stale,true);assert.equal(stale.refreshing,true);assert.equal(stale.nodes.length,1);
  refresh.resolve();await tick();const failed=await loaded(catalog);
  assert.equal(failed.nodes.length,1);assert.match(failed.refreshError,/加载失败/);assert.equal(failed.stale,true);
  assert.equal(calls,2);
});

test('total source failure is an error instead of an empty directory',async()=>{
  await assert.rejects(createPublicProxyCatalog({fetchImpl:async()=>new Response('failed',{status:503})}).list('US'),/加载失败/);
});

test('country and Google must both pass, and only directory identities can be checked',async()=>{
  let googleOk=false,country='US',googleCalls=0;
  const catalog=fixture([item()],{probe:async()=>({ip:'8.8.8.8',country,latencyMs:14}),google:async()=>{googleCalls++;return googleOk;}});
  const node=(await loaded(catalog)).nodes[0];
  assert.equal((await catalog.check(node.id,'US')).ok,false);
  googleOk=true;country='JP';assert.equal((await catalog.check(node.id,'US')).ok,false);assert.equal(googleCalls,1);
  country='US';const checked=await catalog.check(node.id,'US');assert.equal(checked.ok,true);assert.equal(checked.googleReachable,true);
  await assert.rejects(catalog.check('http://127.0.0.1:9','US'));
  await assert.rejects(catalog.check('a'.repeat(24),'US'),/最新目录/);
});

test('a failed IP probe never becomes verified and never reaches the Google stage',async()=>{
  const catalog=fixture([item()],{probe:async()=>{throw new Error('connection failed');},google:async()=>assert.fail('must not run')});
  const list=await loaded(catalog),result=await catalog.check(list.nodes[0].id,'US');
  assert.equal(result.ok,false);assert.equal(result.googleReachable,false);assert.equal(result.error,'connection failed');
});

test('old-country in-flight result cannot verify a refreshed changed-country node',async()=>{
  let clock=0,country='US';const wait=deferred(),entered=deferred();
  const catalog=fixture([],{now:()=>clock,fetchImpl:async()=>new Response(JSON.stringify([item('8.8.8.8',country)])),
    probe:async()=>{entered.resolve();await wait.promise;return {ip:'8.8.8.8',country:'US'};}});
  const node=(await loaded(catalog)).nodes[0],checking=catalog.check(node.id,'US');await entered.promise;
  clock=120001;country='JP';await loaded(catalog,'JP');wait.resolve();await checking;
  assert.equal((await catalog.list('JP')).nodes[0].verification,null);
});

test('12 TCP workers feed 4 strict workers and publish successes before slow candidates finish',async()=>{
  const rows=Array.from({length:24},(_,i)=>item(`8.8.1.${i+1}`));
  const connects=[],probes=[];let tcpActive=0,tcpMax=0,verifyActive=0,verifyMax=0,googleCalls=0;
  const catalog=fixture(rows,{
    connect:async()=>{tcpActive++;tcpMax=Math.max(tcpMax,tcpActive);const wait=deferred();connects.push(wait);await wait.promise;tcpActive--;},
    probe:async proxy=>{verifyActive++;verifyMax=Math.max(verifyMax,verifyActive);const wait=deferred();probes.push(wait);await wait.promise;verifyActive--;return {ip:new URL(proxy).hostname,country:'US'};},
    google:async()=>{googleCalls++;return true;}
  });
  await catalog.startScan('US',{limit:24});await tick();assert.equal(connects.length,12);
  connects.splice(0,1)[0].resolve();await tick();
  assert.equal(probes.length,1);assert.equal(catalog.scanStatus().verifiedNodes.length,0,'TCP success is not usable');
  probes.splice(0,1)[0].resolve();await tick();assert.equal(catalog.scanStatus().passed,1);assert.equal(catalog.scanStatus().running,true);
  for(let i=0;i<30&&catalog.scanStatus().running;i++) {
    connects.splice(0).forEach(wait=>wait.resolve());probes.splice(0).forEach(wait=>wait.resolve());await tick();
  }
  const done=await settle(catalog);
  assert.equal(tcpMax,12);assert.equal(verifyMax,4);assert.equal(googleCalls,24);assert.equal(done.passed,24);
  assert.ok(done.verifiedNodes.every(node=>node.verification.usable&&node.verification.googleReachable));
});

test('shared deep-validation bound applies to manual checks and no Google work is done for a failed TCP stage',async()=>{
  const rows=Array.from({length:10},(_,i)=>item(`8.8.2.${i+1}`)),holds=[];
  const catalog=fixture(rows,{connect:async proxy=>{if(new URL(proxy).hostname==='8.8.2.1') throw new Error('dead TCP');},
    probe:async proxy=>{const hold=deferred();holds.push(hold);await hold.promise;return {ip:new URL(proxy).hostname,country:'US'};}});
  await catalog.startScan('US',{limit:6});await tick();
  assert.equal(catalog.scanStatus().verifying,4);assert.equal(catalog.scanStatus().failed,1);
  const manual=(await catalog.list('US')).nodes.find(node=>node.ip==='8.8.2.10');
  await assert.rejects(catalog.check(manual.id,'US'),/4 个节点/);
  for(let i=0;i<4;i++) {holds.splice(0).forEach(hold=>hold.resolve());await tick();}
  assert.equal((await settle(catalog)).passed,5);
});

test('cancel aborts in-flight connections, clears queued candidates and never caches cancellation as failure',async()=>{
  const rows=Array.from({length:20},(_,i)=>item(`8.8.3.${i+1}`));let started=0,aborted=0,probes=0;
  const catalog=fixture(rows,{connect:async(_proxy,{signal})=>{started++;return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true});
  });},probe:async()=>{probes++;}});
  await catalog.startScan('US',{limit:20});await tick();const cancelled=catalog.cancelScan();
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.queued,0);
  const done=await settle(catalog);
  assert.equal(started,12);assert.equal(aborted,12);assert.equal(probes,0);assert.equal(done.failed,0);assert.equal(done.cancelled,12);
  assert.ok((await catalog.list('US')).nodes.every(node=>node.verification===null));
});

test('cancel aborts in-flight deep validation and a new scan is not contaminated by the old results',async()=>{
  const rows=Array.from({length:8},(_,i)=>item(`8.8.4.${i+1}`));let hang=true,aborted=0;
  const catalog=fixture(rows,{probe:async(proxy,{signal})=>{
    if(hang) await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}));
    return {ip:new URL(proxy).hostname,country:'US'};
  }});
  await catalog.startScan('US',{limit:8});await tick();assert.equal(catalog.scanStatus().verifying,4);
  catalog.cancelScan();await settle(catalog);assert.equal(aborted,4);hang=false;
  await catalog.startScan('US',{limit:8});const done=await settle(catalog);assert.equal(done.passed,8);assert.equal(done.cancelled,0);
});

test('default batches contain 60, max 200; repeats advance and cached failures avoid repeated work',async()=>{
  const rows=Array.from({length:65},(_,i)=>item(`8.9.1.${i+1}`)),started=[];
  const catalog=fixture(rows,{connect:async proxy=>{started.push(proxy);throw new Error('unreachable');}});
  await assert.rejects(catalog.startScan('US',{limit:201}),/1 至 200/);
  assert.equal((await catalog.startScan('US')).total,60);let done=await settle(catalog);
  assert.equal(done.remaining,5);assert.equal(done.failed,60);assert.equal(done.verifiedNodes.length,0);
  assert.equal((await catalog.startScan('US')).total,5);await settle(catalog);assert.equal(new Set(started).size,65);
  done=await catalog.startScan('US');assert.equal(done.state,'completed');assert.equal(done.exhausted,true);
});

test('all-country repeated scans rotate across countries instead of starving countries after the batch boundary',async()=>{
  const rows=['US','JP','KR','NG','IN','DE','BR'].map((country,i)=>item(`8.9.2.${i+1}`,country)),countries=[];
  const catalog=fixture(rows,{connect:async proxy=>{countries.push(rows.find(row=>row.host===new URL(proxy).hostname).geolocation.country.iso_code);throw new Error('dead');}});
  for(let i=0;i<4;i++) {await catalog.startScan('ALL',{limit:2});await settle(catalog);}
  assert.equal(new Set(countries).size,7);
});

test('verified results expire explicitly and leave the usable view',async()=>{
  let clock=0;const catalog=fixture([item()],{now:()=>clock});
  await catalog.startScan();let done=await settle(catalog);assert.equal(done.verifiedNodes.length,1);
  clock=120000;done=catalog.scanStatus();assert.equal(done.results[0].verification.ok,true);
  assert.equal(done.results[0].verification.fresh,false);assert.equal(done.results[0].verification.usable,false);assert.equal(done.verifiedNodes.length,0);
});

test('a scan can be cancelled while loading without waiting for the upstream or launching a probe',async()=>{
  const wait=deferred();let started=0;
  const catalog=fixture([],{fetchImpl:async()=>{await wait.promise;return new Response(JSON.stringify([item()]));},connect:async()=>{started++;}});
  const pending=catalog.startScan();await tick();catalog.cancelScan();await pending;
  assert.equal(catalog.scanStatus().state,'cancelled');assert.equal(started,0);
  wait.resolve();await loaded(catalog);
});

test('whole-batch deadline aborts in-flight work and leaves an explicit retryable stop state',async()=>{
  let aborted=0;
  const catalog=fixture([item()],{scanTimeoutMs:20,connect:async(_proxy,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true});
  })});
  await catalog.startScan();await pause(35);const done=await settle(catalog);
  assert.equal(done.state,'timed_out');assert.match(done.error,/停止剩余请求/);assert.equal(aborted,1);assert.equal(done.failed,0);
});

test('TCP quick probe destroys sockets on success, timeout and cancellation, and rejects private endpoint injection',async()=>{
  const sockets=[],endpoints=[];
  const factory=endpoint=>{endpoints.push(endpoint);const socket=new EventEmitter();socket.destroy=()=>{socket.destroyed=true;};sockets.push(socket);return socket;};
  const passed=probePublicTcp('socks5://8.8.8.8:1080',{socketFactory:factory});sockets[0].emit('connect');assert.equal(await passed,true);assert.equal(sockets[0].destroyed,true);
  const controller=new AbortController(),cancelled=probePublicTcp('http://1.1.1.1',{socketFactory:factory,signal:controller.signal});
  assert.deepEqual(endpoints[1],{host:'1.1.1.1',port:80});
  controller.abort();await assert.rejects(cancelled);assert.equal(sockets[1].destroyed,true);
  const timed=probePublicTcp('socks5://8.8.4.4:1080',{socketFactory:factory,timeoutMs:5});
  const rejected=assert.rejects(timed,/超时/);await pause(10);await rejected;assert.equal(sockets[2].destroyed,true);
  await assert.rejects(probePublicTcp('http://127.0.0.1:80',{socketFactory:factory}),/公开代理/);
});
