import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSmartEnvV3, smartTextHash } from "../dist/services/smartEnvV3.js";

const cli = fileURLToPath(new URL("./semantic-index-producer.mjs", import.meta.url));
const model = "fixture-model";
const weights = "a".repeat(64);
const hash = input => createHash("sha256").update(input).digest("hex");
const note = text => `# Heading\n\n${text}\n`;
const strict = process.env.SEMANTIC_INDEX_STRICT_READER &&
  (await import(pathToFileURL(path.resolve(process.env.SEMANTIC_INDEX_STRICT_READER)))).readSmartEnvV3;
const producerTimeout = Number(process.env.SEMANTIC_INDEX_TEST_TIMEOUT_MS ?? 20_000);
assert.ok(Number.isInteger(producerTimeout) && producerTimeout > 0 && producerTimeout <= 2 ** 31 - 1,
  "SEMANTIC_INDEX_TEST_TIMEOUT_MS must be a positive timer delay in milliseconds");

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
  const batches = [];
  let beforeEncode;
  let transformRow = row => row;
  let refuseBatch = () => false;
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
      batches.push(items);
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
      if (refuseBatch(items)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "input too large" }));
      }
      const cuda = health.document_device === "cuda";
      const results = items.map(item => transformRow({
        vector: parseInt(hash(item.input)[0], 16) % 2 ? [0, 1] : [1, 0],
        tokens: 3,
        truncated: false,
        // BitNet's native CPU encoder returns the worker result. Device and
        // provenance fields are added to the audit log, not the response.
        ...(cuda && { device: "cuda" }),
      }, item));
      res.end(JSON.stringify({ model, results, ...(!cuda && { embeddings: results.map(row => row.vector) }) }));
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
      "--model", model, "--revision", "fixture-revision", "--model-sha256", weights,
      "--min-note-chars", "1", "--min-block-chars", "0", ...args,
    ], { timeout: producerTimeout, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
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
  const current = async () => {
    const raw = await readFile(path.join(index, "CURRENT"), "utf8");
    assert.equal(raw, raw.trim() + "\n");
    return raw.slice(0, -1);
  };
  const generation = id => path.join(index, "generations", id);
  const manifest = async id => JSON.parse(await readFile(path.join(generation(id), "generation.json"), "utf8"));
  async function load(id) {
    if (!strict) return readSmartEnvV3(generation(id), { blocks: true });
    const { fingerprint, model, vectors } = await manifest(id);
    return strict(generation(id), {
      blocks: true, expected: { fingerprint, model, noteCount: vectors.notes.count, sectionCount: vectors.sections.count },
    });
  }
  return {
    root, vault, index, requests, batches, health, start, run, fail, put, current, generation, manifest, load,
    beforeEncode(callback) { beforeEncode = callback; },
    transformRow(callback) { transformRow = callback; },
    refuseBatch(callback) { refuseBatch = callback; },
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
  const block = loaded.blocks.refs.find(ref => ref.blockKey === "#A#B#{1}");
  const blockText = text.split("\n").slice(5).join("\n");
  assert.deepEqual([block.lineStart, block.lineEnd, block.readHash], [6, 9, smartTextHash(blockText)]);
  assert.equal(sent.get("Folder/Example.md#A#B#{1}"), "Folder > Example > A > B\n" + blockText);
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

test("a deleted note and its block references leave the next generation", async t => {
  const f = await fixture(t);
  await f.put("remove.md", note("Remove me"));
  await f.put("stay.md", note("Keep me"));
  const first = await f.run();
  await unlink(path.join(f.vault, "remove.md"));
  const second = await f.run("--max-deletion-percent", "50");
  const loaded = await f.load(second.generation);
  assert.deepEqual(loaded.notes.map(row => row.notePath), ["stay.md"]);
  assert.ok(loaded.blocks.refs.length && loaded.blocks.refs.every(row => row.notePath === "stay.md"));
  assert.equal((await f.load(first.generation)).notes[0].notePath, "remove.md");
});

test("removing the last note preserves CURRENT because the external reader rejects empty generations", async t => {
  const f = await fixture(t);
  await f.put("last.md", note("Last note"));
  const first = await f.run();
  await unlink(path.join(f.vault, "last.md"));
  await f.fail(/requires at least one Markdown note/u);
  assert.equal(await f.current(), first.generation);
  assert.equal((await f.load(first.generation)).notes[0].notePath, "last.md");
});

test("renaming drops old references and encodes the new breadcrumb instead of reusing old vectors", async t => {
  const f = await fixture(t);
  await f.put("old.md", note("Same body"));
  await f.run();
  f.requests.length = 0;
  await rename(path.join(f.vault, "old.md"), path.join(f.vault, "new.md"));
  const second = await f.run("--allow-deletions");
  const loaded = await f.load(second.generation);
  assert.deepEqual(loaded.notes.map(row => row.notePath), ["new.md"]);
  assert.ok(loaded.blocks.refs.length && loaded.blocks.refs.every(ref => ref.notePath === "new.md"));
  assert.equal(second.reused, 0);
  assert.ok(f.requests.length && f.requests.every(row => row.input.startsWith("new")));
});

test("a note lost between inventory and open aborts instead of publishing a deletion", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  for (const letter of ["b", "c", "d", "e"]) await f.put(letter + ".md", note(letter));
  const first = await f.run();
  await f.put("a.md", note("Changed"));
  f.beforeEncode(() => unlink(path.join(f.vault, "e.md")));
  await f.fail(/ENOENT/u);
  assert.equal(await f.current(), first.generation);
  assert.equal((await f.load(first.generation)).notes.length, 5);
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
    await f.fail(new RegExp(`already has a producer lock \\(PID ${running.child.pid}, started \\d{4}-`, "u"));
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

test("CPU accepts native rows without device metadata and removes excluded heading text", async t => {
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

test("malformed or incompatible vectors still abort publication", async t => {
  const f = await fixture(t);
  await f.put("a.md", note("Alpha"));
  const first = await f.run();
  await f.put("a.md", note("Changed"));
  f.transformRow(row => ({ ...row, vector: [0, 0] }));
  await f.fail(/Invalid BitNet vector/u);
  f.transformRow(row => ({ ...row, device: undefined }));
  await f.fail(/truncated or incompatible/u);
  assert.equal(await f.current(), first.generation);
});

test("a readable partial vault cannot drop nine of ten active notes without approval", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 10; n++) await f.put(`note-${n}.md`, note("Synthetic note " + n));
  const first = await f.run();
  assert.ok(f.batches.some(items => items.length === 4 &&
    new Set(items.filter(item => item.entity_kind === "source").map(item => item.source_path)).size === 4));
  for (let n = 1; n < 10; n++) await unlink(path.join(f.vault, `note-${n}.md`));
  await f.fail(/Deletion limit exceeded \(9 of 10/u, "--rebuild");
  await f.fail(/Deletion limit exceeded/u, "--max-deletion-percent", "100", "--max-deletions", "8");
  assert.equal(await f.current(), first.generation);
  const second = await f.run("--allow-deletions");
  assert.equal(second.deletions, 9);
  assert.deepEqual((await f.load(second.generation)).notes.map(row => row.notePath), ["note-0.md"]);
});

for (const [label, replaceBody, truncate] of [
  ["invalid UTF-8", Buffer.from([0xe9, 0x20]), false],
  ["BitNet truncation", note("Changed input exceeds the context"), true],
]) {
  test(`mass ${label} trips the deletion guard after encoding and before a generation is sealed`, async t => {
    const f = await fixture(t);
    await f.put("keep.md", note("Keep this note"));
    for (let i = 0; i < 10; i++) await f.put(`changed-${i}.md`, note("Original input"));
    const first = await f.run();
    for (let i = 0; i < 10; i++) await f.put(`changed-${i}.md`, replaceBody);
    if (truncate) {
      f.transformRow((row, item) => item.source_path.startsWith("changed-")
        ? { ...row, truncated: true, tokens: f.health.max_tokens } : row);
    }
    await f.fail(/Deletion limit exceeded \(10 of 11 active notes not publishable\)/u);
    assert.equal(await f.current(), first.generation);
    assert.deepEqual(await readdir(path.join(f.index, "generations")), [first.generation]);
    const second = await f.run("--allow-deletions");
    assert.equal(second.deletions, 10);
    assert.equal(second.skipped.length, 10);
    assert.ok(second.skipped.every(item => item.reason === (truncate ? "document_too_long" : "invalid_utf8")));
    assert.deepEqual((await f.load(second.generation)).notes.map(row => row.notePath), ["keep.md"]);
  });
}

test("jsbrains note selection compares a strict byte minimum and does not count size-policy skips as deletions", async t => {
  const f = await fixture(t);
  await f.put("shrunk.md", "s".repeat(301));
  await f.put("multi.md", "é".repeat(151));
  await f.put("equal.md", "é".repeat(150));
  const first = await f.run("--min-note-chars", "0");
  assert.deepEqual((await f.load(first.generation)).notes.map(row => row.notePath), ["multi.md", "shrunk.md"]);
  assert.deepEqual(first.skipped, [{ path: "equal.md", reason: "note_below_min_size" }]);
  await f.put("shrunk.md", "s".repeat(300));
  const second = await f.run("--min-note-chars", "0");
  assert.equal(second.deletions, 0);
  assert.ok(second.skipped.some(item => item.path === "shrunk.md" && item.reason === "note_below_min_size"));
  assert.deepEqual((await f.load(second.generation)).notes.map(row => row.notePath), ["multi.md"]);
});

test("a truncated input, HTTP context refusal and invalid UTF-8 are reported while valid notes publish", async t => {
  const f = await fixture(t);
  await f.put("good.md", note("A valid source"));
  await f.put("too-long.md", note("Synthetic over-budget source"));
  await f.put("oversize.md", note("Synthetic oversized body"));
  await f.put("bad.md", Buffer.from([0xc3, 0x28]));
  f.refuseBatch(items => items.some(item => item.source_path === "oversize.md"));
  f.transformRow((row, item) => ["too-long.md", "good.md#Heading"].includes(item.source_path)
    ? { ...row, truncated: true, tokens: f.health.max_tokens } : row);
  const receipt = await f.run();
  const skipped = [
    { path: "bad.md", reason: "invalid_utf8" },
    { path: "oversize.md", reason: "document_too_long" },
    { path: "too-long.md", reason: "document_too_long" },
    { path: "good.md", reason: "document_too_long", blockKey: "#Heading" },
  ];
  assert.deepEqual(receipt.skipped, skipped);
  assert.deepEqual((await f.manifest(receipt.generation)).skipped, skipped);
  const loaded = await f.load(receipt.generation);
  assert.deepEqual(loaded.notes.map(row => row.notePath), ["good.md"]);
  assert.ok(loaded.blocks.refs.length && loaded.blocks.refs.every(row => row.notePath === "good.md"));
  assert.ok(f.requests.every(item => !/^(bad\.md|(?:too-long|oversize)\.md#)/u.test(item.source_path)));
});

test("jsbrains block selection uses inclusive size and suppresses parents only when selected descendants match both edges", async t => {
  const f = await fixture(t);
  await f.put("covered.md", "# Covered\n- 12345678\n- abcdefgh");
  await f.put("gap.md", "# Gap\n\n- 12345678\n- abcdefgh");
  await f.put("short-edge.md", "# Edge\n- 12345678\n- short");
  const result = await f.run("--min-block-chars", "10");
  const keys = (await f.load(result.generation)).blocks.refs.map(row => row.notePath + row.blockKey);
  assert.deepEqual(keys, [
    "covered.md#Covered#{1}", "covered.md#Covered#{2}",
    "gap.md#Gap", "gap.md#Gap#{1}", "gap.md#Gap#{2}",
    "short-edge.md#Edge", "short-edge.md#Edge#{1}",
  ]);
});

test("an index inside the vault is refused before any directory is created", async t => {
  const f = await fixture(t);
  await f.fail(/must be disjoint/u, "--index", path.join(f.vault, "new", "index"));
  assert.deepEqual(await readdir(f.vault), []);
});

test("refuse an index beneath another vault and reject a linked vault subtree", async t => {
  const f = await fixture(t);
  const another = path.join(f.root, "another");
  await mkdir(path.join(another, ".obsidian"), { recursive: true });
  await f.fail(/outside any Obsidian vault/u, "--index", path.join(another, "missing", "index"));
  assert.deepEqual(await readdir(another), [".obsidian"]);
  await f.put("valid.md", note("Valid text"));
  await symlink(another, path.join(f.vault, "link"), process.platform === "win32" ? "junction" : "dir");
  await f.fail(/Symbolic links require an explicit path exclusion/u);
  const receipt = await f.run("--exclude-path", "link");
  assert.equal((await f.load(receipt.generation)).notes.length, 1);
});

if (process.platform !== "win32") {
  test("strict-reader-incompatible POSIX names are reported and never enter generation records", async t => {
    const f = await fixture(t);
    const invalid = ["bad:name.md", "bad\\name.md", "bad\x1fname.md"];
    for (const name of invalid) await f.put(name, note("Skip this input"));
    await f.put("ok.md", note("Keep this input"));
    const receipt = await f.run();
    assert.deepEqual(receipt.skipped, invalid.sort().map(path => ({ path, reason: "invalid_note_path" })));
    assert.deepEqual((await f.load(receipt.generation)).notes.map(row => row.notePath), ["ok.md"]);
  });
}

if (process.getuid?.() > 0 && process.platform !== "win32") {
  test("EACCES reading an indexed note preserves CURRENT instead of classifying it as skipped content", async t => {
    const f = await fixture(t);
    await f.put("locked.md", note("Cannot read"));
    await f.put("okay.md", note("Can read"));
    const first = await f.run();
    const file = path.join(f.vault, "locked.md");
    await chmod(file, 0o000);
    try {
      await f.fail(/EACCES/u, "--allow-deletions");
      assert.equal(await f.current(), first.generation);
    } finally {
      await chmod(file, 0o600);
    }
  });
}

async function smartEnvFixture(f, { maxTokens = 256 } = {}) {
  const directory = path.join(f.root, "desktop");
  for (const sub of ["smart_sources", "smart_blocks", "embedding_models"]) {
    await mkdir(path.join(directory, sub), { recursive: true });
  }
  const profile = { provider_key: "ollama", model_key: model, dimensions: 2, max_tokens: maxTokens };
  const fingerprint = "mf_" + smartTextHash(JSON.stringify(profile));
  await writeFile(path.join(directory, "smart_env.json"), JSON.stringify({
    embedding_models: { default_model_key: "fixture" },
  }));
  await writeFile(path.join(directory, "embedding_models", "embedding_models.ajson"),
    '"embedding_models:fixture": ' + JSON.stringify(profile) + ',\n');
  const records = [];
  const notes = [];
  const sections = [];
  function addRow(rows, input, text) {
    const vector = Buffer.alloc(8);
    vector.writeFloatLE(1, parseInt(hash(input)[0], 16) % 2 * 4);
    const readHash = smartTextHash(text);
    const ref = { file: fingerprint, file_i: rows.length, read_hash: readHash };
    rows.push(vector);
    return { last_read: { hash: readHash }, embedding: { default: { [fingerprint]: ref } } };
  }
  for (const name of ["fresh", "changed", "excluded", "deleted", "outside"]) {
    const text = name === "excluded" ? "# Heading\n\nexcluded\n# Private\n\nRemoved from the input\n" : note(name);
    const relative = name + ".md";
    if (name !== "outside") await f.put(relative, text);
    const block = name === "excluded" ? "# Heading\n\nexcluded" : text;
    const source = {
      path: relative,
      ...addRow(notes, name + ":\n" + text, text),
      blocks_data: { "#Heading": {
        lines: [1, name === "excluded" ? 3 : 4],
        ...addRow(sections, name + "\n" + block, block),
      } },
    };
    if (name === "fresh") {
      source.blocks_data["#Retired"] = { lines: [1, 4], ...addRow(sections, "retired", block) };
    }
    records.push(JSON.stringify("smart_sources:" + relative) + ": " + JSON.stringify(source) + ",\n");
  }
  await writeFile(path.join(directory, "smart_sources", "smart_sources.ajson"), records.join(""));
  await writeFile(path.join(directory, "smart_sources", "smart_sources_1.ajson"), '"smart_sources:deleted.md": null,\n');
  await writeFile(path.join(directory, "smart_sources", fingerprint), Buffer.concat(notes));
  await writeFile(path.join(directory, "smart_blocks", fingerprint), Buffer.concat(sections));
  return directory;
}

test("bootstrap imports fresh rows and encodes stale, transformed and tombstoned inputs", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  await f.put("changed.md", note("edited"));
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop, "--exclude-heading", "Private");
  const manifest = await f.manifest(receipt.generation);
  assert.deepEqual(manifest.bootstrap.imported, { notes: 1, sections: 2 });
  assert.equal(manifest.bootstrap.verification.status, "passed");
  assert.equal(manifest.bootstrap.verification.sampleCount, 3);
  assert.equal(manifest.bootstrap.verification.medianCosine, 1);
  assert.equal(manifest.bootstrap.encoded.notes, 3);
  assert.equal(manifest.stats.encoded, f.requests.length - 3);
  assert.equal(await f.current(), receipt.generation);
  const loaded = await f.load(receipt.generation);
  assert.equal(loaded.notes.length, 4);
  assert.ok(f.requests.every(row => !row.input.includes("Removed from the input")));
  f.requests.length = 0;
  const incremental = await f.run("--exclude-heading", "Private");
  assert.equal(incremental.encoded, 0);
  assert.equal(f.requests.length, 0);
  await f.fail(/requires an index without CURRENT/u, "bootstrap", "--from-smart-env", desktop);
  assert.equal(await f.current(), incremental.generation);
  assert.equal(f.requests.length, 0);
});

test("bootstrap records published rows when the encoder skips a note with an importable section", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  f.transformRow((row, item) => item.source_path === "excluded.md"
    ? { ...row, truncated: true, tokens: f.health.max_tokens } : row);
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop, "--exclude-heading", "Private");
  const { bootstrap, stats, skipped } = await f.manifest(receipt.generation);
  assert.deepEqual(skipped, [{ path: "excluded.md", reason: "document_too_long" }]);
  assert.equal(bootstrap.imported.sections, 2);
  assert.equal(stats.notes + stats.sections, stats.imported + stats.encoded);
  const loaded = await f.load(receipt.generation);
  assert.ok(!loaded.blocks.refs.some(row => row.notePath === "excluded.md"));
});

test("bootstrap queues all rows when the Smart Env fingerprint differs", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f, { maxTokens: 512 });
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop);
  const { bootstrap, stats } = await f.manifest(receipt.generation);
  assert.deepEqual(bootstrap.imported, { notes: 0, sections: 0 });
  assert.equal(bootstrap.verification.status, "no-imports");
  assert.equal(stats.encoded, stats.notes + stats.sections);
});

test("bootstrap refuses publication on one bad sampled vector before encoding any misses", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  f.transformRow((row, item) => item.source_path === "fresh.md" ? { ...row, vector: row.vector.reverse() } : row);
  await f.fail(/Bootstrap verification failed/u, "bootstrap", "--from-smart-env", desktop);
  await assert.rejects(f.current(), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(f.index, "generations")), []);
  assert.ok(f.requests.every(row => !row.source_path.startsWith("deleted.md")));
});

test("bootstrap verification-only measures coverage without encoding misses or publishing", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  await f.put("invalid.md", Buffer.from([0xff]));
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop, "--verify-only", "--max-samples", "38");
  assert.deepEqual(receipt.imported, { notes: 3, sections: 3 });
  assert.deepEqual(receipt.toEncode, { notes: 1, sections: 7 });
  assert.deepEqual(receipt.sectionSelection, {
    shared: 3, smartEnvOnly: 1, producerOnly: 7, smartEnvOutsideCorpus: 1,
  });
  assert.deepEqual(receipt.excludedNotes, { invalidPath: 0, invalidUtf8: 1 });
  assert.equal(f.requests.length, 6);
  await assert.rejects(f.current(), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(f.index, "generations")), []);
});

test("bootstrap stops when the bridge serves the sample from its cache", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  f.transformRow(row => ({ ...row, cache_hit: true }));
  const result = await f.start("bootstrap", "--from-smart-env", desktop, "--verify-only").result;
  assert.equal(result.error?.code, 1);
  assert.match(result.stderr, /requires uncached/u);
  assert.equal(JSON.parse(result.stdout).verification.status, "incomplete");
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.current(), { code: "ENOENT" });
});
