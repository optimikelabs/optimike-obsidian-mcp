import assert from 'node:assert/strict';
process.env.OBSIDIAN_RUNTIME_MODE='headless-readonly';process.env.OBSIDIAN_VAULT=process.cwd();process.env.SEMANTIC_SEARCH_PREWARM='false';
const {collectCapabilityManifest}=await import('../dist/services/capabilityManifest.js');
const late=()=>new Promise(r=>setTimeout(()=>r({ok:true,authenticated:true}),3000));
const manifest=await collectCapabilityManifest({profile:'full',registrationMode:'live',runtimeStatus:{semanticCache:{enabled:false},sharedCache:{ready:true}},obsidianService:undefined,vaultCacheAvailable:true,governedRuntimes:{note:true,canvas:true,base:true,asset:false},probes:{localRest:late,atomicWrite:late,baseAtomicWrite:late,operon:late}});
for(const [id,reason] of [['local-rest','local_rest_probe_timed_out'],['governed-note-write','bridge_probe_timed_out'],['governed-base-write','bridge_probe_timed_out'],['operon-read','bridge_probe_timed_out']]){
 const c=manifest.capabilities.find(x=>x.id===id);assert.equal(c.reasonCode,reason);assert.equal(c.nextAction,'retry_capability_probe');assert.equal(c.available,false);assert.equal(c.authorized,false);
}
const before=JSON.stringify(manifest);await new Promise(r=>setTimeout(r,600));assert.equal(JSON.stringify(manifest),before);
console.log('PASS actual simultaneous REST/Bridge/Operon probe deadlines retain negative receipts after late completion');
