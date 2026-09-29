import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { runAssetJob, activeAssetWorkers } from '../dist/services/assets/workerClient.js';
import { assetHash } from '../dist/services/assets/windowsAssetFiles.js';
import { probeImageProcessingDependencies } from '../dist/services/assets/imageProcessing.js';

const rgba = Buffer.from([255,0,0,0, 0,255,0,128, 0,0,255,255, 200,100,50,255, 20,40,60,64, 150,50,20,255]);
const png = await sharp(rgba, {raw:{width:2,height:3,channels:4}}).png().toBuffer();
const convert = (bytes, policy={quality:75}, timeout) => runAssetJob({kind:'convert',bytes,policy},timeout);

test('image dependency readiness requires both Sharp native bindings and Saxes', () => {
  const fakeSharp=()=>{};
  fakeSharp.versions={sharp:'fixture-sharp',vips:'fixture-vips'};
  const ready=name => name==='sharp'
    ? fakeSharp
    : name==='saxes'
      ? {SaxesParser:class SaxesParser{}}
      : (()=>{throw new Error('unexpected dependency')})();
  assert.doesNotThrow(()=>probeImageProcessingDependencies(ready));
  for(const missing of ['sharp','saxes']) {
    assert.throws(
      ()=>probeImageProcessingDependencies(name=>{
        if(name===missing) throw new Error('missing');
        return name==='sharp' ? fakeSharp : {SaxesParser:class SaxesParser{}};
      }),
      error=>error?.reason==='image_dependency_unavailable',
      missing,
    );
  }
  assert.throws(
    ()=>probeImageProcessingDependencies(name=>name==='sharp' ? Object.assign(()=>{}, {versions:{}}) : {SaxesParser:class SaxesParser{}}),
    error=>error?.reason==='image_dependency_unavailable',
  );
});

test('PNG becomes WebP without resizing and preserves transparent alpha', async () => {
  const result=await convert(png);
  assert.equal(result.format,'webp'); assert.equal(result.width,2); assert.equal(result.height,3);
  assert.equal(result.sourceSha256,assetHash(png)); assert.equal(result.sha256,assetHash(result.bytes));
  assert.equal(result.size,result.bytes.length); assert.equal(result.exception,'none');
  const raw=await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  for(let i=3;i<rgba.length;i+=4)assert.equal(raw[i],rgba[i]);
  assert.equal(activeAssetWorkers(),0);
});

test('EXIF orientation changes geometry correctly, not arbitrarily resizing', async () => {
  const jpeg=await sharp({create:{width:4,height:2,channels:3,background:{r:20,g:30,b:40}}})
    .jpeg().withMetadata({orientation:6}).toBuffer();
  const result=await convert(jpeg);
  assert.equal(result.width,2);assert.equal(result.height,4);
});

test('static AVIF normalizes Sharp heif metadata to the avif contract', async () => {
  const avif=await sharp({create:{width:3,height:2,channels:3,background:{r:12,g:34,b:56}}}).avif().toBuffer();
  const native=await sharp(avif).metadata();
  assert.equal(native.format,'heif');
  const converted=await convert(avif);
  assert.equal(converted.format,'webp');
  assert.equal(converted.width,3);assert.equal(converted.height,2);
  const preserved=await convert(avif,{quality:75,preserveOriginal:true,exceptionReason:'Keep original AVIF'});
  assert.equal(preserved.format,'avif');
  assert.deepEqual(preserved.bytes,avif);
  assert.equal(preserved.exception,'original_requested');
});

test('original preservation is explicit and byte exact', async () => {
  await assert.rejects(convert(png,{quality:75,preserveOriginal:true}),e=>e.reason==='image_policy_invalid');
  const result=await convert(png,{quality:75,preserveOriginal:true,exceptionReason:'Required lossless source'});
  assert.equal(result.format,'png'); assert.deepEqual(result.bytes,png); assert.equal(result.exception,'original_requested');
});

test('a bounded inert SVG stays vector and byte exact', async () => {
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>');
  const result=await convert(svg);
  assert.equal(result.format,'svg'); assert.deepEqual(result.bytes,svg);assert.equal(result.exception,'vector_preserved');
});

test('every frame of a GIF is decoded but the animation is preserved unchanged', async () => {
  const frames=Buffer.from([255,0,0,255, 255,0,0,255, 0,0,255,255, 0,0,255,255]);
  const gif=await sharp(frames,{raw:{width:2,height:2,channels:4,pageHeight:1}}).gif({delay:[100,100],loop:0}).toBuffer();
  const result=await convert(gif);
  assert.equal(result.format,'gif');assert.equal(result.pages,2);assert.equal(result.height,1);
  assert.deepEqual(result.bytes,gif);assert.equal(result.exception,'animation_preserved');
});

test('invalid input dimensions bytes and policy fail without yielding an asset', async () => {
  for(const bytes of [Buffer.from('private sentinel is not an image'),Buffer.alloc(0),Buffer.alloc(8*1024*1024+1)])
    await assert.rejects(convert(bytes),e=>['image_invalid','image_limit'].includes(e.reason)&&!e.message.includes('sentinel'));
  await assert.rejects(convert(png,{quality:101}),e=>e.reason==='image_policy_invalid');
  const huge=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="10" height="10"/></svg>');
  await assert.rejects(convert(huge),e=>['image_invalid','image_limit'].includes(e.reason));
});

test('SVG active content and alternate namespace external links are refused before rendering', async () => {
  const bodies=[
    '<script>alert(1)</script>',
    '<foreignObject><div>html</div></foreignObject>',
    '<rect width="2" height="2" onload="alert(1)"/>',
    '<use href="https://example.invalid/private.svg#x"/>',
    '<use xmlns:p="http://www.w3.org/1999/xlink" p:href="file:///private.svg#x"/>',
    '<rect width="2" height="2" fill="u\\72l(file:///private.svg#x)"/>',
    '<style>rect { fill: red; }</style>',
  ];
  for(const body of bodies){
    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">'+body+'</svg>');
    await assert.rejects(convert(svg),e=>e.reason==='svg_unsupported',body);
  }
});

test('SVG external references cause zero HTTP requests', async () => {
  const {createServer}=await import('node:http');let requests=0;
  const server=createServer((_req,res)=>{requests++;res.end('not requested');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><use href="http://127.0.0.1:'+server.address().port+'/x"/></svg>');
    await assert.rejects(convert(svg),e=>e.reason==='svg_unsupported');assert.equal(requests,0);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('a hard worker deadline terminates and releases its concurrency slot', async () => {
  await assert.rejects(convert(png,{quality:75},1),e=>e.reason==='asset_worker_timeout');
  assert.equal(activeAssetWorkers(),0);assert.equal((await convert(png)).format,'webp');
});

test('worker admission is bounded rather than an unbounded promise queue', async () => {
  const a=convert(png),b=convert(png);
  await assert.rejects(convert(png),e=>e.reason==='asset_worker_busy');
  await Promise.all([a,b]);assert.equal(activeAssetWorkers(),0);
});


test('unqualified animated PNG and AVIF sequences are refused, never silently flattened', async () => {
 const header=Buffer.from([137,80,78,71,13,10,26,10]);
 const chunk=Buffer.alloc(20);chunk.writeUInt32BE(8,0);chunk.write('acTL',4,'ascii');
 await assert.rejects(convert(Buffer.concat([header,chunk])),e=>e.reason==='image_invalid');
 const avis=Buffer.alloc(20);avis.writeUInt32BE(20,0);avis.write('ftypavis',4,'ascii');
 await assert.rejects(convert(avis),e=>e.reason==='image_invalid');
});


test('actual asynchronous OS spawn failure carries parent-only not-started evidence',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 const {mock}=await import('node:test');
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const cp=createRequire(import.meta.url)('node:child_process'),original=cp.fork;
 const {AssetWorkerNotStartedError}=await import('../dist/services/assets/workerClient.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'optimike-no-worker-'));
 const method=mock.method(cp,'fork',(module,args,options)=>original(module,args,{...options,execPath:path.join(root,'missing-executable')}));
 syncBuiltinESMExports();
 try {await assert.rejects(convert(png),e=>e instanceof AssetWorkerNotStartedError&&e.reason==='asset_worker_unavailable');assert.equal(activeAssetWorkers(),0);}
 finally {method.mock.restore();syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
 assert.equal((await convert(png)).format,'webp');
});

test('an error after a real spawn never carries not-started evidence',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 const {mock}=await import('node:test');
 const cp=createRequire(import.meta.url)('node:child_process'),original=cp.fork;
 const {AssetWorkerNotStartedError}=await import('../dist/services/assets/workerClient.js');
 const method=mock.method(cp,'fork',(module,args,options)=>{
  const child=original(module,args,options);
  child.once('spawn',()=>queueMicrotask(()=>child.emit('error',Object.assign(new Error('fixture after spawn'),{code:'ENOENT'}))));
  return child;
 });syncBuiltinESMExports();
 try {await assert.rejects(convert(png),e=>!(e instanceof AssetWorkerNotStartedError)&&e.reason==='asset_worker_unavailable');assert.equal(activeAssetWorkers(),0);}
 finally {method.mock.restore();syncBuiltinESMExports();}
});
