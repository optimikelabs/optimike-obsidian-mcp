import assert from 'node:assert/strict';
import test from 'node:test';
import { createFdmCompletion } from './fdmCompletion.js';
import { sha256 } from './contract.js';
function fixture() {
  let state = {state:'complete',epoch:'epoch',generation:1,sha256:sha256('bytes')};
  const api = {contractVersion:1,implementation:'elysia-fdm-1.6.0-v1',epoch:'epoch',
    begin:()=> 'private-key',activate:()=>{},cancel:()=>{},observe:async()=>({...state})};
  const fdm = {manifest:{version:'1.6.0'},settings:{dateFormat:"yyyy-MM-dd'T'HH:mm",enableAutoUpdate:true,enableModifiedTime:true,headerUpdated:'modification'},optimikeSettlement:api};
  const app = {plugins:{plugins:{'frontmatter-date-manager':fdm},getPlugin:(id: string)=>id === 'frontmatter-date-manager' ? fdm : undefined}};
  const consumer=createFdmCompletion(app),token=consumer.begin('Note.md')!;
  return {consumer,token,fdm,api,setState:(next:Partial<typeof state>)=>{state={...state,...next};}};
}
test('only a matching completion survives content read and generation fencing',async()=>{
  const f=fixture();assert.equal((await f.consumer.read('Note.md',f.token,async()=> 'bytes')).completion?.state,'complete');
  assert.equal((await f.consumer.read('Note.md',f.token,async()=> 'different')).completion?.state,'pending');
  assert.equal((await f.consumer.read('Note.md',f.token,async()=> {f.setState({generation:2});return 'bytes';})).completion?.state,'pending');
  assert.equal((await f.consumer.read('Other.md',f.token,async()=> 'bytes')).completion,undefined);
});
test('plugin reload, configuration change, failure or cancellation fall back',async()=>{
  for(const mode of ['reload','settings','pending','cancel','version']) {
    const f=fixture();if(mode==='reload')f.fdm.optimikeSettlement={...f.api};
    if(mode==='settings')f.fdm.settings.headerUpdated='different';if(mode==='pending')f.setState({state:'pending'});
    if(mode==='cancel')f.consumer.cancel(f.token);if(mode==='version')f.fdm.manifest.version='1.6.1';
    assert.equal((await f.consumer.read('Note.md',f.token,async()=> 'bytes')).completion?.state,mode==='pending'?'pending':undefined,mode);
  }
});

test('admits qualified v2 but rejects unknown signal implementations',async()=>{
  const f=fixture();f.api.implementation='elysia-fdm-1.6.0-v2';
  assert.equal(f.consumer.capability().available,true);
  assert.equal((await f.consumer.read('Note.md',f.token,async()=> 'bytes')).completion?.state,'complete');
  f.api.implementation='elysia-fdm-unknown';assert.equal(f.consumer.capability().available,false);
  assert.equal((await f.consumer.read('Note.md',f.token,async()=> 'bytes')).completion,undefined);
});
