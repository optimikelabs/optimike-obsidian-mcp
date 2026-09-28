import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { runAssetJob, activeAssetWorkers } from '../dist/services/assets/workerClient.js';
import { assetHash } from '../dist/services/assets/windowsAssetFiles.js';

const rgba = Buffer.from([255,0,0,0, 0,255,0,128, 0,0,255,255, 200,100,50,255, 20,40,60,64, 150,50,20,255]);
const png = await sharp(rgba, {raw:{width:2,height:3,channels:4}}).png().toBuffer();
const convert = (bytes, policy={quality:75}, timeout) => runAssetJob({kind:'convert',bytes,policy},timeout);

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
