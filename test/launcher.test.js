import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startWorkspace, inspectService, serviceHealth, stopBackground } from '../scripts/launch.js';
import { PROJECT_ROOT, workspaceId } from '../lib/workspace.js';

async function freePort() {
  const server = http.createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}

test('launcher only reuses a ready service with the same data directory',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'arl-launch-')); const port=await freePort();
  const started=await startWorkspace({port,dataDir});
  t.after(async()=>{await started.close();await rm(dataDir,{recursive:true,force:true});});
  assert.equal(started.reused,false); assert.equal(await inspectService(port),'ready');
  const health=await (await fetch(started.url+'api/health')).json();
  assert.deepEqual(Object.keys(health).sort(),['app','instanceId','ready','version','workspaceId']);
  assert.equal(health.workspaceId,workspaceId(dataDir));
  await assert.rejects(startWorkspace({port,dataDir:join(dataDir,'not-created')}),/another workspace/);
  await assert.rejects(stopBackground({port,dataDir:join(dataDir,'not-created')}),/another workspace/);
  const second=await startWorkspace({port,dataDir});
  assert.equal(second.reused,true); await second.close(); assert.equal(await inspectService(port),'ready');
});

test('background launcher exits, preserves its service, reuses it, and stops by authenticated request',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'arl 后台 launch '));const port=await freePort();
  t.after(async()=>{await stopBackground({port,dataDir});await rm(dataDir,{recursive:true,force:true});});
  const run=()=>promisify(execFile)(process.execPath,[join(PROJECT_ROOT,'scripts','launch.js'),'--no-open'],{
    cwd:PROJECT_ROOT,env:{...process.env,PORT:String(port),REGION_LAB_DATA_DIR:dataDir},timeout:20000,windowsHide:true});
  const first=await run();assert.match(first.stdout,/background/);
  const health=await serviceHealth(port);assert.equal(health.status,'ready');
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
  await run();assert.equal((await serviceHealth(port)).instanceId,health.instanceId);
  const url=`http://127.0.0.1:${port}`;
  const bad=await fetch(url+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId:health.instanceId})});
  assert.equal(bad.status,403);
  assert.equal((await stopBackground({port,dataDir})).stopped,true);
  assert.equal(await inspectService(port),'stopped');
  await run();assert.notEqual((await serviceHealth(port)).instanceId,health.instanceId);
  assert.equal((await (await fetch(url+'/api/state')).json()).profiles.length,2);
});

test('launcher refuses another service on the selected port without stopping it',async t=>{
  const server=http.createServer((req,res)=>res.end('unrelated service'));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const port=server.address().port;
  assert.equal(await inspectService(port),'occupied');
  await assert.rejects(startWorkspace({port}),/occupied/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'unrelated service');
});
