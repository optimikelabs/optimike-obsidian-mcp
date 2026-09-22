import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ExternalRootsService} from '../dist/services/externalRootsService.js';
import {SkillRegistry,SkillRegistryError,readSkillsPublicationConfig} from '../dist/services/skills/skillRegistry.js';
const root=await mkdtemp(path.join(os.tmpdir(),'optimike-skills-registry-'));
const roots=ExternalRootsService.fromConfig({version:1,roots:[{id:'local.skills',path:root,capabilities:['visible','readable']}]});
const pub=p=>({rootId:'local.skills',path:p});
const uri=p=>`skill://local.skills/${p}/SKILL.md`;
const config=skills=>({version:1,pageSize:1,skills});
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
let checks=0;
async function put(p,body='Workflow.',fields=''){
 await mkdir(path.join(root,p),{recursive:true});
 await writeFile(path.join(root,p,'SKILL.md'),`---\nname: ${p.split('/').at(-1)}\ndescription: Fixture for ${p}\nmetadata:\n  version: "1"\n${fields}---\n${body}\n`);
}
async function reject(work,reason){await assert.rejects(work,e=>e instanceof SkillRegistryError&&(!reason||e.reason===reason)&&!e.message.includes(root));checks++;}
try{
 // A fully authorized rich skill remains a byte manifest, never an executable.
 await put('rich');
 const marker=path.join(root,'EXECUTED');
 const script=`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("EXECUTED")\n`;
 await writeFile(path.join(root,'rich/.gitattributes'),'*.md text eol=lf\r\n');
 await writeFile(path.join(root,'rich/support.py'),script);
 await writeFile(path.join(root,'rich/support.json'),'{"passive":true}\n');
 const richRoots=ExternalRootsService.fromConfig({version:1,roots:[{id:'local.skills',path:root,capabilities:['visible','readable'],include:['rich/SKILL.md','rich/.gitattributes','rich/support.py','rich/support.json']}]});
 const richRegistry=new SkillRegistry(richRoots,config([pub('rich')]),'full');
 const listedRich=(await richRegistry.list()).skills[0];
 assert.equal(listedRich.resources.length,4);
 assert.deepEqual((await richRegistry.get(uri('rich'))).skill,listedRich);
 for(const resource of listedRich.resources){
  const bytes=await readFile(path.join(root,'rich',resource.uri.split('/').at(-1)));
  assert.equal(resource.digest,hash(bytes));assert.equal(resource.size,bytes.length);
  const item=(await richRegistry.read(resource.uri)).contents[0];
  assert.deepEqual(item.text===undefined?Buffer.from(item.blob,'base64'):Buffer.from(item.text),bytes);
 }
 await assert.rejects(readFile(marker),e=>e.code==='ENOENT');checks++;
 // Even an explicit root permission cannot waive the Skills sensitive-file policy.
 await writeFile(path.join(root,'rich/.npmrc'),'AUTH_SENTINEL');
 const forbiddenRoots=ExternalRootsService.fromConfig({version:1,roots:[{id:'local.skills',path:root,capabilities:['visible','readable'],include:['rich/**','rich/.gitattributes','rich/.npmrc']}]});
 const forbidden=new SkillRegistry(forbiddenRoots,config([pub('rich')]),'full');
 assert.deepEqual((await forbidden.list()).skills,[]);
 await reject(()=>forbidden.get(uri('rich')),'source_denied');
 await rm(path.join(root,'rich/.npmrc'));
 await put('one','[Reference](references/éclairage%20%231.md) ![asset](assets/raw.bin)','custom:\n  enabled: true\n');
 await mkdir(path.join(root,'one/references'));await mkdir(path.join(root,'one/assets'));
 await writeFile(path.join(root,'one/references/éclairage #1.md'),Buffer.from('\ufeffReference\r\n'));
 await writeFile(path.join(root,'one/assets/raw.bin'),Buffer.from([0,255,128,42]));
 await put('two');await put('hidden');await put('team/one');await put('private');
 const cfg=config([pub('one'),pub('two'),{...pub('hidden'),listed:false},pub('team/one'),{...pub('private'),profiles:['tasks']}]);
 const r=new SkillRegistry(roots,cfg,'full');
 const page=await r.list();assert.equal(page.skills.length,1);assert.equal(page.resultType,'complete');assert.equal(page.ttlMs,0);assert.equal(page.cacheScope,'private');assert.ok(page.nextCursor);checks++;
 let next=page,entries=[...page.skills];
 while(next.nextCursor){next=await r.list(next.nextCursor);entries.push(...next.skills);}
 assert.deepEqual(entries.map(x=>x.uri),[uri('one'),uri('team/one'),uri('two')]);checks++;
 const first=(await r.get(uri('one'))).skill;assert.deepEqual(first,page.skills[0]);assert.equal(first.frontmatter.custom.enabled,true);checks++;
 for(const entry of first.resources){
  const relative=decodeURIComponent(entry.uri.slice('skill://local.skills/one/'.length));
  const bytes=await readFile(path.join(root,'one',relative));
  assert.equal(entry.digest,hash(bytes));assert.equal(entry.size,bytes.length);
  const result=await r.read(entry.uri);assert.equal(result.resultType,'complete');assert.equal(result.ttlMs,0);assert.equal(result.cacheScope,'private');
  const c=result.contents[0];assert.equal(c.uri,entry.uri);
  assert.deepEqual(c.text===undefined?Buffer.from(c.blob,'base64'):Buffer.from(c.text,'utf8'),bytes);checks++;
 }
 assert.equal(first.resources.length,3);assert.equal(first.resources.find(x=>x.uri===first.uri).digest,hash(await readFile(path.join(root,'one/SKILL.md'))));checks++;
 assert.equal((await r.get(uri('hidden'))).skill.uri,uri('hidden'));checks++;
 assert.equal((await r.get(uri('team/one'))).skill.frontmatter.name,'one');checks++;
 for(const p of ['standard','authoring']){assert.deepEqual((await new SkillRegistry(roots,cfg,p).list()).skills,[]);checks++;}
 const tasks=new SkillRegistry(roots,cfg,'tasks');assert.deepEqual((await tasks.list()).skills.map(x=>x.uri),[uri('private')]);checks++;
 await reject(()=>r.get(uri('private')),'not_found');await reject(()=>r.read(uri('private')),'not_found');await reject(()=>tasks.get(uri('one')),'not_found');
 const empty=new SkillRegistry(roots,config([]),'full');assert.deepEqual((await empty.list()).skills,[]);checks++;
 for(const cursor of ['../escape','PRIVATE_SENTINEL','',Buffer.from('["wrong",1]').toString('base64url')])await reject(()=>r.list(cursor),'cursor_invalid');
 await reject(()=>tasks.list(page.nextCursor),'cursor_invalid');
 await reject(()=>new SkillRegistry(roots,{...cfg,pageSize:2},'full').list(page.nextCursor),'cursor_invalid');
 for(const target of [
  'file:///etc/passwd',uri('missing'),uri('one').replace('local.skills','other'),
  'skill://local.skills/one/../two/SKILL.md','skill://local.skills/one/%2e%2e/two/SKILL.md',
  'skill://local.skills/one/%53KILL.md','skill://local.skills/one/SKILL.md?x=1',
  'skill://local.skills/one/SKILL.md#part','skill://local.skills/one//SKILL.md',
  'skill://local.skills/one/assets%2fraw.bin','skill://local.skills/one/SKILL.md/extra',
  'SKILL://local.skills/one/SKILL.md','skill://local.skills/one/references/éclairage #1.md',
 ])await reject(()=>r.read(target));
 await reject(()=>r.get('skill://local.skills/one/assets/raw.bin'),'not_found');
 const before=(await r.get(uri('two'))).skill;
 await writeFile(path.join(root,'two/SKILL.md'),'---\nname: two\ndescription: Changed\n---\nNew bytes\n');
 const read=(await r.read(uri('two'))).contents[0];assert.notEqual(hash(Buffer.from(read.text)),before.resources[0].digest);checks++;
 const after=(await r.get(uri('two'))).skill;assert.equal(after.resources[0].digest,hash(Buffer.from(read.text)));checks++;
 await writeFile(path.join(root,'two/new.txt'),'new file');assert.equal((await r.get(uri('two'))).skill.resources.length,2);checks++;
 await rm(path.join(root,'two/new.txt'));await reject(()=>r.read('skill://local.skills/two/new.txt'),'not_found');
 await writeFile(path.join(root,'two/.env'),'PRIVATE_SECRET');await reject(()=>r.get(uri('two')));await reject(()=>r.read(uri('two')));assert.equal((await r.list(page.nextCursor)).skills[0].uri,uri('team/one'));checks++;await rm(path.join(root,'two/.env'));
 await put('invalid','Text','metadata: duplicate\n');
 const mixed=new SkillRegistry(roots,config([pub('invalid'),pub('one'),pub('missing')]),'full');
 const audit=await mixed.audit();assert.equal(audit.filter(x=>x.state==='refused').length,2);assert.equal(JSON.stringify(audit).includes(root),false);checks++;
 assert.deepEqual((await mixed.list()).skills.map(x=>x.uri),[uri('one')]);checks++;
 await reject(()=>mixed.get(uri('invalid')),'frontmatter_invalid');
 const duplicate=config([pub('one'),pub('one')]);assert.throws(()=>new SkillRegistry(roots,duplicate,'full'),SkillRegistryError);checks++;
 for(const bad of [null,{},config([{rootId:'local.skills',path:'../one'}]),config([{...pub('one'),profiles:['new-profile']}]),{...cfg,pageSize:11},{...cfg,unknown:true},config(Array.from({length:65},(_,i)=>pub('n'+i)))]){assert.throws(()=>new SkillRegistry(roots,bad,'full'),SkillRegistryError);checks++;}
 // Nested files are ordinary parent supporting content; get requires a separate publication.
 await put('outer');await put('outer/inner');
 const nested=new SkillRegistry(roots,config([pub('outer')]),'full');
 const parent=(await nested.get(uri('outer'))).skill;assert.equal(parent.resources.length,2);checks++;
 await nested.read(uri('outer/inner'));await reject(()=>nested.get(uri('outer/inner')),'not_found');
 const nestedPublished=new SkillRegistry(roots,config([pub('outer'),pub('outer/inner')]),'full');
 assert.equal((await nestedPublished.get(uri('outer/inner'))).skill.frontmatter.name,'inner');checks++;
 // An invalid nested publication must not shadow valid parent supporting content.
 await writeFile(path.join(root,'outer/inner/SKILL.md'),'---\nname: different\ndescription: Supporting content\n---\nNested support\n');
 const supporting=(await nestedPublished.get(uri('outer'))).skill.resources.find(x=>x.uri===uri('outer/inner'));
 assert.ok(supporting);
 const supportingRead=(await nestedPublished.read(supporting.uri)).contents[0];
 assert.equal(hash(Buffer.from(supportingRead.text)),supporting.digest);checks++;
 await reject(()=>nestedPublished.get(uri('outer/inner')),'frontmatter_invalid');
 const nestedOnly=new SkillRegistry(roots,config([pub('outer/inner')]),'full');
 await reject(()=>nestedOnly.read(uri('outer/inner')),'not_found');
 // A forbidden member still rejects the complete enclosing snapshot as well.
 await writeFile(path.join(root,'outer/inner/.env'),'PRIVATE_SECRET');
 await reject(()=>nestedPublished.read(uri('outer/inner')),'not_found');
 await reject(()=>nestedPublished.get(uri('outer')),'source_denied');
 await rm(path.join(root,'outer/inner/.env'));
 const file=path.join(root,'publication.json');await writeFile(file,JSON.stringify(cfg));assert.deepEqual(await readSkillsPublicationConfig(file),cfg);checks++;
 await reject(()=>readSkillsPublicationConfig('relative.json'),'configuration_invalid');
 await writeFile(file,'x'.repeat(65537));await reject(()=>readSkillsPublicationConfig(file),'configuration_invalid');
 await writeFile(file,'{bad JSON PRIVATE}');await reject(()=>readSkillsPublicationConfig(file),'configuration_invalid');
 await reject(()=>readSkillsPublicationConfig(root),'configuration_invalid');
 const linked=path.join(root,'linked-config');await symlink(root,linked,process.platform==='win32'?'junction':'dir');await reject(()=>readSkillsPublicationConfig(linked),'configuration_invalid');
 console.log(`PASS: ${checks} Skills registry, complete manifest, exact bytes, pagination, publication/profile and freshness checks`);
}finally{await rm(root,{recursive:true,force:true});}
