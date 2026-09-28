import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { WindowsAssetFiles, assetFilename, AssetFileError, assetHash } from '../dist/services/assets/windowsAssetFiles.js';
const supported=process.platform==='win32'&&process.arch==='x64';
const bytes=Buffer.from([0,255,1,128,2]);
function fixture(body) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'optimike-native-asset-'));
 fs.mkdirSync(path.join(root,'Images'));
 const backend=new WindowsAssetFiles(root,'Images');
 try { return body({root,backend}); } finally {fs.rmSync(root,{recursive:true,force:true});}
}
test('asset names reject traversal device names ADS and embed syntax',()=>{
 for(const p of ['../a.png','a/b.png','a\\b.png','CON.png','nul.jpg','x.png:stream','a#.png','a].png','a.js','.hidden.png','a.png '])assert.throws(()=>assetFilename(p));
 assert.equal(assetFilename('image-\u00c9LYSIA.webp'),'image-\u00c9LYSIA.webp');
});
test('unsupported platform cannot fall back to absolute-path creation', {skip:supported},()=>{
 const b=new WindowsAssetFiles('C:\\Fixture','Images');
 assert.throws(()=>b.inspect('a.png'),e=>e instanceof AssetFileError&&e.reason==='unsupported_platform');
});
test('native absent-only creation verifies exact binary bytes and refuses existing target', {skip:!supported},()=>fixture(({root,backend})=>{
 const before=backend.inspect('a.png'); assert.equal(before.exists,false);
 const result=backend.create('a.png',bytes,before.binding); assert.equal(result.sha256,assetHash(bytes));
 assert.deepEqual(fs.readFileSync(path.join(root,'Images/a.png')),bytes);
 assert.throws(()=>backend.create('a.png',Buffer.from('other'),before.binding),e=>e.reason==='asset_exists');
 assert.equal(backend.inspect('a.png',before.binding).sha256,result.sha256);
}));
test('native parent handles deny replacement while creation is in progress', {skip:!supported},()=>fixture(({root,backend})=>{
 const before=backend.inspect('a.png'); let denied=false;
 backend.create('a.png',bytes,before.binding,()=>{
   try {fs.renameSync(path.join(root,'Images'),path.join(root,'moved'));} catch {denied=true;}
 });
 assert.equal(denied,true); assert.deepEqual(fs.readFileSync(path.join(root,'Images/a.png')),bytes);
}));
test('a junction parent and a changed parent identity are refused', {skip:!supported},()=>fixture(({root,backend})=>{
 const before=backend.inspect('a.png');
 fs.renameSync(path.join(root,'Images'),path.join(root,'old'));
 fs.mkdirSync(path.join(root,'Images'));
 assert.throws(()=>backend.create('a.png',bytes,before.binding),e=>e.reason==='asset_binding_conflict');
 fs.rmdirSync(path.join(root,'Images')); fs.mkdirSync(path.join(root,'outside'));
 fs.symlinkSync(path.join(root,'outside'),path.join(root,'Images'),'junction');
 assert.throws(()=>backend.inspect('a.png'));
 assert.equal(fs.existsSync(path.join(root,'outside/a.png')),false);
}));
test('existing hardlinks are not imported as verified private assets', {skip:!supported},()=>fixture(({root,backend})=>{
 fs.writeFileSync(path.join(root,'source.png'),bytes); fs.linkSync(path.join(root,'source.png'),path.join(root,'Images/a.png'));
 assert.throws(()=>backend.inspect('a.png'),e=>e.reason==='asset_invalid_file');
}));


test('separate processes racing on one destination produce exactly one file creation', {skip:!supported}, async()=>{
 const {spawn}=await import('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'optimike-native-race-'));
 fs.mkdirSync(path.join(root,'Images'));
 const backend=new WindowsAssetFiles(root,'Images'); const binding=backend.inspect('race.png').binding;
 const children=[];
 const script="const {WindowsAssetFiles}=await import(process.argv[1]); const b=new WindowsAssetFiles(process.argv[2],'Images'); console.log('READY'); process.stdin.once('data',()=>{try{b.create('race.png',Buffer.from([0,255,1]),process.argv[3]);console.log('created');}catch(e){console.log(e.reason??'unexpected');}process.stdin.destroy();});";
 try {
  const module=new URL('../dist/services/assets/windowsAssetFiles.js',import.meta.url).href;
  const launch=()=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['--input-type=module','-e',script,module,root,binding],{stdio:['pipe','pipe','pipe']}); children.push(p);
    let out='',err=''; p.stdout.on('data',c=>{out+=c; if(out.includes('READY'))resolve({p,done:new Promise((r,j)=>{p.once('exit',code=>code===0?r(out.trim().split(/\r?\n/).at(-1)):j(new Error(err)));})});});
    p.stderr.on('data',c=>{err+=c;}); p.once('error',reject);
  });
  const runners=await Promise.all([launch(),launch()]); for(const r of runners)r.p.stdin.end('go');
  assert.deepEqual((await Promise.all(runners.map(r=>r.done))).sort(),['asset_exists','created']);
  assert.deepEqual(fs.readFileSync(path.join(root,'Images/race.png')),Buffer.from([0,255,1]));
 } finally { for(const p of children)if(p.exitCode===null)p.kill(); fs.rmSync(root,{recursive:true,force:true}); }
});


test('opened-handle locality rejects remote/removable devices and unverified query results',async()=>{
 const {assertLocalAssetDevice}=await import('../dist/services/assets/windowsAssetFiles.js');
 const b=Buffer.alloc(8);b.writeUInt32LE(7,0);
 assert.doesNotThrow(()=>assertLocalAssetDevice(0,8n,b));
 for(const characteristics of [1,16,17]){b.writeUInt32LE(characteristics,4);assert.throws(()=>assertLocalAssetDevice(0,8,b));}
 b.writeUInt32LE(0,4);assert.throws(()=>assertLocalAssetDevice(-1,8,b));assert.throws(()=>assertLocalAssetDevice(0,0,b));
 b.writeUInt32LE(0,0);assert.throws(()=>assertLocalAssetDevice(0,8,b));
});
