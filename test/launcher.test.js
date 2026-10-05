import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspace, inspectService } from '../scripts/launch.js';

async function freePort() {
  const server = http.createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}

test('launcher starts ready service and duplicate launch reuses it without opening a second data directory',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'arl-launch-')); const port=await freePort();
  const started=await startWorkspace({port,dataDir});
  t.after(async()=>{await started.close();await rm(dataDir,{recursive:true,force:true});});
  assert.equal(started.reused,false); assert.equal(await inspectService(port),'ready');
  const health=await (await fetch(started.url+'api/health')).json();
  assert.deepEqual(Object.keys(health).sort(),['app','ready','version']);
  const second=await startWorkspace({port,dataDir:join(dataDir,'not-created')});
  assert.equal(second.reused,true); await second.close(); assert.equal(await inspectService(port),'ready');
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
