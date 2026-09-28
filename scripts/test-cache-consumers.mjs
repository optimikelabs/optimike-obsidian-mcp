import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, after} from 'node:test';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'optimike-cache-consumers-'));
process.env.OBSIDIAN_RUNTIME_MODE='headless-readonly';process.env.OBSIDIAN_VAULT=root;
process.env.MCP_LOG_DIR=path.join(root,'logs');
const {config}=await import('../dist/config/index.js');
const {VaultCacheService}=await import('../dist/services/obsidianRestAPI/vaultCache/service.js');
const {LocalBasesService}=await import('../dist/services/localBasesService.js');
const {warmSharedTaskCache,processListAllTasks}=await import('../dist/mcp-server/tools/tasksShared/logic.js');
const context={requestId:'cache-consumer-fixture',timestamp:new Date().toISOString(),operation:'test'};
config.obsidianVaultPath=root;config.obsidianCacheSource='rest';
after(()=>fs.rmSync(root,{recursive:true,force:true}));
async function fixture(body){
 config.obsidianSharedCacheDbPath=path.join(root,crypto.randomUUID()+'.sqlite');
 let fail=false,files={'One.md':'- [ ] task-one'};
 const rest={listFiles:async()=>Object.keys(files),getFileMetadata:async()=>({ctime:1,mtime:2,size:14}),
  getFileContent:async p=>{if(fail)throw new Error('offline');return {path:p,content:files[p.replace(/^\//,'')],stat:{ctime:1,mtime:2,size:14}};}};
 let cache=new VaultCacheService(rest);
 try{await cache.refreshCache(true);await body({get cache(){return cache;},fail:()=>{fail=true;},
  restart:async()=>{await cache.close();cache=new VaultCacheService(rest);},set:v=>{files=v;}});}
 finally{await cache.close();}
}

for(const kind of ['tasks','bases','tasks-without-service'])test(kind+' refuses durable incomplete cache after failed reconciliation',()=>fixture(async f=>{
 f.cache.markEventWorkPending();await f.restart();f.fail();
 const invoke=()=>kind==='bases'?new LocalBasesService(f.cache).listBases():warmSharedTaskCache(kind==='tasks-without-service'?undefined:f.cache);
 await assert.rejects(invoke,e=>e.code==='SERVICE_UNAVAILABLE');
}));
test('task projection drops disappeared source even when another file replaces its count',()=>fixture(async f=>{
 await warmSharedTaskCache(f.cache);f.set({'Two.md':'- [ ] task-two'});await f.cache.refreshCache(true);
 const result=JSON.parse(await processListAllTasks({responseFormat:'json'},context,f.cache));
 assert.equal(result.length,1);assert.equal(result[0].description,'task-two');
}));
test('task memory cache keys include content hash when timestamps and size are unchanged',()=>fixture(async f=>{
 const first=JSON.parse(await processListAllTasks({responseFormat:'json'},context,f.cache));
 assert.equal(first[0].description,'task-one');f.set({'One.md':'- [ ] task-two'});await f.cache.refreshCache(true);
 const second=JSON.parse(await processListAllTasks({responseFormat:'json'},context,f.cache));
 assert.equal(second[0].description,'task-two');
}));


test('task queries wait for an active periodic scan instead of failing on the building marker',()=>fixture(async f=>{
 let release;const barrier=new Promise(resolve=>{release=resolve;});
 const original=f.cache.listAllMarkdownFiles.bind(f.cache);
 f.cache.listAllMarkdownFiles=async(...args)=>{await barrier;return original(...args);};
 const scan=f.cache.refreshCache();await new Promise(resolve=>setTimeout(resolve,10));
 let settled=false;const query=warmSharedTaskCache(f.cache).finally(()=>{settled=true;});query.catch(()=>undefined);
 try { await new Promise(resolve=>setTimeout(resolve,30));assert.equal(settled,false); }
 finally {release();}
 await scan;await query;
}));

for (const partial of [false,true]) test((partial?'partial':'unsupported')+' event endpoints leave periodic cache and direct task queries usable',()=>fixture(async f=>{
 const {CacheEventSupervisor}=await import('../dist/services/obsidianRestAPI/vaultCache/eventSupervisor.js');
 const {LocalRestEventError}=await import('../dist/services/obsidianRestAPI/eventStreams.js');
 const source={consumeVaultEvents:async(event,signal,connected)=>{
  if (!partial || event === 'rename') throw new LocalRestEventError('unsupported');
  connected(); await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 }};
 const supervisor=new CacheEventSupervisor(source,{
  accepts:()=>true,update:async()=>({ok:true}),
  reconcile:async()=>{await f.cache.refreshCache(true);return f.cache.isReady();},
  uncertain:()=>f.cache.markFreshnessUncertain(),pending:()=>f.cache.markEventWorkPending(),settled:()=>f.cache.settleEventWork(),
 },{retryMinMs:10,retryMaxMs:20,debounceMs:2,reconcileIntervalMs:10});
 try {supervisor.start();await new Promise(resolve=>setTimeout(resolve,100));await warmSharedTaskCache(f.cache);
   assert.equal(supervisor.snapshot().state,partial?'degraded':'unsupported');assert.equal(f.cache.getStats().freshness,'observed');}
 finally {await supervisor.stop();}
}));


test('unsupported events never rescan or downgrade a healthy periodic cache at startup',()=>fixture(async f=>{
 const {CacheEventSupervisor}=await import('../dist/services/obsidianRestAPI/vaultCache/eventSupervisor.js');
 const {LocalRestEventError}=await import('../dist/services/obsidianRestAPI/eventStreams.js');
 f.fail(); let reconciliations=0;
 const supervisor=new CacheEventSupervisor({consumeVaultEvents:async()=>{throw new LocalRestEventError('unsupported');}}, {
  accepts:()=>true,update:async()=>({ok:true}),
  reconcile:async()=>{reconciliations++;await f.cache.refreshCache(true);return f.cache.isReady();},
  uncertain:()=>f.cache.markFreshnessUncertain(),pending:()=>f.cache.markEventWorkPending(),settled:()=>f.cache.settleEventWork(),
 },{retryMinMs:10,retryMaxMs:20,debounceMs:2,reconcileIntervalMs:10});
 try {supervisor.start();await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(reconciliations,0); assert.equal(f.cache.getStats().freshness,'observed'); await warmSharedTaskCache(f.cache);}
 finally {await supervisor.stop();}
}));


test('prior uncertainty forces content reproof even during an ordinary metadata scan',()=>fixture(async f=>{
 f.set({'One.md':'- [ ] task-two'});f.cache.markFreshnessUncertain();
 await f.cache.refreshCache();assert.equal((await f.cache.getEntry('/One.md')).content,'- [ ] task-two');
 await f.restart();assert.equal(f.cache.isReady(),true);assert.equal((await f.cache.getEntry('/One.md')).content,'- [ ] task-two');
}));
test('failed ordinary reproof cannot clear uncertainty or advance successful evidence',()=>fixture(async f=>{
 const before=f.cache.getStats().lastRefreshAt;f.cache.markFreshnessUncertain();f.fail();
 await f.cache.refreshCache();assert.equal(f.cache.isReady(),false);assert.equal(f.cache.getStats().lastRefreshAt,before);
 await f.restart();assert.equal(f.cache.isReady(),false);
}));
test('healthy ordinary scans retain metadata-based skipping',()=>fixture(async f=>{
 f.fail();await f.cache.refreshCache();assert.equal(f.cache.isReady(),true);assert.equal(f.cache.getStats().freshness,'observed');
}));
test('production-owned unsupported supervisor reports periodic freshness separately',()=>fixture(async f=>{
 const {LocalRestEventError}=await import('../dist/services/obsidianRestAPI/eventStreams.js');
 const mode=config.obsidianRuntimeMode,enabled=config.obsidianCacheEventsEnabled;
 config.obsidianRuntimeMode='live';config.obsidianCacheEventsEnabled=true;
 f.cache.obsidianService.consumeVaultEvents=async()=>{throw new LocalRestEventError('unsupported');};
 try{f.cache.startPeriodicRefresh();const end=Date.now()+2000;
  while(f.cache.getStats().eventCache.state!=='unsupported'&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.cache.getStats().eventCache.state,'unsupported');assert.equal(f.cache.getStats().freshness,'observed');
 }finally{f.cache.stopPeriodicRefresh();config.obsidianRuntimeMode=mode;config.obsidianCacheEventsEnabled=enabled;}
}));
