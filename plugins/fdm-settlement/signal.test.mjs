import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installFdmSettlementSignal } from './signal.mjs';
function fixture() {
  const events = new Map(), cleanup = [];
  const file = {path: 'test.md'};
  const plugin = { settings: {}, bulkRunning: false, renameSuppression: null,
    modifyTimers: new Map(), newFileTimers: new Map(), recentlyCreated: new Set(), newFileModified: new Set(),
    manualPending: new Set(), processingFiles: new Set(), automaticDatesAllowed: () => true, getWriteBlock: async () => null,
    registerEvent: () => {}, register: fn => cleanup.push(fn),
    app: {vault: {on(name, fn) {events.set(name, fn);}, read: async () => "observed bytes", getAbstractFileByPath: () => file},
      metadataCache: {on(name, fn) {events.set('metadata:'+name, fn);}}},
    scheduleRetry(file, delayMs, origin) {if (!this.modifyTimers.has(file.path)) this.modifyTimers.set(file.path,{delayMs,origin});},
    processFileWithLock: async () => ({status: 'ok', wrote: false}), handleFileChange: async () => ({}), handleFileOpen: async () => {},
  };
  const api = installFdmSettlementSignal(plugin);
  const begin=api.begin;api.begin=path=>{const key=begin(path);api.activate(key);return key;};
  return {plugin, api, file, emit: (name, target=file) => events.get(name)(target), cleanup};
}
test('ack requires observed edit and successful final pass; timers/locks block', async () => {
  const f=fixture(), key=f.api.begin(f.file.path);
  assert.equal((await f.api.observe(key)).state,'pending');
  f.emit('modify'); assert.equal((await f.api.observe(key)).state,'pending');
  await f.plugin.processFileWithLock(f.file); assert.equal((await f.api.observe(key)).state,'complete');
  for(const field of ['modifyTimers','newFileTimers','recentlyCreated','newFileModified','manualPending','processingFiles']) {
    const collection=f.plugin[field]; collection instanceof Map ? collection.set(f.file.path,1) : collection.add(f.file.path);
    assert.equal((await f.api.observe(key)).state,'pending',field); collection.delete(f.file.path);
  }
  f.emit('modify'); assert.equal((await f.api.observe(key)).state,'pending');
});
test('concurrent edit during a pass invalidates its acknowledgement',async()=>{
  const f=fixture();let finish;
  // Reinstall around controllable original before events/receipts.
  f.cleanup.forEach(fn=>fn());f.plugin.processFileWithLock=()=>new Promise(r=>finish=r);
  const api=installFdmSettlementSignal(f.plugin),key=api.begin(f.file.path);api.activate(key);f.emit('modify');
  const work=f.plugin.processFileWithLock(f.file);f.emit('modify');finish({status:'ok'});await work;
  assert.equal((await api.observe(key)).state,'pending');
});
test('deferred, failed and dirty work never acknowledges; unload/rename invalidate',async()=>{
  for(const result of [{status:'ok',deferred:true},{status:'error'},{status:'ok',blocked:'excalidraw'}]) {
    const f=fixture();f.cleanup.forEach(fn=>fn());f.plugin.processFileWithLock=async()=>result;
    const api=installFdmSettlementSignal(f.plugin),key=api.begin(f.file.path);api.activate(key);f.emit('modify');await f.plugin.processFileWithLock(f.file);
    assert.equal((await api.observe(key)).state,'pending');
  }
  const f=fixture(),key=f.api.begin(f.file.path);f.emit('modify');await f.plugin.processFileWithLock(f.file);
  f.plugin.getWriteBlock=async()=> 'markdown';assert.equal((await f.api.observe(key)).state,'pending');
  f.plugin.getWriteBlock=async()=> {f.emit('modify');return null;};assert.equal((await f.api.observe(key)).state,'pending');
  f.emit('rename');assert.equal((await f.api.observe(key)).state,'pending');f.cleanup.forEach(fn=>fn());assert.equal(f.api.begin(f.file.path),null);
});
test('settings, pause, bulk, rename and pre-lock file-open work block completion',async()=>{
  const f=fixture(),key=f.api.begin(f.file.path);f.emit('modify');await f.plugin.processFileWithLock(f.file);
  f.plugin.settings.changed=true;assert.equal((await f.api.observe(key)).state,'pending');delete f.plugin.settings.changed;
  for(const field of ['bulkRunning','renameSuppression']) {f.plugin[field]=true;assert.equal((await f.api.observe(key)).state,'pending');f.plugin[field]=false;}
  f.plugin.automaticDatesAllowed=()=>false;assert.equal((await f.api.observe(key)).state,'pending');
});
test('a pass started before CAS acknowledgement cannot certify the later write',async()=>{
  const f=fixture();f.cleanup.forEach(fn=>fn());let finish;
  f.plugin.processFileWithLock=()=>new Promise(r=>finish=r);
  const api=installFdmSettlementSignal(f.plugin),key=api.begin(f.file.path);f.emit('modify');
  const work=f.plugin.processFileWithLock(f.file);api.activate(key);finish({status:'ok'});await work;
  assert.equal((await api.observe(key)).state,'pending');
});

test('ordinary notes and failed/deferred passes do not add a vault read',async()=>{
  const f=fixture();let reads=0;f.plugin.app.vault.read=async()=>{reads++;return 'observed bytes';};
  await f.plugin.processFileWithLock(f.file);assert.equal(reads,0);
  const key=f.api.begin(f.file.path);f.emit('modify');await f.plugin.processFileWithLock(f.file);
  assert.equal(reads,1);assert.equal((await f.api.observe(key)).state,'complete');
  f.api.cancel(key);await f.plugin.processFileWithLock(f.file);assert.equal(reads,1);
});

test('only initial modify debounce on a live checkpoint is shortened; proof/cancel/config end acceleration',async()=>{
  const f=fixture();assert.equal(f.api.modifyDebounceMs(f.file),2000);
  const key=f.api.begin(f.file.path);assert.equal(f.api.modifyDebounceMs(f.file),100);
  assert.equal(f.api.modifyDebounceMs({path:'other.md'}),2000);
  f.plugin.settings.changed=true;assert.equal(f.api.modifyDebounceMs(f.file),2000);delete f.plugin.settings.changed;
  f.emit('modify');await f.plugin.processFileWithLock(f.file);await f.api.observe(key);
  assert.equal(f.api.modifyDebounceMs(f.file),2000);
  const key2=f.api.begin(f.file.path);assert.equal(f.api.modifyDebounceMs(f.file),100);f.api.cancel(key2);
  assert.equal(f.api.modifyDebounceMs(f.file),2000);
  f.api.begin(f.file.path);f.cleanup.forEach(fn=>fn());assert.equal(f.api.modifyDebounceMs(f.file),2000);
});

