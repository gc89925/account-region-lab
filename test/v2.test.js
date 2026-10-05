import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createLabServer } from '../server.js';

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'arl-v2-'));
  const active = new Set(), opened = [], native = [];
  const managed = { isActive: id => active.has(id), open: async config => { active.add(config.profile.id); opened.push(config); return {ok:true}; }, close: async id => active.delete(id), closeAll: async () => active.clear() };
  const options = { dataDir, browser: { name: 'Test', path: '/fake/chrome' }, launch: async (_,args) => { native.push(args); return {pid:42}; }, managed,
    probe: async () => ({ ip: '203.0.113.10', country: 'IN' }), catalog: {list:async country=>({country,total:0,nodes:[]})}, ...overrides };
  let lab, base;
  async function start() { lab=createLabServer(options); lab.server.listen(0,'127.0.0.1'); await once(lab.server,'listening'); base=`http://127.0.0.1:${lab.server.address().port}`; }
  await start();
  t.after(async()=>{await lab.close(); await rm(dataDir,{recursive:true,force:true});});
  async function request(route,body,method='POST') {
    const response=await fetch(base+route,body===undefined?{}:{method,headers:{'Content-Type':'application/json','X-Lab-Token':lab.token},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  async function create(extra={}) { const response=await request('/api/profiles',{label:'Test',country:'IN',proxy:'http://127.0.0.1:1080',...extra}); assert.equal(response.status,201,JSON.stringify(response)); return response.data; }
  return {request,create,opened,native,active,dataDir,async restart(mutate){await lab.close(); if(mutate) await mutate(dataDir); await start();}};
}

test('strict IP binding blocks a different IP in the same country and redacts both from export',async t=>{
  let ip='203.0.113.10';
  const app=await fixture(t,{probe:async()=>({ip,country:'IN'})});
  const p=await app.create(); const endpoint=`/api/profiles/${p.id}`;
  assert.equal((await app.request(endpoint+'/launch',{target:'gmail'})).status,200);
  ip='203.0.113.11';
  const blocked=await app.request(endpoint+'/launch',{target:'youtube'});
  assert.equal(blocked.status,400); assert.match(blocked.data.error,/IP/); assert.equal(app.native.length,1);
  const exported=JSON.stringify((await app.request('/api/export')).data);
  assert.ok(!exported.includes('203.0.113.10')); assert.ok(!exported.includes('203.0.113.11'));
});

test('diagnostics use the chosen persistent environment without external probe or starting a cycle',async t=>{
  let probes=0;
  const app=await fixture(t,{probe:async()=>{probes++; throw new Error('must not run');}});
  const p=await app.create({environment:{engine:'managed'}});
  assert.equal((await app.request(`/api/profiles/${p.id}/launch`,{target:'diagnostics'})).status,200);
  assert.equal(probes,0); assert.equal(app.opened.length,1);
  assert.match(app.opened[0].url,/^file:.*diagnostics\.html#/);
  assert.ok(!app.opened[0].url.includes('127.0.0.1')); assert.ok(!app.opened[0].url.includes(p.id));
  const saved=(await app.request('/api/state')).data.profiles.find(x=>x.id===p.id);
  assert.equal(saved.cycleStartedAt,null); assert.equal(saved.expectedIp,null); assert.equal(saved.locked,true); assert.equal(saved.session.active,true);
  assert.equal((await app.request(`/api/profiles/${p.id}`,{environment:{engine:'native'}},'PATCH')).status,400);
  assert.equal((await app.request(`/api/profiles/${p.id}/close`,{})).status,200);
  assert.equal(app.active.size,0);
});

test('same local account code prevents simultaneous managed environments until the first closes',async t=>{
  const app=await fixture(t);
  const first=await app.create({accountLabel:'WorkAccount',environment:{engine:'managed'}});
  const second=await app.create({accountLabel:'workaccount',environment:{engine:'managed'}});
  assert.equal((await app.request(`/api/profiles/${first.id}/launch`,{target:'devices'})).status,200);
  assert.equal((await app.request(`/api/profiles/${second.id}/launch`,{target:'gmail'})).status,400);
  assert.equal(app.opened.length,1);
  assert.equal((await app.request(`/api/profiles/${first.id}`,{accountLabel:'new'},'PATCH')).status,400);
  await app.request(`/api/profiles/${first.id}/close`,{});
  assert.equal((await app.request(`/api/profiles/${second.id}/launch`,{target:'gmail'})).status,200);
});

test('device management opening never manufactures a logout confirmation',async t=>{
  const app=await fixture(t); const p=await app.create();
  const endpoint=`/api/profiles/${p.id}`;
  assert.equal((await app.request(endpoint+'/launch',{target:'devices'})).status,200);
  assert.equal(app.native[0].at(-1),'https://myaccount.google.com/device-activity');
  let saved=(await app.request('/api/state')).data.profiles.find(x=>x.id===p.id);
  assert.deepEqual(saved.deviceReviews,[]);
  assert.equal((await app.request(endpoint+'/device-review',{otherSessionsSignedOut:'yes'})).status,400);
  assert.equal((await app.request(endpoint+'/device-review',{otherSessionsSignedOut:false,currentSessionKept:true,note:'Still reviewing'})).status,200);
  await app.restart();
  saved=(await app.request('/api/state')).data.profiles.find(x=>x.id===p.id);
  assert.equal(saved.deviceReviews[0].source,'user-confirmed'); assert.equal(saved.deviceReviews[0].otherSessionsSignedOut,false);
});

test('catalog validates country and does not accept client-supplied source URLs',async t=>{
  const called=[];
  const app=await fixture(t,{catalog:{list:async country=>{called.push(country);return {total:0,country,nodes:[]};}}});
  const result=await app.request('/api/catalog?country=NG&url=http://127.0.0.1:9');
  assert.equal(result.status,200); assert.deepEqual(called,['NG']); assert.deepEqual(result.data.nodes,[]);
  assert.equal((await app.request('/api/catalog')).data.country,'ALL');
  assert.equal((await app.request('/api/catalog?country=all')).data.country,'ALL');
  assert.equal((await app.request('/api/catalog?country=XX')).status,400);
});

test('v0.1 storage migrates without pretending previous browser flags were applied',async t=>{
  const app=await fixture(t);
  await app.restart(async dataDir=>{
    const path=join(dataDir,'state.json'); const state=JSON.parse(await readFile(path,'utf8'));
    for(const p of state.profiles){delete p.environment;delete p.accountLabel;delete p.strictIp;delete p.expectedIp;delete p.deviceReviews;}
    await writeFile(path,JSON.stringify(state));
  });
  const profiles=(await app.request('/api/state')).data.profiles;
  for(const p of profiles){assert.equal(p.environment.engine,'native');assert.equal(p.strictIp,false);assert.deepEqual(p.deviceReviews,[]);}
});

test('a managed close failure must not be reported as a closed browser',async t=>{
  const app=await fixture(t,{managed:{isActive:()=>true,open:async()=>({ok:true}),close:async()=>({ok:false}),closeAll:async()=>[]}});
  const p=await app.create({environment:{engine:'managed'}});
  const response=await app.request(`/api/profiles/${p.id}/close`,{});
  assert.equal(response.status,400);
  assert.match(response.data.error,/未能关闭/);
});

test('public proxy checking only forwards node identity behind the local write token',async t=>{
  const calls=[];
  const app=await fixture(t,{publicProxies:{list:async country=>({country,nodes:[]}),check:async(id,country)=>{calls.push({id,country});return {ok:false,error:'test failure'};}}});
  assert.equal((await app.request('/api/proxies?country=JP')).data.country,'JP');
  const result=await app.request('/api/proxies/check',{id:'abc',country:'JP',proxy:'http://127.0.0.1:9'});
  assert.equal(result.status,200);assert.deepEqual(calls,[{id:'abc',country:'JP'}]);
});
