import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {AssetImportOperationAdapter} from '../dist/services/assets/assetImportOperation.js';
import {AssetImportInputSchema} from '../dist/services/assets/assetImportContract.js';
import {ObsidianNoteReplaceJournal} from '../dist/services/operations/obsidianNoteReplaceJournal.js';
import {assetHash} from '../dist/services/assets/windowsAssetFiles.js';
import {AssetWorkerError} from '../dist/services/assets/workerClient.js';

const original=Buffer.from('authorized original bytes');
const output=Buffer.from('verified encoded bytes');
const policy={vaultRoot:'C:\\Fixture',assetFolder:'Images',quality:75};
const metadata={format:'webp',width:2,height:3,pages:1,hasAlpha:true,sourceSha256:assetHash(original),sha256:assetHash(output),size:output.length,encoderVersion:'fixture:1',exception:'none'};
const makeInput=(extra={})=>({source:{rootId:'fixture',relativePath:'source.png',sha256:assetHash(original)},name:'diagram',idempotencyKey:'asset-fixture-key',...extra});
async function fixture(body){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'optimike-asset-operation-')),db=path.join(root,'journal.sqlite');
 let journal=new ObsidianNoteReplaceJournal(db),writes=0,reads=0,converts=0,currentBinding='a'.repeat(64),sourcePolicy='b'.repeat(64),mode='ok',guard=true;
 const files=new Map();
 const backend={
  inspect:async(name,expected)=>{
   if(expected&&expected!==currentBinding)throw new AssetWorkerError('asset_binding_conflict');
   const bytes=files.get(name);return bytes?{binding:currentBinding,exists:true,sha256:assetHash(bytes),size:bytes.length,fileIdentity:'fixture:1'}:{binding:currentBinding,exists:false};
  },
  create:async(name,bytes,expected)=>{
   if(expected!==currentBinding)throw new AssetWorkerError('asset_binding_conflict');
   if(files.has(name))throw new AssetWorkerError('asset_exists');
   writes++;files.set(name,mode==='partial'?Buffer.from([1]):Buffer.from(bytes));
   if(mode!=='ok')throw new AssetWorkerError('asset_worker_unavailable');
   return {sha256:assetHash(bytes),size:bytes.length,fileIdentity:'fixture:1'};
  },
 };
 const source={authorize:()=>sourcePolicy,read:async()=>{reads++;return Buffer.from(original);}};
 const convert=async()=>{converts++;return {bytes:Buffer.from(output),...metadata};};
 const authorize=()=>{if(!guard)throw new Error('permission refused private sentinel');};
 let adapter=new AssetImportOperationAdapter(backend,journal,policy,convert);
 try{await body({get adapter(){return adapter;},get journal(){return journal;},db,files,backend,source,authorize,
  writes:()=>writes,reads:()=>reads,converts:()=>converts,setMode:m=>{mode=m;},setGuard:v=>{guard=v;},
  changeSourcePolicy:()=>{sourcePolicy='c'.repeat(64);},changeBinding:()=>{currentBinding='d'.repeat(64);},
  restart:()=>{journal.close();journal=new ObsidianNoteReplaceJournal(db);adapter=new AssetImportOperationAdapter(backend,journal,policy,convert);},
  convert,
 });}finally{journal.close();fs.rmSync(root,{recursive:true,force:true});}
}

test('plan freezes bytes without creating an asset or inserting a link; apply verifies and replay never writes',()=>fixture(async f=>{
 const plan=await f.adapter.plan(makeInput(),f.source,f.authorize);
 assert.equal(plan.phase,'planned');assert.equal(plan.embed,null);assert.equal(f.writes(),0);
 assert.equal(JSON.stringify(plan).includes(output.toString('base64')),false);
 assert.equal(JSON.stringify(plan).includes('source.png'),false);
 const result=await f.adapter.apply(plan.planRef,makeInput().idempotencyKey,f.source,f.authorize);
 assert.equal(result.outcome,'committed');assert.equal(result.embed,'![[Images/diagram.webp]]');assert.equal(f.writes(),1);
 assert.equal((await f.adapter.apply(plan.planRef,makeInput().idempotencyKey,f.source,f.authorize)).outcome,'committed');
 assert.equal(f.writes(),1);assert.equal(f.reads(),1);
 const row=f.journal.get(plan.planRef.slice('oasset:'.length));assert.equal(row.nextContent,'');
}));
test('idempotency binds exact input and does not reacquire or reconvert on a repeat',()=>fixture(async f=>{
 const first=await f.adapter.plan(makeInput(),f.source,f.authorize);
 assert.equal((await f.adapter.plan(makeInput(),f.source,f.authorize)).planRef,first.planRef);
 await assert.rejects(f.adapter.plan(makeInput({name:'other'}),f.source,f.authorize),e=>e.code==='CONFLICT');
 assert.equal(f.reads(),1);assert.equal(f.converts(),1);assert.equal(f.writes(),0);
}));
test('wrong source hash never creates a plan or invokes conversion',()=>fixture(async f=>{
 await assert.rejects(f.adapter.plan(makeInput({source:{...makeInput().source,sha256:'e'.repeat(64)}}),f.source,f.authorize),e=>e.code==='CONFLICT');
 assert.equal(f.converts(),0);assert.equal(f.writes(),0);
}));
test('revoked write or source policy prevents apply without changing the planned state',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);
 f.setGuard(false);await assert.rejects(f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize));
 f.setGuard(true);f.changeSourcePolicy();await assert.rejects(f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize));
 assert.equal((await f.adapter.status(p.planRef)).phase,'planned');assert.equal(f.writes(),0);
}));
test('existing destination and a destination race never overwrite or silently reuse',()=>fixture(async f=>{
 f.files.set('diagram.webp',Buffer.from('existing'));
 await assert.rejects(f.adapter.plan(makeInput(),f.source,f.authorize),e=>e.code==='CONFLICT');
 f.files.clear();const p=await f.adapter.plan(makeInput(),f.source,f.authorize);
 f.files.set('diagram.webp',Buffer.from('raced'));
 assert.equal((await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize)).outcome,'conflict');
 assert.equal(f.files.get('diagram.webp').toString(),'raced');assert.equal(f.writes(),0);
}));
test('changed destination parent binding refuses the mutation',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);f.changeBinding();
 assert.equal((await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize)).outcome,'rejected');
 assert.equal(f.writes(),0);
}));
test('lost write acknowledgement reconciles after restart without a second dispatch',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);f.setMode('lost-response');
 assert.equal((await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize)).outcome,'outcome_unknown');
 f.restart();const status=await f.adapter.status(p.planRef);
 assert.equal(status.outcome,'committed');assert.equal(status.authorship,'not_proven_by_observation');
 await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize);assert.equal(f.writes(),1);
}));
test('partial or missing uncertain asset is preserved and never blindly re-created',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);f.setMode('partial');
 const result=await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize);
 assert.equal(result.outcome,'outcome_unknown');assert.equal(result.embed,null);
 f.restart();assert.equal((await f.adapter.status(p.planRef)).outcome,'outcome_unknown');
 assert.deepEqual(f.files.get('diagram.webp'),Buffer.from([1]));
 f.files.clear();await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize);
 assert.equal(f.writes(),1);assert.equal(f.files.size,0);
}));
test('later drift is visible instead of issuing a usable embed from an old committed receipt',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize);
 f.files.set('diagram.webp',Buffer.from('changed'));
 const status=await f.adapter.status(p.planRef);assert.equal(status.outcome,'committed');
 assert.equal(status.postflight.status,'unverified');assert.equal(status.embed,null);
}));
test('sealed corruption and foreign projection cannot dispatch a binary write',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize),id=p.planRef.slice(7);
 const db=new DatabaseSync(f.db);
 try{
  const row=JSON.parse(db.prepare('SELECT payload_json FROM obsidian_note_replace_plans WHERE operation_id=?').get(id).payload_json);
  row.nextContent=Buffer.from('tampered').toString('base64');
  db.prepare('UPDATE obsidian_note_replace_plans SET payload_json=? WHERE operation_id=?').run(JSON.stringify(row),id);
  await assert.rejects(f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize));
  row.projection.kind='obsidian.note.create';db.prepare('UPDATE obsidian_note_replace_plans SET payload_json=? WHERE operation_id=?').run(JSON.stringify(row),id);
  await assert.rejects(f.adapter.status(p.planRef));assert.equal(f.writes(),0);
 }finally{db.close();}
}));
test('a differently configured asset root cannot use the old sealed plan',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);
 const changed=new AssetImportOperationAdapter(f.backend,f.journal,{...policy,assetFolder:'Other'},f.convert);
 await assert.rejects(changed.status(p.planRef));assert.equal(f.writes(),0);
}));
test('pending binary payload budget is enforced in SQLite and idempotent lookups still succeed',()=>fixture(async f=>{
 let first;
 for(let i=0;i<32;i++){const p=await f.adapter.plan(makeInput({name:'image-'+i,idempotencyKey:'asset-budget-'+i}),f.source,f.authorize);first??=p;}
 await assert.rejects(f.adapter.plan(makeInput({name:'overflow',idempotencyKey:'asset-overflow'}),f.source,f.authorize),e=>e.code==='SERVICE_UNAVAILABLE');
 const repeat=await f.adapter.plan(makeInput({name:'image-0',idempotencyKey:'asset-budget-0'}),f.source,f.authorize);assert.equal(repeat.planRef,first.planRef);
 await f.adapter.apply(first.planRef,'asset-budget-0',f.source,f.authorize);
 assert.equal((await f.adapter.plan(makeInput({name:'next',idempotencyKey:'asset-next-one'}),f.source,f.authorize)).phase,'planned');
}));
test('unrequested URL/download/overwrite/bytes behavior is not admitted by the input contract',()=>{
 for(const extra of [{url:'https://example.invalid/image.png'},{overwrite:true},{downloadAll:true},{bytes:'AAAA'},{mode:'reference'},{targetNote:'Note.md'}])
  assert.equal(AssetImportInputSchema.safeParse(makeInput(extra)).success,false);
 assert.equal(AssetImportInputSchema.safeParse(makeInput({source:{url:'https://example.invalid/x'}})).success,false);
});


test('the owning runtime cockpit accepts all six projections with assets absent or pending',()=>fixture(async f=>{
 Object.assign(process.env,{NODE_ENV:'test',OBSIDIAN_RUNTIME_MODE:'live',OBSIDIAN_API_KEY:'fixture-not-a-secret',OBSIDIAN_VAULT:path.dirname(f.db),MCP_LOG_DIR:path.join(path.dirname(f.db),'logs'),MCP_WRITE_MODE:'full'});
 const {GovernedNoteReplaceRuntime}=await import('../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js');
 const list=()=>GovernedNoteReplaceRuntime.prototype.listPendingOperationRows.call({journal:f.journal},{limit:100});
 assert.deepEqual(list(),{rows:[],hasMore:false});
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);
 const before=f.journal.get(p.planRef.slice(7));
 const page=list();assert.equal(page.rows.length,1);
 assert.equal(page.rows[0].operationKind,'obsidian.asset.import');
 assert.equal(page.rows[0].operationId,p.planRef.slice(7));
 assert.deepEqual(f.journal.get(p.planRef.slice(7)),before,'listing must not mutate the sealed plan');
}));

test('real pre-spawn worker saturation keeps the same frozen plan retryable across restart',()=>fixture(async f=>{
 const {runAssetJob,activeAssetWorkers}=await import('../dist/services/assets/workerClient.js');
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);
 const before=f.journal.get(p.planRef.slice(7));
 const create=f.backend.create;
 let jobs=[];
 f.backend.create=async()=>{
  jobs=[runAssetJob({kind:'convert',bytes:original,policy:{quality:75}}).catch(()=>{}),
        runAssetJob({kind:'convert',bytes:original,policy:{quality:75}}).catch(()=>{})];
  assert.equal(activeAssetWorkers(),2);
  return runAssetJob({kind:'create',vaultRoot:policy.vaultRoot,assetFolder:policy.assetFolder,filename:'diagram.webp',binding:before.bindingFingerprint,bytes:output});
 };
 let result;
 try {result=await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize);}
 finally {await Promise.all(jobs);f.backend.create=create;}
 assert.equal(result.phase,'planned');assert.equal(result.applyAllowed,true);assert.equal(result.embed,null);
 assert.equal(f.writes(),0);assert.equal(f.files.size,0);
 const after=f.journal.get(p.planRef.slice(7));
 assert.equal(after.nextContent,before.nextContent);assert.equal(after.requestDigest,before.requestDigest);
 assert.equal(after.executionOwner,undefined);
 f.restart();assert.equal((await f.adapter.status(p.planRef)).phase,'planned');
 assert.equal((await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize)).outcome,'committed');
 assert.equal(f.writes(),1);assert.equal(f.converts(),1);
}));

test('unverified worker errors cannot claim a safe pre-dispatch retry by reason alone',()=>fixture(async f=>{
 const p=await f.adapter.plan(makeInput(),f.source,f.authorize);
 f.backend.create=async()=>{f.files.set('diagram.webp',Buffer.from([1]));throw new AssetWorkerError('asset_worker_busy');};
 const result=await f.adapter.apply(p.planRef,makeInput().idempotencyKey,f.source,f.authorize);
 assert.equal(result.outcome,'outcome_unknown');assert.equal(result.applyAllowed,false);
 assert.equal((await f.adapter.status(p.planRef)).outcome,'outcome_unknown');
}));
