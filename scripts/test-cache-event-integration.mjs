import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';import {test,after} from 'node:test';
const root=mkdtempSync(path.join(os.tmpdir(),'optimike-cache-events-integration-'));
const logs=path.join(process.cwd(),'logs',path.basename(root));
const notes=new Map([['Note.md','one']]);const streams=new Map();const reads=[];let subscriptions=0;let counter=0;
const server=createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer FIXTURE_KEY'){res.writeHead(401).end();return;}
 if(req.method==='POST'&&req.url.startsWith('/events/')) {
  for await(const _chunk of req){};
  const event=req.url.split('/')[3];const id='fixture-subscription-'+(++subscriptions);
  res.writeHead(201,{'content-type':'application/json'}).end(JSON.stringify({id,event,emitter:'vault',signed:false,
   url:'http://127.0.0.1:'+server.address().port+'/events/vault/'+event+'/'+id+'/'}));return;
 }
 if(req.url.startsWith('/events/')) {
  const event=req.url.split('/')[3];streams.set(event,res);
  res.on('close',()=>{if(streams.get(event)===res)streams.delete(event);});
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');return;
 }
 if(req.url==='/vault/') {res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({files:[...notes.keys()]}));return;}
 const filename=decodeURIComponent(req.url.slice('/vault/'.length));reads.push(filename);
 if(!notes.has(filename)){res.writeHead(404).end('{}');return;}
 const content=notes.get(filename);const size=Buffer.byteLength(content);
 if(req.method==='HEAD'){res.writeHead(200,{'x-obsidian-mtime':'2','x-obsidian-ctime':'1','content-length':String(size)}).end();return;}
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({path:filename,content,stat:{mtime:2000,ctime:1000,size},tags:[],frontmatter:{}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
Object.assign(process.env,{NO_PROXY:'*',no_proxy:'*',OBSIDIAN_RUNTIME_MODE:'live',OBSIDIAN_API_KEY:'FIXTURE_KEY',
 OBSIDIAN_BASE_URL:'http://127.0.0.1:'+server.address().port,OBSIDIAN_VAULT:root,
 OBSIDIAN_SHARED_CACHE_DB_PATH:path.join(root,'cache.sqlite'),OBSIDIAN_CACHE_SOURCE:'rest',
 OBSIDIAN_VAULT_EXCLUDE_PATTERNS:'Private/**',OBSIDIAN_CACHE_EVENTS_ENABLED:'true',LOGS_DIR:logs,MCP_WRITE_MODE:'readonly'});
const {ObsidianRestApiService}=await import('../dist/services/obsidianRestAPI/service.js');
const {VaultCacheService}=await import('../dist/services/obsidianRestAPI/vaultCache/service.js');
const {config}=await import('../dist/config/index.js');
const cache=new VaultCacheService(new ObsidianRestApiService());
const wait=async(condition)=>{const end=Date.now()+12000;while(!await condition()){if(Date.now()>end)throw new Error('integration condition timeout');await pause(10);}};
const emit=(event,filename,extra={})=>streams.get(event)?.write('id: deadbeef-'+(counter+=7)+'\nevent: '+event+'\ndata: '+JSON.stringify({emitter:'vault',event,path:filename,isFolder:false,...extra})+'\n\n');
after(async()=>{await cache.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});rmSync(logs,{recursive:true,force:true});});

test('production adapter and cache observe create/modify/rename/delete and reconnect on real sockets',async()=>{
 assert.equal(config.obsidianCacheRefreshIntervalMin,10);
 await cache.buildVaultCache();cache.startPeriodicRefresh();cache.startPeriodicRefresh();
 await wait(()=>cache.getStats().eventCache.state==='ready');assert.equal(subscriptions,4);
 const first=cache.getStats().eventCache.reconciliations;
 notes.set('Note.md','two');emit('modify','Note.md');
 await wait(async()=>(await cache.getEntry('/Note.md'))?.content==='two');
 assert.equal(cache.getStats().eventCache.reconciliations,first,'numeric counter jumps are not gaps');
 notes.set('Created.md','created');emit('create','Created.md');
 await wait(async()=>(await cache.getEntry('/Created.md'))?.content==='created');
 notes.set('Private/hidden.md','secret');emit('create','Private/hidden.md');await pause(80);
 assert.equal(await cache.getEntry('/Private/hidden.md'),undefined);assert.ok(!reads.includes('Private/hidden.md'));
 notes.delete('Created.md');notes.set('Renamed.md','renamed');emit('rename','Renamed.md',{oldPath:'Created.md'});
 await wait(async()=>!(await cache.getEntry('/Created.md'))&&(await cache.getEntry('/Renamed.md'))?.content==='renamed');
 notes.delete('Renamed.md');emit('delete','Renamed.md');await wait(async()=>!(await cache.getEntry('/Renamed.md')));
 // A create occurring without its listener must be recovered by forced reconciliation.
 streams.get('create').end();await wait(()=>!streams.has('create'));
 notes.set('Missed.md','created while disconnected');
 await wait(async()=>(await cache.getEntry('/Missed.md'))?.content==='created while disconnected');
 await wait(()=>cache.getStats().eventCache.state==='ready');
 const evidence=cache.getStats().eventCache;
 assert.equal(subscriptions,5);assert.equal(evidence.reconnects,1);assert.ok(evidence.reconciliations>=2);
 assert.ok(evidence.eventToCacheP95Ms>=0);assert.equal(evidence.pendingPaths,0);
 console.log('FIXTURE_METRICS '+JSON.stringify(evidence));
 await cache.close();await wait(()=>streams.size===0);
});
