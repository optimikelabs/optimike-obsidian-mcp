import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {test,after} from "node:test";
import {McpServer,InMemoryTransport} from "@modelcontextprotocol/server";
import {Client} from "@modelcontextprotocol/client";
import sharp from "sharp";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"optimike-asset-surface-"));
Object.assign(process.env,{NODE_ENV:"test",OBSIDIAN_RUNTIME_MODE:"live",OBSIDIAN_API_KEY:"fixture-not-a-secret",OBSIDIAN_VAULT:root,MCP_LOG_DIR:path.join(root,"logs"),MCP_WRITE_MODE:"full"});
const {config}=await import("../dist/config/index.js");
const {registerAssetImportTools}=await import("../dist/mcp-server/tools/assetImportTools/registration.js");
const {AssetImportOperationAdapter}=await import("../dist/services/assets/assetImportOperation.js");
const {ObsidianNoteReplaceJournal}=await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const {ExternalRootsService}=await import("../dist/services/externalRootsService.js");
const {runAssetJob}=await import("../dist/services/assets/workerClient.js");
const {assetHash}=await import("../dist/services/assets/windowsAssetFiles.js");
const {installToolProfileRegistrationGate}=await import("../dist/mcp-server/toolProfileRuntime.js");
const {compileToolNames}=await import("../dist/mcp-server/toolSurfaceRegistry.js");
const names=["asset_import_apply","asset_import_plan","asset_import_status"];
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const value=r=>JSON.parse(r.content[0].text);

for (const name of ["asset_import_status","asset_import_apply"]) {
 test(name+" rejects unauthenticated and development HTTP identities before receipt inspection",async()=>{
  const handlers=new Map();let called=0;
  const runtime={status:async()=>{called++;return {outcome:"committed",postflight:{status:"verified"}};},apply:async()=>{called++;return {outcome:"committed",postflight:{status:"verified"}};}};
  await registerAssetImportTools({registerTool:(n,_d,h)=>handlers.set(n,h)},runtime,undefined,false);
  for(const authInfo of [undefined,{token:"dev-mode-placeholder-token",clientId:"dev-client-id",scopes:["external:read"]},{token:"real",clientId:"real",scopes:[]}]) {
   const response=await handlers.get(name)({planRef:"oasset:11111111-1111-4111-8111-111111111111",idempotencyKey:"fixture-key"},{http:{authInfo}});
   assert.equal(response.isError,true);assert.equal(called,0);
  }
 });
}

test("configured asset family is opt-in, complete, live-only and absent from default registry surface",()=>{
 for(const mode of ["live","hybrid-live"]) {
  assert.equal(compileToolNames({registrationMode:mode}).length,87);
  const configured=compileToolNames({registrationMode:mode,availableStaticRequirements:["vault-cache","asset-policy"]});
  assert.equal(configured.length,90);assert.deepEqual(configured.filter(n=>n.startsWith("asset_import_")),names);
 }
 for(const mode of ["hybrid-degraded","headless-readonly","headless-guarded","headless-filesystem"])assert.equal(compileToolNames({registrationMode:mode,availableStaticRequirements:["vault-cache","asset-policy"]}).some(n=>names.includes(n)),false);
});

for(const profile of ["standard","authoring","tasks","full"])test(profile+" exposes only the authorized asset family",async()=>{
 const server=new McpServer({name:"assets-fixture",version:"1"}),client=new Client({name:"assets-fixture",version:"1"});
 installToolProfileRegistrationGate(server,profile);
 let calls=0;const runtime={status:async()=>{calls++;return {outcome:null};}};
 const [ct,st]=InMemoryTransport.createLinkedPair();
 try {await registerAssetImportTools(server,runtime,undefined,true);await server.connect(st);await client.connect(ct);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),profile==="full"?names:[]);
  if(profile!=="full") {try{const r=await client.callTool({name:"asset_import_status",arguments:{planRef:"oasset:11111111-1111-4111-8111-111111111111"}});assert.equal(r.isError,true);}catch{}assert.equal(calls,0);}
 }finally{await client.close();await server.close();}
});

test("actual MCP to authorized source, conversion, NTFS exclusive creation and durable receipt",{skip:process.platform!=="win32"||process.arch!=="x64"},async()=>{
 const vault=path.join(root,"vault"),sourceRoot=path.join(root,"source");fs.mkdirSync(vault);fs.mkdirSync(sourceRoot);fs.mkdirSync(path.join(vault,"Images"));
 const png=await sharp({create:{width:4,height:3,channels:4,background:{r:20,g:30,b:40,alpha:0.5}}}).png().toBuffer();
 fs.writeFileSync(path.join(sourceRoot,"input.png"),png);
 const roots=ExternalRootsService.fromConfig({version:1,roots:[{id:"fixture.images",path:sourceRoot,capabilities:["visible","readable","handoff"],include:["**/*.png"],exclude:["secret/**"]}]});
 const journal=new ObsidianNoteReplaceJournal(path.join(root,"plans.sqlite"));
 const policy={vaultRoot:vault,assetFolder:"Images",quality:75};let creates=0;
 const runtime=new AssetImportOperationAdapter({inspect:(filename,binding)=>runAssetJob({kind:"inspect",...policy,filename,binding}),create:(filename,bytes,binding)=>{creates++;return runAssetJob({kind:"create",...policy,filename,bytes,binding});}},journal,policy);
 const server=new McpServer({name:"assets-native-fixture",version:"1"}),client=new Client({name:"assets-native-fixture",version:"1"});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 const input={source:{rootId:"fixture.images",relativePath:"input.png",sha256:assetHash(png)},name:"diagram",idempotencyKey:"asset-mcp-fixture"};
 const call=(name,args)=>client.callTool({name,arguments:args});
 try {
  await registerAssetImportTools(server,runtime,roots,true);await server.connect(st);await client.connect(ct);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.find(t=>t.name==="asset_import_status").annotations.readOnlyHint,true);
  assert.equal(tools.find(t=>t.name==="asset_import_plan").annotations.readOnlyHint,false);
  config.assetImportEnabled=false;assert.equal((await call("asset_import_plan",input)).isError,true);
  config.assetImportEnabled=true;config.mcpWriteMode="readonly";assert.equal((await call("asset_import_plan",input)).isError,true);config.mcpWriteMode="full";
  assert.equal(creates,0);assert.deepEqual(fs.readdirSync(path.join(vault,"Images")),[]);
  const planned=await call("asset_import_plan",input);assert.equal(planned.isError,false);const p=value(planned);
  assert.equal(p.phase,"planned");assert.equal(p.embed,null);assert.equal(p.asset.width,4);assert.equal(p.asset.height,3);assert.equal(p.asset.format,"webp");
  assert.equal(creates,0);assert.deepEqual(fs.readdirSync(path.join(vault,"Images")),[]);

  const args={planRef:p.planRef,idempotencyKey:input.idempotencyKey};
  const applied=await call("asset_import_apply",args);assert.equal(applied.isError,false);const a=value(applied);
  assert.equal(a.outcome,"committed");assert.equal(a.postflight.status,"verified");assert.equal(a.embed,"![[Images/diagram.webp]]");assert.equal(creates,1);
  const file=path.join(vault,"Images","diagram.webp");assert.equal(assetHash(fs.readFileSync(file)),a.asset.sha256);
  assert.equal((await call("asset_import_apply",args)).isError,false);assert.equal(creates,1);
  assert.equal(value(await call("asset_import_status",{planRef:p.planRef})).postflight.status,"verified");
  assert.equal((await call("asset_import_plan",{...input,idempotencyKey:"new-collision-key"})).isError,true);assert.equal(creates,1);
  fs.writeFileSync(file,"external-drift");const drift=await call("asset_import_status",{planRef:p.planRef});assert.equal(drift.isError,true);assert.equal(value(drift).embed,null);assert.equal(creates,1);
  assert.deepEqual(fs.readdirSync(vault),["Images"]);assert.equal(assetHash(fs.readFileSync(path.join(sourceRoot,"input.png"))),assetHash(png));
 }finally {await client.close();await server.close();journal.close();config.assetImportEnabled=false;}
});
