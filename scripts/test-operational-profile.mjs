import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
const root=await mkdtemp(path.join(os.tmpdir(),'operational-profile-'));
process.env.OBSIDIAN_RUNTIME_MODE='headless-readonly';process.env.OBSIDIAN_VAULT=root;process.env.MCP_LOG_LEVEL='error';process.env.SEMANTIC_SEARCH_PREWARM='false';
const {compileToolProfileNames,selectAvailableToolProfileNames}=await import('../dist/mcp-server/toolProfiles.js');
const {installToolProfileRegistrationGate}=await import('../dist/mcp-server/toolProfileRuntime.js');
const {registerObsidianGetFrontmatterTool}=await import('../dist/mcp-server/tools/obsidianGetFrontmatterTool/registration.js');
const {registerObsidianManageFrontmatterTool}=await import('../dist/mcp-server/tools/obsidianManageFrontmatterTool/registration.js');
const {mcpSchema}=await import('../dist/mcp-server/mcpSchema.js');
const full=compileToolProfileNames({profile:'full',registrationMode:'live'}),operational=compileToolProfileNames({profile:'operational',registrationMode:'live'});
assert.deepEqual(full.filter(x=>!operational.includes(x)).sort(),['bases_upsert_config','obsidian_manage_frontmatter','obsidian_search_replace','obsidian_update_note']);
for(const name of ['obsidian_get_frontmatter','obsidian_manage_tags','bases_upsert_rows','external_read','external_move_status','operon_update_task','obsidian_runtime_maintenance'])assert.ok(operational.includes(name),name);
assert.deepEqual(selectAvailableToolProfileNames({profile:'operational',availableNames:full}),operational);
const partial=full.filter(x=>x!=='obsidian_frontmatter_patch_recover');
const during=selectAvailableToolProfileNames({profile:'operational',availableNames:partial});assert.ok(during.includes('obsidian_manage_frontmatter'));assert.ok(!during.some(x=>x.startsWith('obsidian_frontmatter_patch_')));
let writes=0,reads=0,directCalls=0;
const api={getFileContent:async()=>{reads++;return {frontmatter:{status:'Actif',custom:{nested:[1,'é ✅',false]}}};},patchFile:async()=>{writes++;throw new Error('must not write');},updateFileContent:async()=>{writes++;throw new Error('must not write');}};
async function exercise(profile){
 const server=new McpServer({name:'operational-profile-test',version:'1'},{capabilities:{tools:{}}});installToolProfileRegistrationGate(server,profile);
 await registerObsidianManageFrontmatterTool(server,api,undefined);registerObsidianGetFrontmatterTool(server,api);
 for(const name of full.filter(x=>!['obsidian_get_frontmatter','obsidian_manage_frontmatter'].includes(x)))server.registerTool(name,{inputSchema:mcpSchema({})},async()=>{if(['obsidian_update_note','obsidian_search_replace','bases_upsert_config'].includes(name))directCalls++;return {content:[{type:'text',text:'{}'}]};});
 const [ct,st]=InMemoryTransport.createLinkedPair(),client=new Client({name:'operational-profile-client',version:'1'});await server.connect(st);await client.connect(ct);
 try{
  const catalog=(await client.listTools()).tools;assert.equal(catalog.find(x=>x.name==='obsidian_get_frontmatter').annotations.readOnlyHint,true);
  const read=await client.callTool({name:'obsidian_get_frontmatter',arguments:{filePath:'Fixture.md',key:'custom'}});assert.deepEqual(JSON.parse(read.content[0].text).value,{nested:[1,'é ✅',false]});
  const bad=await client.callTool({name:'obsidian_get_frontmatter',arguments:{filePath:'Fixture.md',key:'status',operation:'set',value:'Wrong'}}).catch(()=>({isError:true}));assert.ok(bad.isError);assert.equal(writes,0);
  if(profile==='operational'){
   for(const name of ['obsidian_update_note','obsidian_search_replace','obsidian_manage_frontmatter','bases_upsert_config']){
    assert.ok(!catalog.some(x=>x.name===name));const r=await client.callTool({name,arguments:{}}).catch(()=>({isError:true}));assert.ok(r.isError,'hidden name cannot be invoked: '+name);
   }
  }else{const legacy=await client.callTool({name:'obsidian_manage_frontmatter',arguments:{filePath:'Fixture.md',key:'status',operation:'get'}});assert.equal(JSON.parse(legacy.content[0].text).value,'Actif');assert.ok(catalog.some(x=>x.name==='obsidian_update_note'));}
 }finally{await client.close();await server.close();}
}
try{await exercise('operational');await exercise('full');assert.equal(directCalls,0);assert.equal(writes,0);assert.equal(reads,3);console.log('PASS operational/full separation, hidden-call refusal, readonly frontmatter and distinct capability preservation');}
finally{await rm(root,{recursive:true,force:true});}
