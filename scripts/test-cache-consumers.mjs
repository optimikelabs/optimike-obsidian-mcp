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
const { processObsidianReadNote } = await import(
  "../dist/mcp-server/tools/obsidianReadNoteTool/logic.js"
);
const {warmSharedTaskCache,processListAllTasks}=await import('../dist/mcp-server/tools/tasksShared/logic.js');
const context={requestId:'cache-consumer-fixture',timestamp:new Date().toISOString(),operation:'test'};
config.obsidianVaultPath=root;config.obsidianCacheSource='rest';
async function readTaskModes(cache){
 const compact=JSON.parse(await processListAllTasks({responseFormat:'json'},context,cache));
 assert.equal(compact.responseMode,'compact');
 assert.equal(compact.count,compact.tasks.length);
 const legacy=JSON.parse(await processListAllTasks({responseFormat:'json',responseMode:'legacy'},context,cache));
 assert.ok(Array.isArray(legacy));
 return [compact.tasks,legacy];
}
after(()=>fs.rmSync(root,{recursive:true,force:true}));
async function fixture(body, files = {'One.md':'- [ ] task-one'}){
 config.obsidianSharedCacheDbPath=path.join(root,crypto.randomUUID()+'.sqlite');
 let fail=false;
 const rest={listFiles:async()=>Object.keys(files),getFileMetadata:async()=>({ctime:1,mtime:2,size:14}),
  getFileContent:async p=>{if(fail)throw new Error('offline');return {path:p,content:files[p.replace(/^\//,'')],stat:{ctime:1,mtime:2,size:14}};}};
 let cache=new VaultCacheService(rest);
 try{await cache.refreshCache(true);await body({get cache(){return cache;},fail:()=>{fail=true;},
  restart:async()=>{await cache.close();cache=new VaultCacheService(rest);},set:v=>{files=v;}});}
 finally{await cache.close();}
}

const dateProperties = {
  day: "2026-04-01",
  localTime: "2026-04-01T13:45:00",
  offsetTime: "2026-04-01T13:45:00+05:30",
};
const dateFields = Object.entries(dateProperties).map(([key, value]) => `${key}: ${value}`);

// Synthetic notes using the Local REST JSON types observed in the parity report.
for (const [name, eol, bom, fields, frontmatter, tags] of [
  [
    "CRLF frontmatter keeps properties and separates metadata from body tags",
    "\r\n", "", ["aliases: [Sample alias]", "tags: [project/demo]", "#metadata-only"],
    { aliases: ["Sample alias"], tags: ["project/demo"] }, ["project/demo", "body"],
  ],
  [
    "a UTF-8 BOM before the opening delimiter keeps frontmatter readable",
    "\n", "\uFEFF", ["title: Sample"],
    { title: "Sample" }, ["body"],
  ],
  [
    "plain YAML dates and datetimes keep their Local REST string values and offsets",
    "\n", "", [...dateFields, "count: 3", "active: true"],
    { ...dateProperties, count: 3, active: true }, ["body"],
  ],
]) {
  test(`cached JSON note reads: ${name}`, () => {
    const content = bom + ["---", ...fields, "---", "Sample #body", ""].join(eol);
    return fixture(async ({ cache }) => {
      const result = await processObsidianReadNote(
        { filePath: "Sample.md", format: "json", includeStat: false },
        context,
        undefined,
        cache,
      );
      const { content: markdown, frontmatter: properties, tags: noteTags } = result.content;
      assert.deepEqual({ content: markdown, frontmatter: properties, tags: noteTags }, {
        content,
        frontmatter,
        tags,
      });
    }, { "Sample.md": content });
  });
}

test("local Bases match date strings and return the written datetime offset", async () => {
  const baseId = "Date properties.base";
  const basePath = path.join(root, baseId);
  fs.writeFileSync(basePath, "views: []\n");
  try {
    const content = ["\uFEFF---", ...dateFields, "---", ""].join("\r\n");
    await fixture(async ({ cache }) => {
      const result = await new LocalBasesService(cache).queryBase(
        baseId,
        { property_only: true, filter: { day: dateProperties.day } },
        context,
      );
      assert.equal(result.rows.length, 1);
      const { day, localTime, offsetTime } = result.rows[0].props;
      assert.deepEqual({ day, localTime, offsetTime }, dateProperties);
    }, { "Sample.md": content });
  } finally {
    fs.unlinkSync(basePath);
  }
});

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
