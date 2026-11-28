import "./test-support/isolated-state.mjs";
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
const {processObsidianNoteLinks}=await import('../dist/mcp-server/tools/obsidianNoteLinksTool/logic.js');
const {publicMcpToolErrorPayload}=await import('../dist/utils/internal/errorHandler.js');
const {extractMarkdownLinkReferences}=await import('../dist/services/obsidianRestAPI/vaultCache/markdownLinkReferences.js');
const context={requestId:'cache-consumer-fixture',timestamp:new Date().toISOString(),operation:'test'};
config.obsidianVaultPath=root;config.obsidianCacheSource='rest';

const linkTexts=(markdown)=>extractMarkdownLinkReferences(markdown).map(({linkText})=>linkText);
test('comment delimiters in code leave adjacent links visible',()=>{
 assert.deepEqual(linkTexts('Use `%%` to open [[A]]\n\nClose it with `%%`. Also [[B]].\n\n```\na %% b\n```\n[[Visible]]\n%% [[Hidden]] %% [[After]]'),['A','B','Visible','After']);
});
test('math and HTML hide links while adjacent Markdown remains visible',()=>{
 assert.deepEqual(linkTexts('$[[InlineMath]]$ <span>[[InlineHtml]] [x](Hidden.md)</span> [[Visible]]\n\n$$\n[[BlockMath]]\n$$\n\n<div>\n[[BlockHtml]]\n</div>'),['Visible']);
});
test('currency and dollars in link destinations do not open or close math',()=>{
 assert.deepEqual(['Costs $5 and [[Money]] then $10','$5 [[V]] $6','[a](A$1.md) [[V]] [b](B$2.md)'].map(linkTexts),[['Money'],['V'],['A$1.md','V','B$2.md']]);
});
test('dollars in autolinks and wikilinks are literal, and formulas still hide links',()=>{
 const samples = [
  ['https://e.com/$a [[V]] https://e.com/$b',['V']],
  ['<https://e.com/$a> [[V]] <https://e.com/$b>',['V']],
  ['[[Budget $5k]] then [[V]] and [[Tax$]]',['Budget $5k','V','Tax$']],
  ['$x$ $[[H]]$ [[V]]\n\n$$\n[[Hide me]]\n$$',['V']],
 ];
 for (const [source, expected] of samples) assert.deepEqual(linkTexts(source),expected);
});
test('external email autolinks leave adjacent vault references visible',()=>{
 assert.deepEqual(linkTexts('name+alias@example.com [[V]] <other@example.com> [mail](mailto:name@example.com) [[After]]'),['V','After']);
});
test('wikilink aliases keep square brackets and triples resolve the inner target',()=>{
 const links=extractMarkdownLinkReferences('[[V|a[b]] [[[V]]] [[Other|a]b]]\n[[Broken|a[b\n[[After]]');
 assert.deepEqual(links.map(({linkPath,displayText})=>[linkPath,displayText]),[
  ['V','a[b'],['V',undefined],['Other','a]b'],['After',undefined],
 ]);
 assert.deepEqual(linkTexts('<span>[[Hidden|</span> [[Visible]]'),['Visible']);
});
test('unpaired inline HTML is scoped to its paragraph',()=>{
 assert.deepEqual(linkTexts('a <span>x\n\n[[P2]]\n\n</span> [[V]]'),['P2','V']);
});
test('comment fences cannot shield later comments, including an open comment at EOF',()=>{
 assert.deepEqual(linkTexts('%%\n```js\nx\n%%\n[[Visible]]\n%% [[Hidden]] %%\n%% [[EOF]]'),['Visible']);
});

test('filesystem links preserve observations and reconcile edits, destination ambiguity, and restart', async () => {
 const vault=fs.mkdtempSync(path.join(root,'links-'));
 const previous={obsidianVaultPath:config.obsidianVaultPath,obsidianCacheSource:config.obsidianCacheSource,
  obsidianSharedCacheDbPath:config.obsidianSharedCacheDbPath,obsidianRuntimeMode:config.obsidianRuntimeMode,
  obsidianVaultExcludePatterns:config.obsidianVaultExcludePatterns};
 Object.assign(config,{obsidianVaultPath:vault,obsidianCacheSource:'filesystem',obsidianSharedCacheDbPath:path.join(vault,'cache.sqlite'),
  obsidianVaultExcludePatterns:[...config.obsidianVaultExcludePatterns,'Private/**','!.included/allowed.pdf']});
 const file=(name)=>path.join(vault,name);
 function write(name,content='Synthetic note.') {
  fs.mkdirSync(path.dirname(file(name)),{recursive:true});
  fs.writeFileSync(file(name),content,'utf8');
 }
 const source=[
  '\uFEFF---','related: ["[[People/Ada|Ada]]"]','---',
  '[[ada#Life|Lovelace]] ![[../B/Shared]] [encoded](../Space%20Name.md#Shown%20Here)',
  '[[#Local]] [[Shared]] [[Gone#a]] [[Gone#b]] [[Gone]] `[[Code]]` %% [[Comment]] %%',
  '[[./Shared]] [[A/Shared]] [reference][note]',
  '![](img.png) ![](missing.png) [short](Another) [[Private/Target]] [[README]]',
  '', '[note]: ../Space%20Name.md',
 ].join('\r\n');
 write('Notes/Source.md',source);
 write('Notes/People/Ada.md','# Life\n');
 write('A/Shared.md');
 write('B/Shared.md');
 write('0-Long/Shared.md');
 write('Space Name.md');
 write('Another.md','[[Notes/People/Ada]] [[Notes/People/Ada]]');
 write('Private/Target.md','[[Notes/People/Ada]]');
 write('node_modules/pkg/README.md');
 write('img.png');
 write('.hidden/doc.pdf');
 write('.included/allowed.pdf');
 write('.included/other.pdf');
 write('Hidden targets.md','![[doc.pdf]] ![[allowed.pdf]] ![[other.pdf]]');
 // Populate a cache from before the filesystem link index existed.
 config.obsidianRuntimeMode='hybrid';
 let cache=new VaultCacheService();
 const readLinks=(filePath,limit=200)=>processObsidianNoteLinks({filePath,limit},context,undefined,cache);
 const read=async(filePath,limit)=>{
  try {
   return await readLinks(filePath,limit);
  } catch(error) {
   if (!isIndexPending(error)) throw error;
   await cache.linkIndexRun;
   return readLinks(filePath,limit);
  }
 };
 try {
  await cache.refreshCache();
  assert.equal(cache.isReady(),true);
  await cache.close();
  config.obsidianRuntimeMode='headless-readonly';
  cache=new VaultCacheService();
  assert.equal(cache.isReady(),false);
  cache.waitUntilReady=()=>{ throw new Error('headless reads must await reconciliation, never a readiness deadline'); };
  await cache.buildVaultCache();
  assert.equal(cache.isReady(),true);
  assert.equal(await cache.readFilesystemNoteContent('Notes/Source.md',context),source);
  await assert.rejects(readLinks('Notes/People/Ada.md'),(error)=>{
   assert.ok(isIndexPending(error));
   const response=publicMcpToolErrorPayload(error,{
    operation:'test',toolName:'obsidian_note_links',params:{filePath:'Notes/People/Ada.md'},
   });
   assert.equal(response.error.code,'SERVICE_UNAVAILABLE');
   assert.equal(response.error.details.reasonCode,'headless_link_index_building');
   assert.equal(response.error.details.retryable,true);
   return true;
  });
  await cache.linkIndexRun;
  const result=await read('Notes/Source.md');
  assert.deepEqual((await read('Hidden targets.md')).outgoing.map(({linkText,resolution})=>[linkText,resolution.targetPath ?? null]),[
   ['doc.pdf',null],['allowed.pdf','.included/allowed.pdf'],['other.pdf',null],
  ]);
  assert.equal(result.path,'Notes/Source.md');
  assert.equal(result.provenance.sourceMetadata,'filesystem');
  assert.deepEqual(result.outgoing.map(({kind,linkText,resolution,displayText,frontmatterKey})=>
   [kind,linkText,resolution.targetPath ?? null,displayText ?? null,frontmatterKey ?? null]),[
   ['frontmatter','People/Ada','Notes/People/Ada.md','Ada','related'],
   ['link','ada#Life','Notes/People/Ada.md','Lovelace',null],
   ['embed','../B/Shared','B/Shared.md',null,null],
   ['link','../Space Name.md#Shown Here','Space Name.md','encoded',null],
   ['link','#Local','Notes/Source.md',null,null],
   ['link','Shared','A/Shared.md',null,null],
   ['link','Gone#a',null,null,null],
   ['link','Gone#b',null,null,null],
   ['link','Gone',null,null,null],
   ['link','./Shared',null,null,null],
   ['link','A/Shared','A/Shared.md',null,null],
   ['link','../Space Name.md','Space Name.md','reference',null],
   ['embed','img.png','img.png',null,null],
   ['embed','missing.png',null,null,null],
   ['link','Another','Another.md','short',null],
   ['link','Private/Target','Private/Target.md',null,null],
   ['link','README',null,null,null],
  ]);
  assert.deepEqual(result.outgoing[1].position.start,{line:3,col:0,offset:source.indexOf('[[ada')});
  assert.deepEqual(result.outgoing[1].subpathValidation,{status:'unknown',reason:'target_cache_unavailable'});
  assert.deepEqual(result.unresolved,[{linkText:'./Shared',count:1},{linkText:'Gone',count:3},{linkText:'README',count:1},{linkText:'missing.png',count:1}]);
  assert.deepEqual(result.outgoing.find(({linkText})=>linkText==='Shared').resolution,{status:'resolved',targetPath:'A/Shared.md',ambiguous:true});
  await assert.rejects(read('Private/Target.md'),(error)=>error.code==='NOT_FOUND');
  assert.deepEqual((await read('Notes/People/Ada.md')).backlinks,[
   {sourcePath:'Another.md',count:2},{sourcePath:'Notes/Source.md',count:2},
  ]);
  const bounded=await read('Notes/People/Ada.md',1);
  assert.deepEqual(bounded.backlinks,[{sourcePath:'Another.md',count:2}]);
  assert.deepEqual(bounded.coverage.backlinks,{available:true,total:2,returned:1,truncated:true});
  const boundedSource=await read('Notes/Source.md',1);
  assert.deepEqual(boundedSource.coverage.outgoing,{available:true,total:17,returned:1,truncated:true});
  assert.deepEqual(boundedSource.coverage.unresolved,{available:true,total:4,returned:1,truncated:true});
  await assert.rejects(read('Missing.md'),(error)=>error.code==='NOT_FOUND');
  await assert.rejects(read('Notes/../Another.md'),(error)=>error.code==='VALIDATION_ERROR');

  fs.unlinkSync(file('B/Shared.md'));
  fs.unlinkSync(file('0-Long/Shared.md'));
  write('Another.md','Changed content with no links.');
  await cache.refreshCache();
  assert.deepEqual((await read('A/Shared.md')).backlinks,[{sourcePath:'Notes/Source.md',count:2}]);
  assert.deepEqual((await read('Notes/People/Ada.md')).backlinks,[{sourcePath:'Notes/Source.md',count:2}]);
  write('Notes/Shared.md');
  await cache.updateFileVerified('Notes/Shared.md',context);
  await cache.close();
  cache=new VaultCacheService();
  assert.equal(cache.isReady(),true);
  assert.deepEqual((await read('Notes/Shared.md')).backlinks,[{sourcePath:'Notes/Source.md',count:2}]);

  let restContent='[[Notes/Shared]]';
  const rest=new VaultCacheService({
   listFiles:async()=>['A/Shared.md','Notes/Source.md','Notes/People/Ada.md','Notes/Shared.md','Space Name.md','Another.md','Hidden targets.md'],
   getFileMetadata:async()=>({ctime:1,mtime:2,size:1}),
   getFileContent:async(p)=>({path:p,content:p==='/Another.md'?restContent:fs.readFileSync(file(p.slice(1)),'utf8'),stat:{ctime:1,mtime:2,size:1}}),
  });
  try {
   cache.readCacheRow=()=>{ throw new Error('shared-cache reconciliation must not open disk notes'); };
   config.obsidianCacheSource='rest';
   await rest.refreshCache(true);
   assert.equal(cache.getStats().refreshSource,'rest');
   config.obsidianCacheSource='filesystem';
   assert.deepEqual((await read('Notes/Shared.md')).backlinks,[{sourcePath:'Another.md',count:1},{sourcePath:'Notes/Source.md',count:2}]);
   assert.equal((await cache.getEntry('/Another.md')).content,restContent);
   config.obsidianCacheSource='rest';
   restContent='Changed through Local REST.';
   assert.deepEqual(await rest.updateFileVerified('Another.md',context),{ok:true,disposition:'updated'});
   assert.equal(cache.getStats().refreshSource,'rest');
   config.obsidianCacheSource='filesystem';
   assert.equal(await cache.readFilesystemNoteContent('Another.md',context),restContent);
   assert.equal((await cache.getEntry('/Another.md')).content,restContent);
   await assert.rejects(readLinks('Notes/Shared.md'),isIndexPending);
   assert.deepEqual((await read('Notes/Shared.md')).backlinks,[{sourcePath:'Notes/Source.md',count:2}]);
  } finally {
   await rest.close();
  }
 } finally {
  await cache.close();
  Object.assign(config,previous);
 }
});

async function linkFixture(run) {
 const vault=fs.mkdtempSync(path.join(root,'link-worker-'));
 const previous={obsidianVaultPath:config.obsidianVaultPath,obsidianCacheSource:config.obsidianCacheSource,
  obsidianSharedCacheDbPath:config.obsidianSharedCacheDbPath};
 Object.assign(config,{obsidianVaultPath:vault,obsidianCacheSource:'filesystem',obsidianSharedCacheDbPath:path.join(vault,'cache.sqlite')});
 const write=(name,content)=>fs.writeFileSync(path.join(vault,name),content,'utf8');
 write('A.md','[[Target]]');
 write('Target.md','# Target');
 let cache=new VaultCacheService();
 try {
  await run({
   get cache(){return cache;}, write,
   read:()=>cache.readFilesystemNoteLinks('Target.md',200,context),
   reopen:async()=>{await cache.close();cache=new VaultCacheService();},
  });
 } finally {
  await cache.close();
  Object.assign(config,previous);
 }
}

test('link refusals expose the shared text cache state from another connection',()=>linkFixture(async f=>{
 await f.cache.buildVaultCache();
 await f.cache.linkIndexRun;
 const writer=new VaultCacheService();
 try {
  for (const [state,reason] of [
   ['building','headless_link_cache_refreshing'],
   ['pending-events','headless_link_cache_events_pending'],
   ['uncertain','headless_link_cache_uncertain'],
  ]) {
   writer.db.prepare("UPDATE shared_cache_metadata SET value = ? WHERE key = 'refresh_state'").run(state);
   await assert.rejects(f.read(),error=>{
    const {error:publicError}=publicMcpToolErrorPayload(error,{
     operation:'test',toolName:'obsidian_note_links',params:{filePath:'Target.md'},
    });
    assert.equal(publicError.code,'SERVICE_UNAVAILABLE');
    assert.equal(publicError.details.reasonCode,reason);
    assert.equal(publicError.details.retryable,true);
    return true;
   });
  }
  writer.db.prepare("UPDATE shared_cache_metadata SET value = 'complete' WHERE key = 'refresh_state'").run();
  assert.deepEqual((await f.read()).backlinks,[{sourcePath:'A.md',count:1}]);
 } finally { await writer.close(); }
}));

function pauseAfterFirstLinkBatch(cache) {
 const index=cache.markdownLinks;
 const reconcile=index.reconcileBatch.bind(index);
 return new Promise(resolve=>{
  index.reconcileBatch=(afterPath,accept)=>{
   index.reconcileBatch=reconcile;
   const result=reconcile(afterPath,file=>file==='/A.md' && accept(file));
   resolve();
   return result;
  };
 });
}

function isIndexPending(error) {
 return error.code==='SERVICE_UNAVAILABLE' &&
  error.details?.reasonCode==='headless_link_index_building' && error.details.retryable===true;
}

test('a local update behind the link cursor cannot yield stale backlinks',()=>linkFixture(async f=>{
 const firstBatch=pauseAfterFirstLinkBatch(f.cache);
 await f.cache.buildVaultCache();
 await firstBatch;
 f.write('A.md','[[Other]]');
 // Read the fixture synchronously to finish this real cache write before the next index batch.
 f.cache.readCacheRow=async file=>({path:file,ctime:1,mtime:2,size:9,hash:'local-edit',content:fs.readFileSync(path.join(config.obsidianVaultPath,file.slice(1)),'utf8')});
 assert.deepEqual(await f.cache.updateFileVerified('A.md',context),{ok:true,disposition:'updated'});
 await assert.rejects(f.read(),isIndexPending);
 await f.cache.linkIndexRun;
 assert.deepEqual((await f.read()).backlinks,[]);
}));

test('restart resumes a committed partial link index without exposing it',()=>linkFixture(async f=>{
 f.write('Z.md','[[Target]]');
 const firstBatch=pauseAfterFirstLinkBatch(f.cache);
 await f.cache.buildVaultCache();
 await firstBatch;
 await f.reopen();
 const stored=f.cache.db.prepare('SELECT path FROM markdown_link_files ORDER BY path').all();
 assert.deepEqual(stored.map(row=>row.path),['/A.md']);
 assert.equal(f.cache.isReady(),true);
 await assert.rejects(f.read(),isIndexPending);
 await f.cache.linkIndexRun;
 assert.deepEqual((await f.read()).backlinks,[{sourcePath:'A.md',count:1},{sourcePath:'Z.md',count:1}]);
}));

test('an indexing error rolls back the batch and a later link request retries it',()=>linkFixture(async f=>{
 const index=f.cache.markdownLinks;
 const reconcile=index.reconcileBatch.bind(index);
 index.reconcileBatch=(...args)=>{
  index.reconcileBatch=reconcile;
  reconcile(...args);
  throw new Error('Synthetic index failure');
 };
 await f.cache.buildVaultCache();
 await f.cache.linkIndexRun;
 assert.equal(f.cache.db.prepare('SELECT count(*) AS count FROM markdown_link_files').get().count,0);
 assert.equal(await f.cache.readFilesystemNoteContent('A.md',context),'[[Target]]');
 await assert.rejects(f.read(),isIndexPending);
 await f.cache.linkIndexRun;
 assert.deepEqual((await f.read()).backlinks,[{sourcePath:'A.md',count:1}]);
}));
async function readTaskModes(cache){
 const compact=JSON.parse(await processListAllTasks({responseFormat:'json'},context,cache));
 assert.equal(compact.responseMode,'compact');
 assert.equal(compact.count,compact.tasks.length);
 const legacy=JSON.parse(await processListAllTasks({responseFormat:'json',responseMode:'legacy'},context,cache));
 assert.ok(Array.isArray(legacy));
 return [compact.tasks,legacy];
}
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
 for(const result of await readTaskModes(f.cache)){
  assert.equal(result.length,1);assert.equal(result[0].description,'task-two');
 }
}));
test('task memory cache keys include content hash when timestamps and size are unchanged',()=>fixture(async f=>{
 for(const first of await readTaskModes(f.cache)) assert.equal(first[0].description,'task-one');
 f.set({'One.md':'- [ ] task-two'});await f.cache.refreshCache(true);
 for(const second of await readTaskModes(f.cache)) assert.equal(second[0].description,'task-two');
}));


test('in-process task readers wait while accepted event work is pending',()=>fixture(async f=>{
 f.cache.markEventWorkPending();
 assert.equal(f.cache.isReady(),false);
 assert.equal(f.cache.getStats().ready,false);
 let settled=false;
 const query=warmSharedTaskCache(f.cache).finally(()=>{settled=true;});
 query.catch(()=>undefined);
 try {
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(settled,false);
 } finally {
  f.cache.settleEventWork();
 }
 await query;
 assert.equal(f.cache.isReady(),true);
}));

test('in-process task readers reprove explicit uncertainty before serving',()=>fixture(async f=>{
 f.set({'One.md':'- [ ] task-two'});
 f.cache.markEventWorkPending();
 f.cache.markFreshnessUncertain();
 f.cache.settleEventWork();
 assert.equal(f.cache.isReady(),false);
 await warmSharedTaskCache(f.cache);
 assert.equal(f.cache.isReady(),true);
 for(const result of await readTaskModes(f.cache)) assert.equal(result[0].description,'task-two');
}));

test('in-process task readers remain unavailable when uncertainty cannot be reverified',()=>fixture(async f=>{
 f.cache.markFreshnessUncertain();
 f.fail();
 await assert.rejects(
  warmSharedTaskCache(f.cache),
  error=>error.code==='SERVICE_UNAVAILABLE',
 );
 assert.equal(f.cache.isReady(),false);
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
