import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssetFileIngress,
  CHATGPT_FILE_ROOT_ID,
  createAssetFileLookup,
  validateAssetFileDownloadUrl,
} from "../dist/services/assets/fileIngress.js";
import { assetHash } from "../dist/services/assets/windowsAssetFiles.js";
import { ExternalRootSchema } from "../dist/services/externalRootsService.js";

const png = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
]);
const allowedHosts = ["files.example.test"];

test("file ingress rejects non-HTTPS and private literal URLs before download", async () => {
  for (const url of [
    "http://files.example.test/input.png",
    "https://127.0.0.1/input.png",
    "https://10.1.2.3/input.png",
    "https://localhost/input.png",
    "https://[::1]/input.png",
  ]) {
    assert.throws(() => validateAssetFileDownloadUrl(url, allowedHosts));
  }
  assert.throws(() =>
    validateAssetFileDownloadUrl(
      "https://attacker.example/input.png",
      allowedHosts,
    ),
  );
  assert.equal(
    validateAssetFileDownloadUrl(
      "https://files.example.test/input.png",
      allowedHosts,
    ).hostname,
    "files.example.test",
  );
});
test("disabled file ingress fails before downloader invocation", async () => {
  let downloads = 0;
  const ingress = new AssetFileIngress(false, allowedHosts, async () => {
    downloads++;
    return { bytes: png, contentType: "image/png" };
  });
  await assert.rejects(
    ingress.materialize({
      download_url: "https://files.example.test/input.png",
      file_id: "file_12345678",
      mime_type: "image/png",
      file_name: "input.png",
    }),
  );
  assert.equal(downloads, 0);
});

test("file ingress rejects a non-image host mime hint", async () => {
  let downloads = 0;
  const ingress = new AssetFileIngress(true, allowedHosts, async () => {
    downloads++;
    return { bytes: png, contentType: "image/png" };
  });
  await assert.rejects(
    ingress.materialize({
      download_url: "https://files.example.test/input.png",
      file_id: "file_12345678",
      mime_type: "text/plain",
      file_name: "input.png",
    }),
  );
  assert.equal(downloads, 0);
});
test("file ingress materializes one bounded host file as a durable synthetic source", async () => {
  let downloads = 0;
  const ingress = new AssetFileIngress(true, allowedHosts, async (url) => {
    downloads++;
    assert.equal(url.origin, "https://files.example.test");
    return { bytes: png, contentType: "image/png" };
  });
  const result = await ingress.materialize({
    download_url: "https://files.example.test/input.png?token=PRIVATE",
    file_id: "file_12345678",
    mime_type: "image/png",
    file_name: "input.png",
  });
  assert.equal(downloads, 1);
  assert.deepEqual(result.source, {
    rootId: CHATGPT_FILE_ROOT_ID,
    relativePath: "file_12345678",
    sha256: assetHash(png),
  });
  const policy = await result.provider.authorize(result.source);
  assert.match(policy, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await result.provider.read(result.source), png);
  assert.equal(
    await result.provider.authorize({ ...result.source }),
    policy,
  );
  await assert.rejects(
    result.provider.read({ ...result.source, relativePath: "file_changed" }),
  );
});
test("stored ChatGPT file references remain authorizable for apply without re-downloading", async () => {
  const ingress = new AssetFileIngress(true, allowedHosts, async () => ({
    bytes: png,
    contentType: "image/png",
  }));
  const result = await ingress.materialize({
    download_url: "https://files.example.test/input.png",
    file_id: "file_abcdefgh",
    mime_type: "image/png",
  });
  assert.equal(ingress.isReference(result.source), true);
  const originalPolicy=ingress.authorizeReference(result.source);
  assert.match(originalPolicy, /^[a-f0-9]{64}$/u);
  const reconfigured = new AssetFileIngress(
    true,
    ["other-files.example.test"],
    async () => ({ bytes: png }),
  );
  assert.notEqual(
    reconfigured.authorizeReference(result.source),
    originalPolicy,
    "changing the approved host policy must invalidate the sealed source policy digest",
  );

  const disabled = new AssetFileIngress(false, allowedHosts, async () => ({
    bytes: png,
  }));
  assert.throws(() => disabled.authorizeReference(result.source));
});

test("synthetic ChatGPT identity cannot collide with configured ExternalRoot ids", () => {
  const legacyLike = ExternalRootSchema.safeParse({
    id: "chatgpt.file",
    path: process.cwd(),
    capabilities: ["visible", "readable"],
  });
  assert.equal(legacyLike.success, true);
  const reserved = ExternalRootSchema.safeParse({
    id: CHATGPT_FILE_ROOT_ID,
    path: process.cwd(),
    capabilities: ["visible", "readable"],
  });
  assert.equal(reserved.success, false);
});

test("custom HTTPS lookup honors Node all=true shape and validates every address", async () => {
  const lookup=createAssetFileLookup((_hostname,_options,callback)=>callback(null,[
    {address:"93.184.216.34",family:4},
    {address:"2606:4700:4700::1111",family:6},
  ]));
  const all=await new Promise((resolve,reject)=>lookup(
    "files.example.test",
    {all:true},
    (error,address)=>{
      if(error)reject(error);else resolve(address);
    },
  ));
  assert.ok(Array.isArray(all));
  assert.deepEqual(all,[
    {address:"93.184.216.34",family:4},
    {address:"2606:4700:4700::1111",family:6},
  ]);

  const one=await new Promise((resolve,reject)=>lookup(
    "files.example.test",
    {all:false},
    (error,address,family)=>{
      if(error)reject(error);else resolve({address,family});
    },
  ));
  assert.deepEqual(one,{address:"93.184.216.34",family:4});

  for(const blockedAddress of ["127.0.0.1","10.0.0.1","100.64.0.1","169.254.1.1","192.168.1.1","192.0.2.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","::1","fc00::1","fe80::1","fec0::1","::ffff:127.0.0.1","::ffff:7f00:1","2001:db8::1"]) {
   const blocked=createAssetFileLookup((_hostname,_options,callback)=>callback(null,[
    {address:"93.184.216.34",family:4},
    {address:blockedAddress,family:blockedAddress.includes(":")?6:4},
   ]));
   await assert.rejects(new Promise((resolve,reject)=>blocked(
    "files.example.test",
    {all:true},
    (error,address)=>{
      if(error)reject(error);else resolve(address);
    },
   )));
  }
});
