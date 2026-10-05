import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { validateProxy } from './model.js';
import { probeProxy, probeGoogle } from './runtime.js';

const SOURCE = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json';
const PAGE = 'https://github.com/monosans/proxy-list';
const POPULAR = ['US', 'JP', 'KR'];
const MAX_BYTES = 8 * 1024 * 1024;
const TTL = 120000;
const CHECK_TTL = 120000;
const SCAN_LIMIT = 30;
const MAX_ACTIVE = 3;

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
    const country = item.geolocation?.country?.iso_code;
    if (!POPULAR.includes(country)) continue;
    const proxy = validateProxy(`${item.protocol}://${item.host}:${item.port}`);
    if (seen.has(proxy)) continue;
    seen.add(proxy);
    nodes.push({ id:createHash('sha256').update(proxy).digest('hex').slice(0,24), proxy, ip:item.host, country,
      hostname:item.host, transport:item.protocol.toUpperCase(), protocol:item.protocol,
      asn: typeof item.asn?.autonomous_system_organization === 'string' ? item.asn.autonomous_system_organization.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,100) : '',
      residentialStatus:'未验证', latencyMs:null, sourceUrl:PAGE });
  }
  return nodes;
}

export function createPublicProxyCatalog({ fetchImpl=fetch, probe=probeProxy, google=probeGoogle, now=()=>Date.now(), supplemental=true }={}) {
  let snapshot, pending, active=0, scan=null, sequence=0;
  const checked = new Map(), checking = new Set();
  const cursors = new Map(POPULAR.map(country=>[country,0]));
  const timestamp = ()=>new Date(now()).toISOString();
  function verification(result) {
    if (!result) return null;
    const expires = Date.parse(result.checkedAt)+CHECK_TTL;
    const fresh = now()<expires;
    return {...result,fresh,usable:result.ok&&fresh,expiresAt:new Date(expires).toISOString()};
  }
  function checkedNode(node) { return {...node,verification:verification(checked.get(node.id))}; }
  function validateCountry(country) {
    if (!['ALL',...POPULAR].includes(country)) throw new Error('直接代理目录目前支持美国、日本、韩国。');
  }
  async function readSource(url) {
    const response = await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok) { await response.body?.cancel(); throw new Error(`免费代理来源返回 HTTP ${response.status}。`); }
    const reader=response.body.getReader(), chunks=[]; let bytes=0;
    try {
      while(true) {
        const {done,value}=await reader.read(); if(done) break;
        bytes+=value.length; if(bytes>MAX_BYTES) throw new Error('免费代理目录超过 8 MiB。'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function refresh() {
    const sources=[{url:SOURCE,name:'monosans/proxy-list',page:PAGE}];
    if(supplemental) for(const country of POPULAR) sources.push({url:`https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/${country}/data.json`,name:`Proxifly ${country}`,page:'https://github.com/proxifly/free-proxy-list',country});
    const results=await Promise.allSettled(sources.map(async source=>{
      let data=await readSource(source.url);
      if(source.country) {
        if(!Array.isArray(data)) throw new Error('目录格式错误');
        data=data.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)).map(row=>({host:row.ip,port:row.port,protocol:row.protocol,
          username:row.username || (typeof row.proxy==='string'&&row.proxy.includes('@')?'authenticated':null),password:row.password,
          geolocation:{country:{iso_code:row.geolocation?.country}}}));
      }
      return parsePublicProxies(data).map(node=>({...node,source:source.name,sourceUrl:source.page}));
    }));
    if(results.every(r=>r.status==='rejected')) throw new Error('所有免费目录均无法读取');
    const nodes=[], seen=new Set();
    for(const result of results) if(result.status==='fulfilled') for(const node of result.value) {if(!seen.has(node.id)){seen.add(node.id);nodes.push(node);}}
    return {nodes,at:now(),sources:sources.map((source,i)=>({name:source.name,ok:results[i].status==='fulfilled'}))};
  }
  async function current() {
    if (!snapshot || now()-snapshot.at>=TTL) {
      pending ||= refresh().then(value=>{
        const previousCountries=new Map(snapshot?.nodes.map(node=>[node.id,node.country])||[]);
        const currentCountries=new Map(value.nodes.map(node=>[node.id,node.country]));
        for (const id of checked.keys()) if (previousCountries.get(id)!==currentCountries.get(id)||!currentCountries.has(id)) checked.delete(id);
        snapshot=value;return value;
      }).finally(()=>{pending=null;});
      try { await pending; } catch { throw new Error('免费代理目录加载失败。请检查本机访问 GitHub 的网络后重试；这不是“没有节点”。'); }
    }
    return snapshot;
  }
  async function checkNode(node,data) {
    active++;checking.add(node.id);
    let result;
    try {
      const exit=await probe(node.proxy);
      const googleReachable=await google(node.proxy);
      const ok=exit.country===node.country && googleReachable;
      result={...exit,ok,googleReachable,proxy:node.proxy,checkedAt:timestamp(),
        ...(ok?{}:{error:exit.country!==node.country?`实测出口为 ${exit.country}，与目录国家 ${node.country} 不同。`:'出口检测通过，但 Google 登录入口 HTTPS 请求未通过。'})};
    } catch(error) {result={ok:false,googleReachable:false,proxy:node.proxy,checkedAt:timestamp(),error:error?.message||'代理检测失败。'};}
    finally {active--;checking.delete(node.id);}
    if (snapshot===data) checked.set(node.id,result);
    return result;
  }
  function scanStatus() {
    const job=scan;
    if (!job) return {state:'idle',running:false,country:'ALL',total:0,completed:0,tested:0,active:0,queued:0,passed:0,failed:0,results:[],verifiedNodes:[],exhausted:false,verificationTtlMs:CHECK_TTL};
    const results=job.results.map(node=>({...node,verification:verification(node.verification)}));
    const verifiedNodes=(snapshot?.nodes||[]).filter(node=>job.country==='ALL'||node.country===job.country).map(checkedNode).filter(node=>node.verification?.usable);
    return {id:job.id,state:job.state,running:['loading','running'].includes(job.state),country:job.country,total:job.total,
      completed:results.length,tested:results.length,active:job.active,queued:job.queue.length,
      passed:results.filter(node=>node.verification.ok).length,failed:results.filter(node=>!node.verification.ok).length,
      startedAt:job.startedAt,finishedAt:job.finishedAt,error:job.error,exhausted:job.exhausted,
      remaining:job.remaining,results,verifiedNodes,verificationTtlMs:CHECK_TTL};
  }
  function pumpScan() {
    const job=scan;
    if (!job||job.state!=='running') return;
    while (active<MAX_ACTIVE && job.queue.length) {
      const index=job.queue.findIndex(node=>!checking.has(node.id));
      if (index<0) break;
      const [node]=job.queue.splice(index,1);
      job.active++;
      checkNode(node,job.data).then(result=>{
        job.results.push({...node,verification:result});
      }).catch(error=>{
        // Keep a failed worker visible without leaving an unhandled rejection.
        job.results.push({...node,verification:{ok:false,googleReachable:false,proxy:node.proxy,checkedAt:timestamp(),error:error?.message||'代理检测失败。'}});
      }).finally(()=>{
        job.active--;
        pumpScan();
      });
    }
    if (!job.queue.length && !job.active) {job.state='completed';job.finishedAt=timestamp();}
  }
  function selectCandidates(data,country,limit) {
    const countries=country==='ALL'?POPULAR:[country];
    const groups=countries.map(code=>{
      const all=data.nodes.filter(node=>node.country===code);
      const start=(cursors.get(code)||0)%Math.max(all.length,1);
      const candidates=all.map((_,offset)=>({node:all[(start+offset)%all.length],index:(start+offset)%all.length}))
        .filter(({node})=>!checking.has(node.id)&&!verification(checked.get(node.id))?.fresh);
      return {code,all,candidates};
    });
    const eligible=groups.reduce((sum,group)=>sum+group.candidates.length,0), nodes=[];
    while (nodes.length<limit && groups.some(group=>group.candidates.length)) {
      for (const group of groups) {
        if (!group.candidates.length||nodes.length>=limit) continue;
        const {node,index}=group.candidates.shift();
        nodes.push(node);cursors.set(group.code,(index+1)%group.all.length);
      }
    }
    return {nodes,eligible};
  }
  function cancelScan() {
    if (scan&&['loading','running'].includes(scan.state)) {
      scan.state='cancelled';scan.queue=[];scan.finishedAt=timestamp();
    }
    return scanStatus();
  }
  return {
    async list(country='ALL') {
      validateCountry(country);
      const cached=!!snapshot && now()-snapshot.at<TTL;
      const data=await current(), countryCounts=Object.fromEntries(POPULAR.map(c=>[c,data.nodes.filter(n=>n.country===c).length]));
      const choose=code=>data.nodes.filter(node=>node.country===code).map(checkedNode).sort((a,b)=>Number(!!b.verification?.usable)-Number(!!a.verification?.usable)).slice(0,100);
      const chosen = country==='ALL' ? POPULAR.flatMap(choose) : choose(country);
      return {source:supplemental?'monosans + Proxifly':'monosans/proxy-list',sourceUrl:PAGE,sources:data.sources,country,countryCounts,total:data.nodes.length,matched:country==='ALL'?data.nodes.length:countryCounts[country],cached,
        fetchedAt:new Date(data.at).toISOString(),nodes:chosen,limitPerCountry:100,verificationTtlMs:CHECK_TTL};
    },
    async check(id,country) {
      if (typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id)||!POPULAR.includes(country)) throw new Error('请选择目录中有效的节点。');
      const data=await current(), node=data.nodes.find(n=>n.id===id&&n.country===country);
      if (!node) throw new Error('该节点已不在最新目录，请重新加载。');
      if (checking.has(id)) throw new Error('该节点正在检测，请稍后。');
      if (active>=MAX_ACTIVE) throw new Error('已有 3 个节点在检测，请稍后再试。');
      try {return verification(await checkNode(node,data));} finally {pumpScan();}
    },
    async startScan(country='ALL',{limit=SCAN_LIMIT}={}) {
      validateCountry(country);
      if (!Number.isInteger(limit)||limit<1||limit>SCAN_LIMIT) throw new Error(`每批检测数量必须为 1 至 ${SCAN_LIMIT}。`);
      if (scan&&['loading','running'].includes(scan.state)) throw new Error('已有一批节点正在检测，请等待完成或先停止。');
      const job=scan={id:String(++sequence),state:'loading',country,total:0,active:0,queue:[],results:[],startedAt:timestamp(),finishedAt:null,error:null,exhausted:false,remaining:0};
      try {
        const data=await current();
        if (job.state==='cancelled') return scanStatus();
        const {nodes,eligible}=selectCandidates(data,country,limit);
        Object.assign(job,{data,queue:nodes,total:nodes.length,state:'running',exhausted:eligible===0,remaining:eligible-nodes.length});
        pumpScan();
      } catch(error) {
        if (job.state!=='cancelled') {job.state='failed';job.error=error.message;job.finishedAt=timestamp();}
        throw error;
      }
      return scanStatus();
    },
    scanStatus,
    cancelScan,
  };
}
