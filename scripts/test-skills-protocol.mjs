import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {McpServer,Server,createMcpHandler,ProtocolError} from '@modelcontextprotocol/server';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {ExternalRootsService} from '../dist/services/externalRootsService.js';
import {SkillRegistry} from '../dist/services/skills/skillRegistry.js';
const root=await mkdtemp(path.join(os.tmpdir(),'optimike-skills-wire-'));
Object.assign(process.env,{OBSIDIAN_RUNTIME_MODE:'headless-readonly',OBSIDIAN_VAULT:root,MCP_WRITE_MODE:'readonly'});
const {installSkillsExtension,ListSkillsClientResultSchema,GetSkillClientResultSchema,SKILLS_EXTENSION_ID}=await import('../dist/mcp-server/resources/skillsExtension.js');
const uri='skill://fixtures/sample/SKILL.md';
const raw=Buffer.from('\ufeff---\r\nname: sample\r\ndescription: SDK fixture\r\nmetadata:\n  version: "1"\r\ncustom: {enabled: true}\r\n---\r\n[ref](references/info.md)\r\n');
await mkdir(path.join(root,'sample/references'),{recursive:true});await writeFile(path.join(root,'sample/SKILL.md'),raw);await writeFile(path.join(root,'sample/references/info.md'),'Supporting instructions.');
const roots=ExternalRootsService.fromConfig({version:1,roots:[{id:'fixtures',path:root,capabilities:['visible','readable']}]});
const registry=new SkillRegistry(roots,{version:1,skills:[{rootId:'fixtures',path:'sample'}]},'full');
let checks=0;
try{
 for(const standalone of [false,true]){
  const handler=createMcpHandler(()=>{
   if(standalone){const server=new Server({name:'skills-proxy-fixture',version:'1'});installSkillsExtension(server,registry);return server;}
   const mcp=new McpServer({name:'skills-fixture',version:'1'});
   installSkillsExtension(mcp.server,registry,{deferResourceRead:true});
   mcp.registerResource('existing','optimike://existing',{mimeType:'text/plain'},async()=>({contents:[{uri:'optimike://existing',text:'Existing resource unchanged.'}]}));
   return mcp;
  },{legacy:'reject'});
  const client=new Client({name:'skills-client',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  const wire=[];
  const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{fetch:async(url,init)=>{
   const response=await handler.fetch(new Request(url,init));
   wire.push(JSON.parse(await response.clone().text()));
   return response;
  }});
  try{
   await client.connect(transport);assert.equal(client.getProtocolEra(),'modern');assert.ok(client.getServerCapabilities().resources);assert.deepEqual(client.getServerCapabilities().extensions[SKILLS_EXTENSION_ID],{});checks++;
   const list=await client.request({method:'skills/list',params:{}},ListSkillsClientResultSchema);assert.equal(wire.at(-1).result.resultType,'complete');assert.equal(list.ttlMs,0);assert.equal(list.cacheScope,'private');assert.equal(list.skills.length,1);checks++;
   const get=await client.request({method:'skills/get',params:{uri}},GetSkillClientResultSchema);assert.deepEqual(get.skill,list.skills[0]);assert.equal(get.skill.frontmatter.custom.enabled,true);checks++;
   const bytes=await client.readResource({uri});assert.deepEqual(Buffer.from(bytes.contents[0].text),raw);assert.equal(wire.at(-1).result.resultType,'complete');assert.equal(bytes.cacheScope,'private');assert.equal(bytes.ttlMs,0);checks++;
   const entry=get.skill.resources.find(r=>r.uri===uri);assert.equal(entry.size,raw.length);assert.equal(entry.digest,'sha256:'+createHash('sha256').update(raw).digest('hex'));checks++;
   assert.equal((await client.readResource({uri:'skill://fixtures/sample/references/info.md'})).contents[0].text,'Supporting instructions.');checks++;
   if(!standalone){assert.equal((await client.readResource({uri:'optimike://existing'})).contents[0].text,'Existing resource unchanged.');assert.equal((await client.listResources()).resources.length,1);checks++;}
   else {assert.deepEqual((await client.listResources()).resources,[]);checks++;}
   for(const bad of ['skill://fixtures/sample/../sample/SKILL.md','skill://fixtures/sample/%53KILL.md','skill://fixtures/sample/SKILL.md?PRIVATE_SENTINEL','skill://fixtures/missing/PRIVATE_SENTINEL']){
    await assert.rejects(()=>client.readResource({uri:bad}),e=>e instanceof ProtocolError&&!JSON.stringify(e).includes('PRIVATE_SENTINEL')&&!e.message.includes(root));checks++;
   }
   for(const params of [{uri:17,PRIVATE_SENTINEL:'secret'},{uri},{uri:'skill://fixtures/PRIVATE_SENTINEL/SKILL.md'}]){
    if(params.uri===uri)continue;
    await assert.rejects(()=>client.request({method:'skills/get',params},GetSkillClientResultSchema),e=>e instanceof ProtocolError&&!e.message.includes('PRIVATE_SENTINEL'));checks++;
   }
   await assert.rejects(()=>client.request({method:'skills/list',params:{cursor:'PRIVATE_SENTINEL'}},ListSkillsClientResultSchema),e=>!e.message.includes('PRIVATE_SENTINEL'));checks++;
   await assert.rejects(()=>client.request({method:'resources/directory/read',params:{uri}},ListSkillsClientResultSchema),e=>e.code===-32601 || JSON.parse(e.data?.text ?? '{}').error?.code===-32601);checks++;
   for(const frame of wire.filter(frame=>frame.result?.skills || frame.result?.skill || frame.result?.contents)){
    assert.equal(frame.result.resultType,'complete');assert.equal(frame.result.ttlMs,0);assert.equal(frame.result.cacheScope,'private');
   }
  }finally{await client.close();await handler.close();}
 }
 console.log(`PASS: ${checks} official SDK Skills wire/capabilities, exact manifests/resources and privacy checks`);
}finally{await rm(root,{recursive:true,force:true});}
