import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssetFileIngress,
  CHATGPT_FILE_ROOT_ID,
  validateAssetFileDownloadUrl,
} from "../dist/services/assets/fileIngress.js";
import { assetHash } from "../dist/services/assets/windowsAssetFiles.js";

const png = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
]);

test("file ingress rejects non-HTTPS and private literal URLs before download", async () => {
  for (const url of [
    "http://files.example.test/input.png",
    "https://127.0.0.1/input.png",
    "https://10.1.2.3/input.png",
    "https://localhost/input.png",
    "https://[::1]/input.png",
  ]) {
    assert.throws(() => validateAssetFileDownloadUrl(url));
  }
  assert.equal(
    validateAssetFileDownloadUrl("https://files.example.test/input.png").hostname,
    "files.example.test",
  );
});
test("disabled file ingress fails before downloader invocation", async () => {
  let downloads = 0;
  const ingress = new AssetFileIngress(false, async () => {
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
  const ingress = new AssetFileIngress(true, async () => {
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
  const ingress = new AssetFileIngress(true, async (url) => {
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
  const ingress = new AssetFileIngress(true, async () => ({
    bytes: png,
    contentType: "image/png",
  }));
  const result = await ingress.materialize({
    download_url: "https://files.example.test/input.png",
    file_id: "file_abcdefgh",
    mime_type: "image/png",
  });
  assert.equal(ingress.isReference(result.source), true);
  assert.match(ingress.authorizeReference(result.source), /^[a-f0-9]{64}$/u);

  const disabled = new AssetFileIngress(false, async () => ({
    bytes: png,
  }));
  assert.throws(() => disabled.authorizeReference(result.source));
});
