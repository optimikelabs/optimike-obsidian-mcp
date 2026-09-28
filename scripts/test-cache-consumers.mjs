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
