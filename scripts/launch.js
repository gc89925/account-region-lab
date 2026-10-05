import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabServer } from '../server.js';
import { launchSettings, workspaceId, PROJECT_ROOT } from '../lib/workspace.js';

export async function serviceHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const data = await response.json().catch(() => null);
    return response.ok && data?.app === 'account-region-lab' && data?.ready === true ? {status:'ready',...data} : {status:'occupied'};
  } catch (error) {
    return {status:error.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unavailable'};
  }
}
export async function inspectService(port) { return (await serviceHealth(port)).status; }
function verifyPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535.');
}
function existingService(health, port, dataDir) {
  if (health.status === 'ready') {
    if (health.workspaceId !== workspaceId(dataDir)) throw new Error(`Port ${port} belongs to another workspace or an older server. No process was stopped. Close that workspace or choose another PORT.`);
    return {url:`http://127.0.0.1:${port}/`,reused:true,close:async()=>{}};
  }
  if (health.status !== 'stopped') throw new Error(`Port ${port} is occupied or unresponsive. No process was stopped. Try another PORT.`);
  return null;
}
export async function startWorkspace({ port = Number(process.env.PORT || 4317), ...options } = {}) {
  verifyPort(port);
  const dataDir=options.dataDir || launchSettings().dataDir;
  const existing=existingService(await serviceHealth(port),port,dataDir);
  if(existing) return existing;
  const lab = createLabServer({...options,dataDir});
  try {
    await new Promise((yes, no) => {
      lab.server.once('error', no);
      lab.server.listen(port, '127.0.0.1', () => { lab.server.off('error', no); yes(); });
    });
    if (await inspectService(port) !== 'ready') throw new Error('Service started but readiness check failed.');
  } catch (error) { await lab.close().catch(() => {}); throw error; }
  return { url:`http://127.0.0.1:${port}/`, reused:false, close:lab.close };
}
export async function startBackground(settings=launchSettings()) {
  const {port,dataDir}=settings;verifyPort(port);
  const existing=existingService(await serviceHealth(port),port,dataDir);
  if(existing) return existing;
  const logDir=join(dataDir,'logs');mkdirSync(logDir,{recursive:true,mode:0o700});
  const logFile=join(logDir,'service.log');
  const fd=openSync(logFile,'a',0o600);
  let child, spawnError;
  try {
    child=spawn(process.execPath,[join(PROJECT_ROOT,'scripts','service.js')],{
      cwd:PROJECT_ROOT,env:{...process.env,PORT:String(port),REGION_LAB_DATA_DIR:dataDir},
      detached:true,windowsHide:true,stdio:['ignore',fd,fd],shell:false,
    });
    child.once('error',error=>{spawnError=error;});child.unref();
  } finally {closeSync(fd);}
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    if(spawnError || (child.exitCode!==null && child.exitCode!==undefined)) break;
    const health=await serviceHealth(port);
    if(health.status==='ready') {
      existingService(health,port,dataDir);
      return {url:`http://127.0.0.1:${port}/`,reused:false,logFile};
    }
    if(health.status==='occupied') break;
    await delay(200);
  }
  throw new Error(`Background service did not become ready. See log: ${logFile}`);
}
export async function stopBackground(settings=launchSettings()) {
  const {port,dataDir}=settings;verifyPort(port);
  const health=await serviceHealth(port);
  if(health.status==='stopped') return {stopped:true,alreadyStopped:true};
  existingService(health,port,dataDir);
  const url=`http://127.0.0.1:${port}`;
  const response=await fetch(url+'/api/state',{signal:AbortSignal.timeout(2500),redirect:'error'});
  if(!response.ok) throw new Error('Cannot read the running service. No process was stopped.');
  const state=await response.json();
  const stop=await fetch(url+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(5000),redirect:'error',
    headers:{'Content-Type':'application/json','X-Lab-Token':state.token},body:JSON.stringify({instanceId:health.instanceId})});
  if(!stop.ok) throw new Error('Service refused the stop request. No process was killed.');
  for(let attempt=0;attempt<75;attempt++) {
    if(await inspectService(port)==='stopped') return {stopped:true};
    await delay(200);
  }
  throw new Error('Service is still closing. Wait a moment and retry; no process was killed.');
}
function openBrowser(url) {
  const commands = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((yes, no) => {
    const child = spawn(commands[0], commands[1], { stdio: 'ignore', windowsHide: true, detached: true, shell: false });
    child.once('error', no); child.once('spawn', () => { child.unref(); yes(); });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const settings=launchSettings();
    if(process.argv.includes('--stop')) {
      await stopBackground(settings);console.log('Account Region Lab is stopped.');
    } else if(process.argv.includes('--status')) {
      const health=await serviceHealth(settings.port);
      console.log(`Service: ${health.status}. URL: http://127.0.0.1:${settings.port}/`);
      console.log(`Data: ${settings.dataDir}\nLog: ${join(settings.dataDir,'logs','service.log')}`);
    } else {
      const foreground=process.argv.includes('--foreground');
      const workspace=foreground ? await startWorkspace(settings) : await startBackground(settings);
      console.log(`Account Region Lab is ready: ${workspace.url}`);
      console.log(foreground?'Keep this terminal open.':'Running in the background. You can close this window. Use Stop.cmd to stop.');
      if (!process.argv.includes('--no-open')) {
        try { await openBrowser(workspace.url); } catch { console.log(`Open this address in your browser: ${workspace.url}`); }
      }
      if(foreground&&!workspace.reused) for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>workspace.close().finally(()=>process.exit(0)));
    }
  } catch (error) {console.error(`Account Region Lab: ${error.message}`);process.exitCode=1;}
}
