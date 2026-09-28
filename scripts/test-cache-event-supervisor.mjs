import assert from 'node:assert/strict';import {test} from 'node:test';
import {setTimeout as pause} from 'node:timers/promises';
import {CacheEventSupervisor} from '../dist/services/obsidianRestAPI/vaultCache/eventSupervisor.js';
import {LocalRestEventError} from '../dist/services/obsidianRestAPI/eventStreams.js';
const wait=async(condition)=>{const end=Date.now()+3000;while(!condition()){if(Date.now()>end)throw new Error('condition timeout');await pause(5);}};
function make(options={}) {
 const channels=new Map();const updates=[];let scans=0;let uncertain=0;let failedUpdate=false;let scanHold;
 const source={consumeVaultEvents:(event,signal,ready,receive)=>new Promise((resolve,reject)=>{
   const c={receive,close:()=>{channels.delete(event);reject(new LocalRestEventError('unavailable'));}};
   channels.set(event,c);signal.addEventListener('abort',()=>{channels.delete(event);reject(new LocalRestEventError('aborted'));},{once:true});ready();
 })};
 const target={accepts:(path,folder)=>!path.startsWith('Private/')&&(folder||path.endsWith('.md')),
   update:async path=>{updates.push(path);return {ok:!failedUpdate};},
   reconcile:async()=>{scans++;if(scanHold)await scanHold;return true;},uncertain:()=>{uncertain++;}};
 const supervisor=new CacheEventSupervisor(source,target,{maxPending:4,batchSize:2,debounceMs:5,retryMinMs:10,retryMaxMs:40,reconcileIntervalMs:20,...options});
 return {supervisor,channels,updates,scans:()=>scans,uncertain:()=>uncertain,
 failUpdates:value=>{failedUpdate=value;},hold:promise=>{scanHold=promise;},
 emit:(event,path,extra={})=>channels.get(event).receive({event,path,isFolder:false,epoch:'deadbeef',...extra})};
}
async function run(body,options){const f=make(options);f.supervisor.start();try{await wait(()=>f.supervisor.snapshot().state==='ready');await body(f);}finally{await f.supervisor.stop();}}

test('four connections share one coalesced initial reconciliation; start is idempotent',async()=>run(async f=>{
 f.supervisor.start();assert.equal(f.channels.size,4);assert.equal(f.scans(),1);assert.equal(f.supervisor.snapshot().connectionAttempts,4);
}));
test('duplicate paths coalesce and unrelated binary/excluded paths do not enter cache',async()=>run(async f=>{
 f.emit('modify','Note.md');f.emit('modify','Note.md');f.emit('modify','Private/Secret.md');f.emit('create','image.png');
 await wait(()=>f.updates.length===1);assert.deepEqual(f.updates,['Note.md']);await wait(()=>f.supervisor.snapshot().state==='ready');
 assert.equal(f.supervisor.snapshot().latencySampleCount,1);assert.equal(f.scans(),1);
}));
test('rename reconciles both old and new Markdown identities',async()=>run(async f=>{
 f.emit('rename','New.md',{oldPath:'Old.md'});await wait(()=>f.updates.length===2);assert.deepEqual(f.updates,['Old.md','New.md']);
}));
test('folder rename requests inventory reconciliation rather than treating folder as a file',async()=>run(async f=>{
 f.emit('rename','New',{oldPath:'Old',isFolder:true});await wait(()=>f.scans()===2);assert.deepEqual(f.updates,[]);
}));
test('epoch change invalidates coverage but normal repeated epoch does not',async()=>run(async f=>{
 f.emit('modify','A.md');await wait(()=>f.updates.length===1);assert.equal(f.scans(),1);
 f.emit('modify','A.md',{epoch:'cafebabe'});await wait(()=>f.scans()===2);
}));
test('disconnect causes a new authenticated subscription and full reconciliation',async()=>run(async f=>{
 f.channels.get('modify').close();await wait(()=>f.supervisor.snapshot().reconnects===1);await wait(()=>f.scans()===2);
 assert.equal(f.supervisor.snapshot().connectionAttempts,5);
}));
test('bounded overflow schedules reconciliation, never unbounded path retention',async()=>run(async f=>{
 for(let i=0;i<12;i++)f.emit('modify',i+'.md');assert.ok(f.supervisor.snapshot().pendingPaths<=4);
 assert.ok(f.supervisor.snapshot().overflows>=1);await wait(()=>f.scans()>=2);
}));
test('failed incremental update stays uncertain until a later reconciliation',async()=>run(async f=>{
 f.failUpdates(true);f.emit('modify','A.md');await wait(()=>f.supervisor.snapshot().updateFailures===1);
 f.failUpdates(false);await wait(()=>f.scans()>=2);await wait(()=>f.supervisor.snapshot().state==='ready');
}));
test('a reconciliation request arriving during a scan is not lost',async()=>run(async f=>{
 let release;f.hold(new Promise(resolve=>{release=resolve;}));
 f.emit('rename','Folder',{isFolder:true,oldPath:'Old'});await wait(()=>f.scans()===2);
 f.emit('rename','Another',{isFolder:true,oldPath:'Folder'});release();f.hold(null);await wait(()=>f.scans()===3);
}));
test('stop closes all streams, drains cache work and ignores stale callbacks',async()=>run(async f=>{
 const stale=f.channels.get('modify').receive;await f.supervisor.stop();stale({event:'modify',path:'A.md',isFolder:false});
 assert.equal(f.channels.size,0);assert.equal(f.supervisor.snapshot().state,'stopped');assert.equal(f.updates.length,0);
}));
test('unsupported host remains explicit without failing the periodic cache',async()=>{
 let scans=0;const supervisor=new CacheEventSupervisor({consumeVaultEvents:async()=>{throw new LocalRestEventError('unsupported');}},
 {accepts:()=>true,update:async()=>({ok:true}),reconcile:async()=>{scans++;return true;},uncertain:()=>{}},
 {retryMinMs:50,retryMaxMs:100});
 supervisor.start();try{await wait(()=>supervisor.snapshot().state==='unsupported');assert.equal(scans,0);}
 finally{await supervisor.stop();}
});
