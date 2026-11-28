import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSmartEnvV3, smartTextHash } from "../dist/services/smartEnvV3.js";

const cli = fileURLToPath(new URL("./semantic-index-producer.mjs", import.meta.url));
const model = "fixture-model";
const weights = "a".repeat(64);
const hash = input => createHash("sha256").update(input).digest("hex");
const note = text => `# Heading\n\n${text}\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-index-test-"));
  const vault = path.join(root, "vault");
  const index = path.join(root, "index");
  await mkdir(vault);
  const health = {
    model, dims: 2, max_tokens: 256, model_sha256: weights, document_device: "cuda", query_device: "cpu",
    query_context: 128, runtime: "fixture", backend: "fixture", runtime_sha256: "b".repeat(64),
    gpu_worker_sha256: "c".repeat(64), gpu_model_sha256: "d".repeat(64),
  };
  const requests = [];
  let beforeEncode;
  let transformRow = row => row;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.method === "GET" && req.url === "/health") return res.end(JSON.stringify(health));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(req.method, "POST");
      assert.equal(body.model, model);
      assert.equal(req.url, health.document_device === "cuda" ? "/bitnet/embed-batch" : "/bitnet/embed");
      const items = body.items ?? [body];
      assert.ok(items.length >= 1 && items.length <= 4);
      for (const item of items) {
        assert.equal(item.purpose, "document");
        assert.equal(item.entity_kind, item.source_path.includes("#") ? "block" : "source");
        requests.push(item);
      }
      if (beforeEncode) {
        const callback = beforeEncode;
        beforeEncode = undefined;
        await callback();
      }
      const results = items.map(item => transformRow({
        device: health.document_device,
        vector: parseInt(hash(item.input)[0], 16) % 2 ? [0, 1] : [1, 0],
        tokens: 3, truncated: false, prefix_applied: false, input_sha256: hash(item.input),
      }));
      res.end(JSON.stringify({ model, results }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  function start(...args) {
    const { promise, resolve } = Promise.withResolvers();
    const child = execFile(process.execPath, [
      cli, "--vault", vault, "--index", index, "--endpoint", `http://127.0.0.1:${server.address().port}`,
      "--model", model, "--revision", "fixture-revision", "--model-sha256", weights, ...args,
    ], { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    return { child, result: promise };
  }
  async function run(...args) {
    const result = await start(...args).result;
    assert.ifError(result.error);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  }
  async function fail(pattern, ...args) {
    const result = await start(...args).result;
    assert.equal(result.error?.code, 1);
    assert.match(result.stderr, pattern);
  }
  const put = (name, text) => writeFile(path.join(vault, name), text, "utf8");
  const current = async () => (await readFile(path.join(index, "CURRENT"), "utf8")).trim();
  const generation = id => path.join(index, "generations", id);
  const manifest = async id => JSON.parse(await readFile(path.join(generation(id), "generation.json"), "utf8"));
  const load = id => readSmartEnvV3(generation(id), { blocks: true });
  return {
    root, vault, index, requests, health, start, run, fail, put, current, generation, manifest, load,
    beforeEncode(callback) { beforeEncode = callback; },
    transformRow(callback) { transformRow = callback; },
  };
}

test("first build sends exact note/block inputs and the Smart Env reader resolves vectors and line hashes", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.vault, "Folder"));
  const text = "---\r\ntags: [fixture]\r\n---\r\n# A\r\n## B\r\n- Text\r\n~~~\r\n# inside fence\r\n~~~";
  await f.put("Folder/Example.md", text);
  const receipt = await f.run();
  assert.equal(await f.current(), receipt.generation);
  const loaded = await f.load(receipt.generation);
  assert.deepEqual(loaded.notes.map(row => [row.notePath, row.tags]), [["Folder/Example.md", ["fixture"]]]);
  const sent = new Map(f.requests.map(row => [row.source_path, row.input]));
  assert.equal(sent.get("Folder/Example.md"), "Folder > Example:\n" + text);
  const block = loaded.blocks.refs.find(ref => ref.blockKey === "#A#B");
  const blockText = text.split("\n").slice(4).join("\n");
  assert.deepEqual([block.lineStart, block.lineEnd, block.readHash], [5, 9, smartTextHash(blockText)]);
  assert.equal(sent.get("Folder/Example.md#A#B"), "Folder > Example > A\n" + blockText);
  assert.ok(loaded.blocks.refs.every(ref => !/frontmatter|inside fence/u.test(ref.blockKey)));
  assert.equal((await f.manifest(receipt.generation)).sources["Folder/Example.md"].sha256, hash(text));
  assert.deepEqual(await readdir(path.join(f.vault, "Folder")), ["Example.md"]);
});

test("incremental rebuild reuses exact unchanged inputs, including blocks after a sibling edit", async t => {
  const f = await fixture(t);
  await f.put("a.md", "# A\n\nAlpha\n# B\n\nBeta\n");
  await f.put("b.md", note("Unchanged"));
  const first = await f.run();
  const firstLoaded = await f.load(first.generation);
  f.requests.length = 0;
  await f.put("a.md", "# A\n\nAlpha corrected\n# B\n\nBeta\n");
  const second = await f.run();
  assert.equal(second.encoded, f.requests.length);
  assert.ok(second.reused > 0 && second.encoded > 0);
  assert.ok(f.requests.every(row => row.source_path.startsWith("a.md") && row.input.includes("corrected")));
  const secondLoaded = await f.load(second.generation);
  assert.deepEqual(secondLoaded.notes.find(row => row.notePath === "b.md"), firstLoaded.notes.find(row => row.notePath === "b.md"));
  assert.ok(await f.manifest(first.generation));
});

test("a deleted note and its block references leave the next generation, including the last note", async t => {
  const f = await fixture(t);
  await f.put("remove.md", note("Remove me"));
  const first = await f.run();
  await unlink(path.join(f.vault, "remove.md"));
  const second = await f.run();
  const loaded = await f.load(second.generation);
  assert.deepEqual(loaded.notes, []);
  assert.deepEqual(loaded.blocks.refs, []);
  assert.equal((await f.load(first.generation)).notes[0].notePath, "remove.md");
});

test("renaming drops old references and encodes the new breadcrumb instead of reusing old vectors", async t => {
  const f = await fixture(t);
  await f.put("old.md", note("Same body"));
  await f.run();
  f.requests.length = 0;
  await rename(path.join(f.vault, "old.md"), path.join(f.vault, "new.md"));
  const second = await f.run();
  const loaded = await f.load(second.generation);
  assert.deepEqual(loaded.notes.map(row => row.notePath), ["new.md"]);
  assert.ok(loaded.blocks.refs.length && loaded.blocks.refs.every(ref => ref.notePath === "new.md"));
  assert.equal(second.reused, 0);
  assert.ok(f.requests.length && f.requests.every(row => row.input.startsWith("new")));
});

test("a note lost between inventory and open aborts instead of publishing a deletion", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  await f.put("b.md", note("Beta"));
  const first = await f.run();
  await f.put("a.md", note("Changed"));
  f.beforeEncode(() => unlink(path.join(f.vault, "b.md")));
  await f.fail(/ENOENT/u);
  assert.equal(await f.current(), first.generation);
  assert.equal((await f.load(first.generation)).notes.length, 2);
});

test("a changed source or replacement vault volume refuses publication", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  const first = await f.run();
  await f.put("a.md", note("Changed"));
  f.beforeEncode(() => f.put("a.md", note("Changed again during embedding")));
  await f.fail(/Vault inventory changed/u);
  assert.equal(await f.current(), first.generation);
  await rename(f.vault, path.join(f.root, "offline-vault"));
  await mkdir(f.vault);
  await f.fail(/Vault root or volume differs/u);
  assert.equal(await f.current(), first.generation);
});

test("a killed writer and a competing invocation leave the previous pointer and generation readable", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  const first = await f.run();
  await f.put("a.md", note("Changed"));
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.beforeEncode(async () => { arrived.resolve(); await release.promise; });
  const running = f.start();
  try {
    await Promise.race([arrived.promise, running.result.then(result => assert.fail(result.stderr || "Writer exited early"))]);
    await f.fail(/already has a producer lock/u);
    assert.equal(await f.current(), first.generation);
    assert.ok(running.child.kill("SIGKILL"));
    assert.equal((await running.result).error?.signal, "SIGKILL");
  } finally {
    release.resolve();
    await running.result;
  }
  assert.equal(await f.current(), first.generation);
  assert.equal((await f.load(first.generation)).notes[0].notePath, "a.md");
  assert.deepEqual(await readdir(path.join(f.index, "generations")), [first.generation]);
});

test("pointer replacement exposes a complete generation or preserves CURRENT if a reader denies replacement", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  const first = await f.run();
  await f.put("b.md", note("Beta"));
  const reader = await open(path.join(f.index, "CURRENT"), "r");
  let second;
  try {
    const attempt = await f.start().result;
    assert.equal((await reader.readFile("utf8")).trim(), first.generation);
    if (attempt.error) {
      assert.equal(process.platform, "win32");
      assert.match(attempt.stderr, /CURRENT replacement failed \((EPERM|EACCES|EBUSY)\)/u);
      assert.equal(await f.current(), first.generation);
      assert.deepEqual((await f.load(first.generation)).notes.map(row => row.notePath), ["a.md"]);
    } else {
      second = JSON.parse(attempt.stdout);
    }
  } finally {
    await reader.close();
  }
  second ??= await f.run();
  assert.equal(await f.current(), second.generation);
  assert.deepEqual((await f.load(second.generation)).notes.map(row => row.notePath), ["a.md", "b.md"]);
});

test("encoding identity drift requires a full rebuild and wrong weight identity still fails closed", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  const first = await f.run();
  f.health.gpu_worker_sha256 = "e".repeat(64);
  await f.fail(/Use --rebuild/u);
  assert.equal(await f.current(), first.generation);
  const second = await f.run("--rebuild");
  assert.equal(second.reused, 0);
  assert.equal(second.encoded, first.encoded);
  f.health.model_sha256 = "f".repeat(64);
  await f.fail(/does not match the expected model/u, "--rebuild");
  assert.equal(await f.current(), second.generation);
});

test("overlapping excluded blocks cannot leak heading text, and CPU uses the single-document route", async t => {
  const f = await fixture(t);
  f.health.document_device = "cpu";
  await f.put("included.md", "# Parent\n\nVisible\n## Omit\n\nSecret text\n# Omit\n\nFirst secret\n# Omit\n\nDuplicate secret\n# Next\n\nOther text");
  await f.put("excluded.md", note("Excluded file"));
  const built = await f.run("--exclude-heading", "Omit", "--exclude-path", "excluded.md");
  assert.ok(f.requests.length);
  assert.ok(f.requests.every(row => !/secret|excluded file/iu.test(row.input)));
  const loaded = await f.load(built.generation);
  assert.deepEqual(loaded.notes.map(row => row.notePath), ["included.md"]);
  assert.ok(loaded.blocks.refs.every(ref => !ref.blockKey.includes("Omit") && ref.blockKey !== "#Parent"));
});

test("truncated or invalid vectors never become active", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  const first = await f.run();
  await f.put("a.md", note("Changed"));
  f.transformRow(row => ({ ...row, truncated: true }));
  await f.fail(/truncated or incompatible/u);
  f.transformRow(row => ({ ...row, vector: [0, 0] }));
  await f.fail(/Invalid BitNet vector/u);
  assert.equal(await f.current(), first.generation);
});

test("an index inside the vault is refused before any directory is created", async t => {
  const f = await fixture(t);
  await f.fail(/must be disjoint/u, "--index", path.join(f.vault, "new", "index"));
  assert.deepEqual(await readdir(f.vault), []);
});
