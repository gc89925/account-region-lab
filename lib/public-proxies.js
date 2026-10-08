import { createHash } from 'node:crypto';
import { connect as connectSocket, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setMaxListeners } from 'node:events';
import { countryCode, validateProxy } from './model.js';
import { probeProxy, probeGoogle } from './runtime.js';

const SOURCE = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json';
const PAGE = 'https://github.com/monosans/proxy-list';
const PROXIFLY = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.csv';
const MAX_BYTES = 8 * 1024 * 1024;
const TTL = 120000;
const CHECK_TTL = 120000;
const DEFAULT_SCAN_LIMIT = 60;
const SCAN_LIMIT = 200;
const CONNECT_CONCURRENCY = 12;
const VERIFY_CONCURRENCY = 4;
const SCAN_TIMEOUT_MS = 90000;
const NODE_TIMEOUT_MS = 14000;
const execFileAsync = promisify(execFile);

function publicIp(ip) {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100&&b>=64&&b<=127) ||
    (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168 || (b===0&&(c===0||c===2)) || (b===88&&c===99))) ||
    (a===198&&(b===18||b===19||(b===51&&c===100))) || (a===203&&b===0&&c===113));
}

export function parsePublicProxies(data) {
  if (!Array.isArray(data) || data.length > 100000) throw new Error('免费代理目录格式无效。');
  const nodes = [], seen = new Set();
  for (const item of data) {
    if (!item || !['http','socks5'].includes(item.protocol) || item.username || item.password || !publicIp(item.host)) continue;
    if (!Number.isInteger(item.port) || item.port < 1 || item.port > 65535) continue;
    let country;
    try { country = countryCode(item.geolocation?.country?.iso_code); } catch { continue; }
    const proxy = validateProxy(`${item.protocol}://${item.host}:${item.port}`);
    if (seen.has(proxy)) continue;
    seen.add(proxy);
    nodes.push({ id:createHash('sha256').update(proxy).digest('hex').slice(0,24), proxy, ip:item.host, country,
      hostname:item.host, transport:item.protocol.toUpperCase(), protocol:item.protocol,
      asn: typeof item.asn?.autonomous_system_organization === 'string' ? item.asn.autonomous_system_organization.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,100) : '',
      sourceLatencyMs:typeof item.timeout==='number' && Number.isFinite(item.timeout) && item.timeout>=0 ? Math.round(item.timeout*1000) : null,
      residentialStatus:'未验证', latencyMs:null, sourceUrl:PAGE });
  }
  return nodes;
}

// The global CSV carries the same endpoints/countries as Proxifly's JSON, at a
// fraction of its size. Only the two fixed columns are used; city text is ignored.
export function parseProxiflyCsv(text) {
  if (typeof text!=='string' || Buffer.byteLength(text)>MAX_BYTES) throw new Error('免费代理目录超过 8 MiB 或格式无效。');
  const rows=[];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match=/^((?:http|socks5):\/\/[^,\s]+),([A-Za-z]{2})(?:,|$)/.exec(line);
    if (!match) continue;
    let url;
    try { url=new URL(match[1]); } catch { continue; }
    if (url.username || url.password || url.pathname && url.pathname!=='/' || url.search || url.hash) continue;
    rows.push({host:url.hostname,port:Number(url.port || (url.protocol==='http:' ? 80 : 0)),protocol:url.protocol.slice(0,-1),
      geolocation:{country:{iso_code:match[2]}}});
    if (rows.length>100000) throw new Error('免费代理目录的节点数过多。');
  }
  if (!rows.length && text.trim()) throw new Error('免费代理 CSV 未包含有效节点。');
  return parsePublicProxies(rows);
}

function abortError(message='已停止本批检测。') {
  const error=new Error(message);error.name='AbortError';return error;
}

function abortable(work, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason || abortError());
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal?.throwIfAborted();return work();}).then(
      value=>{signal?.removeEventListener('abort',abort);resolve(value);},
      error=>{signal?.removeEventListener('abort',abort);reject(error);}
    );
  });
}

export function probePublicTcp(proxy,{signal,timeoutMs=2200,socketFactory=connectSocket}={}) {
  const url=new URL(proxy);
  if (!publicIp(url.hostname) || !['http:','socks5:'].includes(url.protocol) || url.username || url.password) {
    return Promise.reject(new Error('只允许检测目录中的公开代理端点。'));
  }
  return new Promise((resolve,reject)=>{
    let socket,timer,settled=false;
    const finish=error=>{
      if(settled) return;settled=true;
      clearTimeout(timer);signal?.removeEventListener('abort',abort);socket?.destroy();
      if(error) reject(error);else resolve(true);
    };
    const abort=()=>finish(signal.reason || abortError());
    if(signal?.aborted) return abort();
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>finish(new Error('代理端口快速连接超时。')),timeoutMs);timer.unref?.();
    try {
      socket=socketFactory({host:url.hostname,port:Number(url.port || 80)});
      socket.once('connect',()=>finish());
      socket.once('error',()=>finish(new Error('代理端口当前无法连接。')));
    } catch { finish(new Error('代理端口当前无法连接。')); }
  });
}

function publicProbeOptions(signal) {
  return {signal,runCurl:(file,args,options)=>{
    const bounded=[...args], overall=bounded.indexOf('--max-time'), connection=bounded.indexOf('--connect-timeout');
    if(overall>=0) bounded[overall+1]=String(Math.min(Number(bounded[overall+1]),8));
    if(connection>=0) bounded[connection+1]='3';
    return execFileAsync(file,bounded,{...options,signal,timeout:8500});
  }};
}

export function createPublicProxyCatalog({
  fetchImpl=fetch, probe=probeProxy, google=probeGoogle, connect=probePublicTcp, now=()=>Date.now(), supplemental=true,
  scanTimeoutMs=SCAN_TIMEOUT_MS,
}={}) {
  let snapshot, pending, active=0, connecting=0, scan=null, sequence=0, refreshError=null, lastAttempt=-Infinity, countryCursor=0;
  const checked=new Map(), checking=new Set(), cursors=new Map();
  const timestamp=()=>new Date(now()).toISOString();
  const policy={defaultScanLimit:DEFAULT_SCAN_LIMIT,maxScanLimit:SCAN_LIMIT,verificationTtlMs:CHECK_TTL,
    concurrency:{connect:CONNECT_CONCURRENCY,verify:VERIFY_CONCURRENCY},scanTimeoutMs};
  function verification(result) {
    if(!result) return null;
    const expires=Date.parse(result.checkedAt)+CHECK_TTL, fresh=!result.cancelled && now()<expires;
    return {...result,fresh,usable:result.ok&&fresh,expiresAt:new Date(expires).toISOString()};
  }
  function checkedNode(node) {return {...node,verification:verification(checked.get(node.id))};}
  function validateCountry(country) {return country==='ALL'?'ALL':countryCode(country);}
  async function readSource(url) {
    const signal=AbortSignal.timeout(10000);
    return abortable(async()=>{
      const response=await fetchImpl(url,{redirect:'error',signal});
      if(!response.ok) {await response.body?.cancel();throw new Error(`免费代理来源返回 HTTP ${response.status}。`);}
      if(!response.body?.getReader) throw new Error('免费代理来源没有响应流。');
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      const cancel=()=>{reader.cancel().catch(()=>{});};
      signal.addEventListener('abort',cancel,{once:true});
      try {
        while(true) {
          signal.throwIfAborted();
          const {done,value}=await reader.read();signal.throwIfAborted();if(done) break;
          bytes+=value.length;if(bytes>MAX_BYTES) throw new Error('免费代理目录超过 8 MiB。');chunks.push(value);
        }
        return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      } finally {signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
    },signal);
  }
  function refresh() {
    lastAttempt=now();refreshError=null;
    const sources=[{url:SOURCE,name:'monosans/proxy-list',page:PAGE,parse:text=>parsePublicProxies(JSON.parse(text))}];
    if(supplemental) sources.push({url:PROXIFLY,name:'Proxifly global',page:'https://github.com/proxifly/free-proxy-list',parse:parseProxiflyCsv});
    const loaded=new Map(),status=sources.map(source=>({name:source.name,ok:false,loading:true}));
    let resolveReady,rejectReady,readyDone=false;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    function publish() {
      const nodes=[],seen=new Set();
      for(const source of sources) for(const node of loaded.get(source.name)||[]) if(!seen.has(node.id)) {seen.add(node.id);nodes.push(node);}
      const byId=new Map(nodes.map(node=>[node.id,node]));
      for(const [id,result] of checked) {
        if(byId.has(id) && result.directoryCountry!==byId.get(id).country) checked.delete(id);
        else if(!byId.has(id) && status.every(s=>!s.loading)) checked.delete(id);
      }
      nodes.sort((a,b)=>(a.sourceLatencyMs ?? Infinity)-(b.sourceLatencyMs ?? Infinity));
      snapshot={nodes,byId,at:now(),sources:status.map(s=>({...s}))};
      if(nodes.length && !readyDone) {readyDone=true;resolveReady(snapshot);}
    }
    const full=Promise.allSettled(sources.map(async(source,i)=>{
      try {
        const nodes=source.parse(await readSource(source.url)).map(node=>({...node,source:source.name,sourceUrl:source.page}));
        loaded.set(source.name,nodes);status[i]={name:source.name,ok:true,loading:false};publish();
      } catch {
        status[i]={name:source.name,ok:false,loading:false};
        if(loaded.size) publish();
      }
    })).then(()=>{
      if(!loaded.size) {
        refreshError='免费代理目录加载失败，请检查服务器访问 GitHub 的网络后重试。';
        if(!readyDone) {readyDone=true;rejectReady(new Error(refreshError));}
      } else {
        publish();
        if(!readyDone) {readyDone=true;resolveReady(snapshot);}
      }
    }).finally(()=>{lastAttempt=now();pending=null;});
    pending={ready,full};
    ready.catch(()=>{});
    return pending;
  }
  async function current() {
    if(!snapshot) return await (pending || refresh()).ready;
    if(now()-snapshot.at>=TTL && !pending && now()-lastAttempt>=10000) refresh();
    return snapshot;
  }
  function remember(node,result) {
    if(!result.cancelled && snapshot?.byId.get(node.id)?.country===node.country) checked.set(node.id,{...result,directoryCountry:node.country});
  }
  async function verifyNode(node,{signal}={}) {
    const timeout=AbortSignal.timeout(NODE_TIMEOUT_MS), combined=signal?AbortSignal.any([signal,timeout]):timeout;
    let stage='country';
    try {
      const exit=await abortable(()=>probe(node.proxy,publicProbeOptions(combined)),combined);
      if(exit.country!==node.country) return {...exit,ok:false,googleReachable:false,stage,proxy:node.proxy,checkedAt:timestamp(),
        error:`实测出口为 ${exit.country}，与目录国家 ${node.country} 不同。`};
      stage='google';
      const googleReachable=await abortable(()=>google(node.proxy,publicProbeOptions(combined)),combined);
      return {...exit,ok:!!googleReachable,googleReachable:!!googleReachable,stage:googleReachable?'verified':stage,
        proxy:node.proxy,checkedAt:timestamp(),...(googleReachable?{}:{error:'出口检测通过，但 Google 登录入口 HTTPS 请求未通过。'})};
    } catch(error) {
      const cancelled=!!signal?.aborted;
      return {ok:false,googleReachable:false,proxy:node.proxy,stage,cancelled,checkedAt:timestamp(),
        error:cancelled?'检测已停止，未判定此节点是否可用。':timeout.aborted?'单节点检测超时，可稍后单独重试。':error?.message||'代理检测失败。'};
    }
  }
  function scanStatus() {
    const job=scan;
    if(!job) return {state:'idle',running:false,country:'ALL',total:0,completed:0,tested:0,active:0,queued:0,passed:0,failed:0,cancelled:0,
      connecting:0,verifying:0,reachable:0,stages:{connect:0,verify:0},results:[],verifiedNodes:[],exhausted:false,...policy};
    const results=job.results.map(node=>({...node,verification:verification(node.verification)}));
    const verifiedNodes=[];
    for(const [id,result] of checked) {
      const value=verification(result),node=snapshot?.byId.get(id);
      if(value?.usable&&node&&(job.country==='ALL'||node.country===job.country)) verifiedNodes.push({...node,verification:value});
    }
    return {id:job.id,state:job.state,running:['loading','running'].includes(job.state),country:job.country,total:job.total,
      completed:results.length,tested:results.filter(node=>!node.verification.cancelled).length,active:job.connecting+job.verifying,queued:job.queue.length+job.verifyQueue.length,
      connecting:job.connecting,verifying:job.verifying,reachable:job.reachable,stages:{connect:job.connecting,verify:job.verifying},
      passed:results.filter(node=>node.verification.ok).length,failed:results.filter(node=>!node.verification.ok&&!node.verification.cancelled).length,
      cancelled:results.filter(node=>node.verification.cancelled).length,
      startedAt:job.startedAt,finishedAt:job.finishedAt,error:job.error,exhausted:job.exhausted,remaining:job.remaining,
      results,verifiedNodes,...policy};
  }
  function record(job,node,result) {remember(node,result);job.results.push({...node,verification:result});}
  function pumpScan() {
    const job=scan;
    if(!job || job.state!=='running') return;
    while(active<VERIFY_CONCURRENCY && job.verifyQueue.length) {
      const node=job.verifyQueue.shift();active++;job.verifying++;
      verifyNode(node,{signal:job.controller.signal}).then(result=>record(job,node,result)).finally(()=>{
        active--;job.verifying--;checking.delete(node.id);pumpScan();
      });
    }
    while(connecting<CONNECT_CONCURRENCY && job.queue.length && job.verifyQueue.length<CONNECT_CONCURRENCY*2) {
      const index=job.queue.findIndex(node=>!checking.has(node.id));if(index<0) break;
      const [node]=job.queue.splice(index,1);checking.add(node.id);connecting++;job.connecting++;
      abortable(()=>connect(node.proxy,{signal:job.controller.signal}),job.controller.signal).then(()=>{
        if(job.controller.signal.aborted) throw job.controller.signal.reason;
        job.reachable++;job.verifyQueue.push(node);
      }).catch(error=>{
        record(job,node,{ok:false,googleReachable:false,proxy:node.proxy,stage:'connect',checkedAt:timestamp(),
          cancelled:job.controller.signal.aborted,error:job.controller.signal.aborted?'检测已停止，未判定此节点是否可用。':error?.message||'代理端口当前无法连接。'});
        checking.delete(node.id);
      }).finally(()=>{connecting--;job.connecting--;pumpScan();});
    }
    if(!job.queue.length&&!job.verifyQueue.length&&!job.connecting&&!job.verifying) {
      job.state='completed';job.finishedAt=timestamp();clearTimeout(job.timer);
    }
  }
  function selectCandidates(data,country,limit) {
    const groups=new Map();
    for(const node of data.nodes) {
      if(country!=='ALL'&&node.country!==country) continue;
      if(!groups.has(node.country)) groups.set(node.country,[]);
      groups.get(node.country).push(node);
    }
    const ordered=[...groups];
    if(country==='ALL' && ordered.length) {const offset=countryCursor%ordered.length;ordered.push(...ordered.splice(0,offset));}
    const candidates=ordered.map(([code,all])=>{
      const start=(cursors.get(code)||0)%all.length;
      return {code,all,queue:all.map((_,offset)=>({node:all[(start+offset)%all.length],index:(start+offset)%all.length}))
        .filter(({node})=>!checking.has(node.id)&&!verification(checked.get(node.id))?.fresh)};
    });
    const eligible=candidates.reduce((sum,group)=>sum+group.queue.length,0),nodes=[];
    let lastGroup=-1;
    while(nodes.length<limit&&candidates.some(group=>group.queue.length)) for(const [groupIndex,group] of candidates.entries()) {
      if(!group.queue.length||nodes.length>=limit) continue;
      const {node,index}=group.queue.shift();nodes.push(node);cursors.set(group.code,(index+1)%group.all.length);lastGroup=groupIndex;
    }
    if(country==='ALL' && candidates.length && lastGroup>=0) countryCursor=(countryCursor+lastGroup+1)%candidates.length;
    return {nodes,eligible};
  }
  function stopScan(state='cancelled') {
    if(scan&&['loading','running'].includes(scan.state)) {
      const job=scan;job.state=state;job.finishedAt=timestamp();clearTimeout(job.timer);
      if(state==='timed_out') job.error=`本批检测已达到 ${Math.round(scanTimeoutMs/1000)} 秒，已停止剩余请求；可以继续检测下一批。`;
      for(const node of job.verifyQueue) checking.delete(node.id);
      job.queue=[];job.verifyQueue=[];job.controller.abort(abortError());
    }
    return scanStatus();
  }
  return {
    async list(country='ALL') {
      country=validateCountry(country);
      const cached=!!snapshot,data=await current(),countryCounts={};
      for(const node of data.nodes) countryCounts[node.country]=(countryCounts[node.country]||0)+1;
      const countries=Object.entries(countryCounts).map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code));
      const nodes=[],groups=new Map(),all=data.nodes.filter(node=>country==='ALL'||node.country===country);
      const usable=node=>{const result=checked.get(node.id);return !!result?.ok&&now()-Date.parse(result.checkedAt)<CHECK_TTL;};
      all.sort((a,b)=>Number(usable(b))-Number(usable(a))||(a.sourceLatencyMs??Infinity)-(b.sourceLatencyMs??Infinity));
      for(const node of all) {
        if(!groups.has(node.country)) groups.set(node.country,[]);
        if(groups.get(node.country).length<100) groups.get(node.country).push(node);
      }
      // Small first pages cover many countries instead of filling with one large country.
      for(let index=0;nodes.length<300;index++) {
        let added=false;
        for(const group of groups.values()) if(group[index]&&nodes.length<300) {nodes.push(checkedNode(group[index]));added=true;}
        if(!added) break;
      }
      return {source:supplemental?'monosans + Proxifly':'monosans/proxy-list',sourceUrl:PAGE,sources:data.sources,
        country,countryCounts,countries,total:data.nodes.length,matched:country==='ALL'?data.nodes.length:countryCounts[country]||0,cached,
        stale:now()-data.at>=TTL,refreshing:!!pending,refreshError,
        fetchedAt:new Date(data.at).toISOString(),nodes,limit:300,limitPerCountry:100,...policy};
    },
    async check(id,country) {
      if(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id)) throw new Error('请选择目录中有效的节点。');
      try {country=countryCode(country);} catch {throw new Error('请选择目录中有效的节点。');}
      const data=await current(),node=data.byId.get(id);
      if(!node||node.country!==country) throw new Error('该节点已不在最新目录，请重新加载。');
      if(checking.has(id)) throw new Error('该节点正在检测，请稍后。');
      if(active>=VERIFY_CONCURRENCY) throw new Error(`已有 ${VERIFY_CONCURRENCY} 个节点在深度检测，请稍后再试。`);
      active++;checking.add(id);
      try {const result=await verifyNode(node);remember(node,result);return verification(result);}
      finally {active--;checking.delete(id);pumpScan();}
    },
    async startScan(country='ALL',{limit=DEFAULT_SCAN_LIMIT}={}) {
      country=validateCountry(country);
      if(!Number.isInteger(limit)||limit<1||limit>SCAN_LIMIT) throw new Error(`每批检测数量必须为 1 至 ${SCAN_LIMIT}。`);
      if(scan&&['loading','running'].includes(scan.state)) throw new Error('已有一批节点正在检测，请等待完成或先停止。');
      const job=scan={id:String(++sequence),state:'loading',country,total:0,connecting:0,verifying:0,reachable:0,
        queue:[],verifyQueue:[],results:[],startedAt:timestamp(),finishedAt:null,error:null,exhausted:false,remaining:0,controller:new AbortController()};
      setMaxListeners(64,job.controller.signal);
      job.timer=setTimeout(()=>{if(scan===job) stopScan('timed_out');},scanTimeoutMs);job.timer.unref?.();
      try {
        const data=await abortable(()=>current(),job.controller.signal);
        if(job.state!=='loading') return scanStatus();
        const {nodes,eligible}=selectCandidates(data,country,limit);
        Object.assign(job,{queue:nodes,total:nodes.length,state:'running',exhausted:eligible===0,remaining:eligible-nodes.length});
        pumpScan();
      } catch(error) {
        if(!job.controller.signal.aborted) {job.state='failed';job.error=error.message;job.finishedAt=timestamp();clearTimeout(job.timer);throw error;}
      }
      return scanStatus();
    },
    scanStatus,
    cancelScan:()=>stopScan(),
  };
}
