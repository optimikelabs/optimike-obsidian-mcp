import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=await mkdtemp(path.join(os.tmpdir(),'semantic-vector-encoding-')),source=path.join(root,'source'),db=path.join(root,'cache.sqlite');await mkdir(source);
process.env.OBSIDIAN_RUNTIME_MODE='headless-readonly';process.env.OBSIDIAN_VAULT=source;process.env.OBSIDIAN_SHARED_CACHE_DB_PATH=db;process.env.MCP_LOG_LEVEL='error';process.env.SEMANTIC_SEARCH_PREWARM='false';
const {SemanticCacheService}=await import('../dist/services/semanticCache.js');
const vec=[Math.PI,Number.MIN_VALUE,-0,0.1,1e100,-1e100,1/3,1.0000000000000002];
await writeFile(path.join(source,'vectors.json'),'[{"path":"Élysia ✅.md","embedding":[3.141592653589793,5e-324,-0,0.1,1e100,-1e100,0.3333333333333333,1.0000000000000002]}]','utf8');
const service=new SemanticCacheService(source,db,60000);
try{
 const initial=await service.getSnapshot();assert.deepEqual(initial.items[0].vec,vec);
 const row=service.db.prepare('SELECT note_path,vec_json,dim FROM semantic_vectors').get();const encoded=JSON.parse(row.vec_json);assert.equal(encoded.encoding,'float64le-base64-v1');assert.equal(encoded.length,8);assert.equal(Buffer.from(encoded.data,'base64').length,64);
 service.forceRefresh();const reloaded=await service.getSnapshot();assert.deepEqual(reloaded.items[0].vec,vec);assert.equal(Object.is(reloaded.items[0].vec[2],-0),true);
 const manifest=service.getStats().manifest;service.forceRefresh();assert.equal((await service.probeReadiness()).vectorCount,1);assert.deepEqual(service.getStats().manifest,manifest,'observational readiness never rewrites the cache');
 for(const bad of [{...encoded,encoding:'unknown'},{...encoded,length:7},{...encoded,data:encoded.data.slice(0,4)},{...encoded,data:'not-base64!'}]){
  service.db.prepare('UPDATE semantic_vectors SET vec_json=? WHERE note_path=?').run(JSON.stringify(bad),row.note_path);service.forceRefresh();await assert.rejects(service.getSnapshot(),/Invalid semantic vector cache/);
 }
 const legacy=vec.map(x=>Object.is(x,-0)?0:x);service.db.prepare('UPDATE semantic_vectors SET vec_json=? WHERE note_path=?').run(JSON.stringify(legacy),row.note_path);service.forceRefresh();assert.deepEqual((await service.getSnapshot()).items[0].vec,legacy,'legacy numeric-array rows are still readable');
 console.log('PASS semantic vector encoding: exact Float64/negative zero, legacy arrays, corrupt/unknown payload rejection and read-only readiness');
}finally{service.db.close();await rm(root,{recursive:true,force:true});}
