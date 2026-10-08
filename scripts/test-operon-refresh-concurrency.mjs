import assert from 'node:assert/strict';
process.env.OBSIDIAN_API_KEY='test-no-network';
process.env.OBSIDIAN_RUNTIME_MODE='hybrid';
process.env.MCP_WRITE_MODE='readonly';
const {OperonService}=await import('../dist/services/operon/service.js');
for(const drift of [false,true]){
 const service=new OperonService(),status={index:{generation:1},settingsSignature:'fixed'};
 let release,commits=0,overlapped=false;
 service.fetchAllLiveTasks=()=>new Promise(resolve=>{release=()=>resolve({tasks:[],settledStatus:status});});
 service.fetchLiveConfiguration=async()=>{overlapped=!!release;release?.();return{settingsSignature:drift?'drift':'fixed'};};
 service.fetchLiveValidation=async()=>({generation:1,settingsSignature:'fixed',ok:true,summary:{P0:0}});
 service.fetchLiveStatus=async()=>status;
 service.assertStableStatus=()=>{};
 service.saveSnapshot=()=>commits++;
 service.loadSnapshot=()=>({source:'operon-live'});
 const timeout=setTimeout(()=>{release?.();},1000);
 try{
  if(drift)await assert.rejects(()=>service.refreshLiveSnapshot(status),/configuration changed/);
  else assert.equal((await service.refreshLiveSnapshot(status)).source,'operon-live');
  assert.equal(overlapped,true,'Configuration must start before task pages finish');
  assert.equal(commits,drift?0:1,'Configuration drift must prevent any snapshot commit');
 }finally{clearTimeout(timeout);}
}
console.log('PASS Operon concurrent independent reads and configuration-drift fence');
