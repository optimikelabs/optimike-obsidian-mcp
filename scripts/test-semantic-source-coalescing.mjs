import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=await mkdtemp(path.join(os.tmpdir(),'semantic-source-coalescing-')),source=path.join(root,'source'),db=path.join(root,'cache.sqlite');await mkdir(source);
process.env.OBSIDIAN_RUNTIME_MODE='headless-readonly';process.env.OBSIDIAN_VAULT=source;process.env.OBSIDIAN_SHARED_CACHE_DB_PATH=db;process.env.MCP_LOG_LEVEL='error';process.env.SEMANTIC_SEARCH_PREWARM='false';
const {SemanticCacheService}=await import('../dist/services/semanticCache.js');
await writeFile(path.join(source,'vectors.json'),JSON.stringify([{path:'Test.md',embedding:[0.1,0.3]}]),'utf8');
const service=new SemanticCacheService(source,db,60000);
try{
 const reads=[service.loadSource(0)],first=service.pendingSource;
 for(let i=0;i<7;i++){reads.push(service.loadSource(0));assert.equal(service.pendingSource,first,'same generation shares one actual source read');}
 const items=await Promise.all(reads);assert.ok(items.every(x=>x===items[0]));assert.equal(service.pendingSource,null,'successful in-flight state is released');assert.equal(service.getStats().manifest,null,'source reads alone never persist');
 let resolveOld;const oldPromise=new Promise(r=>resolveOld=r);service.pendingSource={generation:0,promise:oldPromise};service.forceRefresh();
 const fresh=await service.loadSource(1);assert.deepEqual(fresh[0].vec,[0.1,0.3]);resolveOld([{notePath:'Wrong.md',vec:[1]}]);assert.equal(service.getStats().manifest,null);
 const invalid=[service.loadSource(2)];const prior=service.pendingSource;invalid.push(service.loadSource(2));assert.equal(service.pendingSource,prior);await Promise.all(invalid);
 // Both roles enter through source scans. Verify their shared reader and publication contracts.
 for(const order of ['query-first','probe-first']){
  service.db.prepare('DELETE FROM semantic_manifest').run();service.db.prepare('DELETE FROM semantic_vectors').run();service.forceRefresh();let calls=0,starts=0;
  const load=service.loadSource.bind(service);service.loadSource=(generation)=>{calls++;const before=service.pendingSource;const result=load(generation);if(service.pendingSource!==before)starts++;return result;};
  const query=()=>service.getSnapshot(),probe=()=>service.probeReadiness();await Promise.all(order==='query-first'?[query(),probe()]:[probe(),query()]);
  assert.equal(calls,2);assert.equal(starts,1,'probe and query share one read in '+order);assert.equal(service.getStats().manifest.vectorCount,1);service.loadSource=load;
 }
 service.db.prepare('DELETE FROM semantic_manifest').run();service.forceRefresh();
 const oldGeneration=service.refreshGeneration,actualLoad=service.loadSource.bind(service);let releaseOld,entered=0,enteredBoth;
 const gate=new Promise(r=>releaseOld=r),both=new Promise(r=>enteredBoth=r);
 service.loadSource=async generation=>{if(generation===oldGeneration){if(++entered===2)enteredBoth();await gate;return [{notePath:'Stale.md',vec:[1]}];}return actualLoad(generation);};
 const inFlight=[service.getSnapshot(),service.probeReadiness()];await both;
 await writeFile(path.join(source,'vectors.json'),JSON.stringify([{path:'Fresh.md',embedding:[0.9,0.1]}]),'utf8');service.forceRefresh();releaseOld();
 const [refreshed,observed]=await Promise.all(inFlight);assert.equal(refreshed.items[0].notePath,'Fresh.md');assert.deepEqual(refreshed.items[0].vec,[0.9,0.1]);assert.equal(observed.dominantDimension,2);assert.equal(service.getStats().manifest.vectorCount,1);service.loadSource=actualLoad;
 service.forceRefresh();await writeFile(path.join(source,'vectors.json'),'[]','utf8');service.db.prepare('DELETE FROM semantic_manifest').run();
 const failures=await Promise.allSettled([service.getSnapshot(),service.probeReadiness()]);assert.ok(failures.every(x=>x.status==='rejected'),'empty authoritative source cannot become ready');assert.equal(service.pendingSource,null);assert.equal(service.readiness,null);
 console.log('PASS source coalescing: one source read for both orders, generation isolation, no independent probe writes, failure cleanup');
}finally{service.db.close();await rm(root,{recursive:true,force:true});}
