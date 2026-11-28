import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, utimes, watch, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSmartEnvV3, smartTextHash } from "../dist/services/smartEnvV3.js";
import { scanBootstrap } from "./semantic-index/bootstrap.mjs";
import { selectSmartEnvBlocks } from "./semantic-index/smart-env-selection.mjs";
import { inventory } from "./semantic-index/vault.mjs";
import { pruneGenerations } from "./semantic-index/service.mjs";

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
  let beforeEncodeMatches;
  let transformRow = row => row;
  let refuseBatch = () => false;
  let serviceBusy = false;
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
      if (beforeEncode && beforeEncodeMatches(items)) {
        const callback = beforeEncode;
        beforeEncode = undefined;
        await callback();
      }
      if (serviceBusy) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: "busy" }));
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
      "--disable-warning=ExperimentalWarning", cli,
      "--vault", vault, "--index", index, "--endpoint", `http://127.0.0.1:${server.address().port}`,
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
  const state = async () => JSON.parse(await readFile(path.join(index, "SERVICE.json"), "utf8")
    .catch(error => { if (error.code !== "ENOENT") throw error; return "null"; }));
  async function until(predicate) {
    const events = watch(index, { signal: AbortSignal.timeout(15_000) });
    try {
      const status = await state();
      if (status && predicate(status)) return status;
      for await (const { filename } of events) {
        if (filename && filename !== "SERVICE.json") continue;
        const next = await state();
        if (next && predicate(next)) return next;
      }
    } finally {
      await events.return();
    }
    assert.fail("Service observation never matched: " + JSON.stringify(await state()));
  }
  async function withService(callback, ...args) {
    const service = start("service", "--poll-ms", "50", "--debounce-ms", "50", ...args);
    try {
      await callback(service);
    } finally {
      service.child.kill("SIGKILL");
      await service.result;
    }
  }
  return {
    root, vault, index, requests, batches, health, start, run, fail, put, current, generation, manifest, load,
    withService, until,
    beforeEncode(callback, matches = () => true) {
      beforeEncode = callback;
      beforeEncodeMatches = matches;
    },
    transformRow(callback) { transformRow = callback; },
    refuseBatch(callback) { refuseBatch = callback; },
    setBusy(value) { serviceBusy = value; },
  };
}

test("service polls changes, backs off, and atomically replaces the generation under the producer lock", async t => {
  const f = await fixture(t);
  await f.put("Edit.md", "# A\n\nOriginal.\n# B\n\nKept.\n");
  await f.put("Remove.md", note("Removed."));
  await f.put("Move.md", note("Moved."));
  const first = await f.run();
  const release = Promise.withResolvers();
  await f.withService(async service => {
    try {
      await f.until(status => status.pendingChanges === 0 && status.generation === first.generation);
      const unchangedRequests = f.requests.length;
      await f.fail(/already has a producer lock/u);
      assert.equal(f.requests.length, unchangedRequests, "an unchanged poll encodes nothing");
      f.setBusy(true);
      await f.put("Edit.md", "# A\n\nEdited.\n# B\n\nKept.\n");
      await unlink(path.join(f.vault, "Remove.md"));
      await rename(path.join(f.vault, "Move.md"), path.join(f.vault, "Moved.md"));
      const backedOff = await f.until(status => status.lastError === "embedding_busy");
      assert.equal(backedOff.pendingChanges, 4);
      assert.ok(backedOff.retryAt > backedOff.observedAt, "a busy response schedules a later build, independently of the next poll");
      assert.equal(await f.current(), first.generation, "a busy embedder must leave CURRENT intact");
      const attempts = f.requests.length;
      const arrived = Promise.withResolvers();
      f.beforeEncode(async () => { arrived.resolve(); await release.promise; });
      f.setBusy(false);
      await Promise.race([arrived.promise, service.result.then(result => assert.fail(result.stderr || "Service exited early"))]);
      assert.equal(await f.current(), first.generation, "readers see the old generation during embedding");
      release.resolve();
      const published = await f.until(status => status.generation !== first.generation && status.pendingChanges === 0);
      assert.equal(await f.current(), published.generation);
      assert.equal(published.lastError, null);
      assert.deepEqual((await f.load(published.generation)).notes.map(row => row.notePath).sort(), ["Edit.md", "Moved.md"]);
      assert.deepEqual((await f.load(first.generation)).notes.map(row => row.notePath).sort(), ["Edit.md", "Move.md", "Remove.md"]);
      assert.ok(f.requests.slice(attempts).every(row => !row.input.includes("Kept.") || row.entity_kind === "source"),
        "unchanged sections reuse their existing vectors");
      assert.equal((await f.manifest(published.generation)).coverage.indexedNotes, 2);
    } finally {
      release.resolve();
    }
  }, "--max-deletion-percent", "100");
});

test("service publishes consistent included notes despite a new arrival and keeps observing during embedding", async t => {
  const f = await fixture(t);
  const firstText = note("Original.");
  await f.put("Edit.md", firstText);
  const first = await f.run();
  const release = Promise.withResolvers();
  await f.withService(async service => {
    try {
      const initial = await f.until(status => status.generation === first.generation && status.pendingChanges === 0);
      const before = f.requests.length;
      await utimes(path.join(f.vault, "Edit.md"), new Date(1000), new Date(1000));
      const touchedAt = Date.now();
      const touched = await f.until(status => status.observedAt > Math.max(initial.observedAt, touchedAt));
      assert.equal(touched.pendingChanges, 0);
      assert.equal(await f.current(), first.generation);
      assert.equal(f.requests.length, before, "an mtime-only change needs no embedding");
      const arrived = Promise.withResolvers();
      f.beforeEncode(async () => { arrived.resolve(); await release.promise; });
      await f.put("Edit.md", note("Edited."));
      await Promise.race([arrived.promise, service.result.then(result => assert.fail(result.stderr || "Service exited early"))]);
      const inFlight = await f.until(status => status.generation === first.generation && status.pendingChanges === 1);
      await f.put("Arrival.md", note("Created while the encoder was busy."));
      await f.until(status => status.generation === first.generation && status.pendingChanges === 2 &&
        status.observedAt > inFlight.observedAt);
      const finishSecond = Promise.withResolvers();
      f.beforeEncode(() => finishSecond.promise, items => items.some(item => item.source_path === "Arrival.md"));
      release.resolve();
      try {
        const partial = await f.until(status => status.generation !== first.generation && status.pendingChanges === 1);
        assert.deepEqual(Object.keys((await f.manifest(partial.generation)).sources), ["Edit.md"]);
      } finally {
        finishSecond.resolve();
      }
      const converged = await f.until(status => status.generation !== first.generation && status.pendingChanges === 0);
      assert.deepEqual(Object.keys((await f.manifest(converged.generation)).sources), ["Arrival.md", "Edit.md"]);
    } finally {
      release.resolve();
    }
  });
});

test("included content drift is retried with the debounce instead of embedding backoff", async t => {
  const f = await fixture(t);
  await f.put("Edit.md", note("Original."));
  const first = await f.run();
  await f.withService(async () => {
    await f.until(status => status.generation === first.generation && status.pendingChanges === 0);
    f.beforeEncode(() => f.put("Edit.md", note("Final contents.")));
    await f.put("Edit.md", note("First edit."));
    const drift = await f.until(status => status.lastError === "source_drift");
    assert.equal(drift.retryAt, null, "source drift does not schedule exponential backoff");
    const next = await f.until(status => status.generation !== first.generation && status.pendingChanges === 0);
    assert.equal((await f.manifest(next.generation)).sources["Edit.md"].sha256, hash(note("Final contents.")));
    assert.deepEqual(new Set(await readdir(path.join(f.index, "generations"))), new Set([first.generation, next.generation]));
  }, "--debounce-ms", "200");
});

test("a changing note retains its published vectors while stable changes publish without duplicate encoding", async t => {
  const f = await fixture(t);
  await f.put("A-Hot.md", note("Original hot note"));
  await f.put("B-Stable.md", note("Original stable note"));
  const first = await f.run();
  const from = f.requests.length;
  const holdHot = Promise.withResolvers();
  await f.withService(async () => {
    try {
      await f.until(status => status.generation === first.generation && status.pendingChanges === 0);
      f.beforeEncode(async () => {
        await f.put("A-Hot.md", note("Second draft"));
        f.beforeEncode(() => holdHot.promise, items => items.some(item => item.input.includes("Second draft")));
      });
      await Promise.all([
        f.put("A-Hot.md", note("First draft")),
        f.put("B-Stable.md", note("Published change")),
      ]);
      const partial = await f.until(status => status.generation !== first.generation && status.pendingChanges === 1);
      const manifest = await f.manifest(partial.generation);
      assert.equal(manifest.sources["A-Hot.md"].sha256, hash(note("Original hot note")));
      assert.equal(manifest.sources["B-Stable.md"].sha256, hash(note("Published change")));
      assert.deepEqual((await f.load(partial.generation)).notes.map(row => row.notePath), ["A-Hot.md", "B-Stable.md"]);
      const encoded = f.requests.slice(from).filter(row => row.source_path.startsWith("B-Stable.md")).map(row => row.input);
      assert.ok(encoded.length > 0);
      assert.equal(encoded.length, new Set(encoded).size, "the rebuilt staging directory reuses encoded stable vectors");
    } finally {
      holdHot.resolve();
    }
  });
});

test("retirement keeps CURRENT, the newest retired generation, and generations within reader grace", async t => {
  const f = await fixture(t);
  await f.put("Edit.md", note("One"));
  const one = await f.run();
  await f.put("Edit.md", note("Two"));
  const two = await f.run();
  await pruneGenerations(f.index, two.generation, 1, 5000, 3, 1000);
  await f.put("Edit.md", note("Three"));
  const three = await f.run();
  assert.equal((await pruneGenerations(f.index, three.generation, 1, 5000, 3, 5999)).room, false);
  assert.equal((await f.load(one.generation)).notes[0].notePath, "Edit.md", "a pinned reader keeps access during grace");
  assert.equal((await pruneGenerations(f.index, three.generation, 1, 5000, 3, 6000)).room, true);
  assert.deepEqual(new Set(await readdir(path.join(f.index, "generations"))), new Set([two.generation, three.generation]));
  assert.equal(await f.current(), three.generation);
});

test("pruning enforces the configured hard cap even when older generations are in grace", async t => {
  const f = await fixture(t);
  for (const text of ["One", "Two", "Three", "Four"]) {
    await f.put("Edit.md", note(text));
    await f.run();
  }
  const current = await f.current();
  const result = await pruneGenerations(f.index, current, 1, 60_000, 3, 1000);
  const retained = await readdir(path.join(f.index, "generations"));
  assert.equal(result.room, false);
  assert.equal(retained.length, 3);
  assert.ok(retained.includes(current));
});

test("corrupt retirement state is quarantined and reported while the service keeps publishing", async t => {
  const f = await fixture(t);
  await f.put("Edit.md", note("Before"));
  const first = await f.run();
  const filename = path.join(f.index, "RETIREMENTS.json");
  await writeFile(filename, "null");
  await f.withService(async () => {
    await f.until(status => status.maintenanceWarning === "retirements_rebuilt");
    const entries = await readdir(f.index);
    const quarantine = entries.find(name => name.startsWith("RETIREMENTS.json.corrupt-"));
    assert.ok(quarantine);
    assert.equal(await readFile(path.join(f.index, quarantine), "utf8"), "null");
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), {});
    await f.put("Edit.md", note("After"));
    await f.until(status => status.generation !== first.generation && status.pendingChanges === 0);
  });
});

if (process.platform === "win32") {
  test("a Windows reader can deny status replacement without stopping publication", async t => {
    const f = await fixture(t);
    await f.put("Edit.md", note("Before"));
    const first = await f.run();
    const program = [
      "$stream = [IO.File]::Open($env:OPTIMIKE_TEST_STATUS, 'Open', 'Read', 'Read')",
      "try { [Console]::WriteLine('ready'); [void][Console]::ReadLine() } finally { $stream.Dispose() }",
    ].join("; ");
    await f.withService(async () => {
      await f.until(status => status.generation === first.generation && status.pendingChanges === 0);
      const reader = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", program], {
        windowsHide: true,
        env: { ...process.env, OPTIMIKE_TEST_STATUS: path.join(f.index, "SERVICE.json") },
      });
      const exited = once(reader, "close");
      try {
        const [output] = await Promise.race([once(reader.stdout, "data"), exited.then(() => assert.fail("Reader exited early"))]);
        assert.match(String(output), /ready/u);
        // CURRENT must change while the reader still denies deletion of SERVICE.json.
        await f.put("Edit.md", note("After"));
        const events = watch(f.index, { signal: AbortSignal.timeout(12_000) });
        try {
          if (await f.current() === first.generation) {
            for await (const { filename } of events) {
              if (filename === "CURRENT" && await f.current() !== first.generation) break;
            }
          }
        } finally {
          await events.return();
        }
        assert.notEqual(await f.current(), first.generation);
      } finally {
        reader.stdin.end("\n");
        await exited;
      }
      await f.until(status => status.generation !== first.generation && status.pendingChanges === 0);
    });
  });
}

test("service recognizes a rename and requires a fresh single-use authorization for deletion", async t => {
  const f = await fixture(t);
  for (const name of ["A", "B", "C"]) await f.put(name + ".md", note(name));
  const first = await f.run();
  const marker = path.join(f.index, "ALLOW_DELETIONS");
  await f.withService(async () => {
    await f.until(status => status.generation === first.generation && status.pendingChanges === 0);
    await rename(path.join(f.vault, "A.md"), path.join(f.vault, "Renamed.md"));
    const renamed = await f.until(status => status.generation !== first.generation && status.pendingChanges === 0);
    assert.ok((await f.manifest(renamed.generation)).sources["Renamed.md"]);
    await writeFile(marker, first.generation + "\n");
    await unlink(path.join(f.vault, "B.md"));
    await f.until(status => status.lastError === "deletion_guard");
    assert.equal(await f.current(), renamed.generation, "a marker for the previous generation cannot authorize deletion");
    await writeFile(marker, renamed.generation + "\n");
    const authorized = await f.until(status => status.generation !== renamed.generation && status.pendingChanges === 0);
    assert.ok(!(await readdir(f.index)).includes("ALLOW_DELETIONS"));
    await unlink(path.join(f.vault, "C.md"));
    await f.until(status => status.lastError === "deletion_guard");
    assert.equal(await f.current(), authorized.generation);
  }, "--max-deletions", "0");
});

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
  assert.deepEqual(await readdir(path.join(f.index, "generations")), [first.generation],
    "verification after sealing must remove the unpublished generation");
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
  await f.fail(/already has a producer lock/u);
  await utimes(path.join(f.index, ".producer.lock"), new Date(1000), new Date(1000));
  const recovered = await f.run();
  assert.equal(await f.current(), recovered.generation);
  assert.notEqual(recovered.generation, first.generation);
});

if (process.platform !== "win32") {
  test("a service stop aborts an in-flight encode and relinquishes the lease", async t => {
    const f = await fixture(t);
    await f.put("A.md", note("Before"));
    const first = await f.run();
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    await f.withService(async service => {
      try {
        await f.until(status => status.generation === first.generation && status.pendingChanges === 0);
        f.beforeEncode(async () => { arrived.resolve(); await release.promise; });
        await f.put("A.md", note("After"));
        await Promise.race([arrived.promise, service.result.then(result => assert.fail(result.stderr || "Service exited early"))]);
        assert.ok(service.child.kill("SIGTERM"));
        assert.ifError((await service.result).error);
        assert.equal(await f.current(), first.generation);
        assert.ok(!(await readdir(f.index)).includes(".producer.lock"));
      } finally {
        release.resolve();
      }
    });
  });
}

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

async function smartEnvFixture(f, { maxTokens = 256, settings = {}, extraNames = [], changeRule = (_, rule) => rule } = {}) {
  const directory = path.join(f.root, "desktop");
  for (const sub of ["smart_sources", "smart_blocks", "embedding_models"]) {
    await mkdir(path.join(directory, sub), { recursive: true });
  }
  const profile = { provider_key: "ollama", model_key: model, dimensions: 2, max_tokens: maxTokens };
  const fingerprint = "mf_" + smartTextHash(JSON.stringify(profile));
  await writeFile(path.join(directory, "smart_env.json"), JSON.stringify({
    embedding_models: { default_model_key: "fixture" },
    ...settings,
  }));
  await writeFile(path.join(directory, "embedding_models", "embedding_models.ajson"),
    '"embedding_models:fixture": ' + JSON.stringify(profile) + ',\n');
  const records = [];
  const notes = [];
  const sections = [];
  function addRow(rows, input, text, at) {
    const vector = Buffer.alloc(8);
    vector.writeFloatLE(1, parseInt(hash(input)[0], 16) % 2 * 4);
    const readHash = smartTextHash(text);
    const ref = { file: fingerprint, file_i: rows.length, read_hash: readHash, at };
    rows.push(vector);
    return { last_read: { hash: readHash }, embedding: { default: { [fingerprint]: ref } } };
  }
  for (const name of ["fresh", "changed", "excluded", "deleted", "outside", ...extraNames]) {
    const text = name === "excluded" ? "# Heading\n\nexcluded\n# Private\n\nRemoved from the input\n" : note(name);
    const relative = name + ".md";
    const at = name === "fresh" ? Date.UTC(2026, 9, 31, 23) : Date.UTC(2026, 10, 1);
    if (name !== "outside") await f.put(relative, text);
    const block = text.split("\n").slice(2, name === "excluded" ? 3 : 4).join("\n");
    const source = {
      path: relative,
      ...addRow(notes, name + ":\n" + text, text, at),
      block_embedding_selection: changeRule(name, {
        version: 2, min_chars: 0, max_input_chars: Math.floor(maxTokens * 3.7), source_key: relative,
        requires_reimport: false,
      }),
      blocks_data: {
        "#Heading": { lines: [1, name === "excluded" ? 3 : 4], should_embed: false },
        "#Heading#{1}": {
          lines: [3, name === "excluded" ? 3 : 4], size: block.length, should_embed: true,
          ...addRow(sections, name + " > Heading\n" + block, block, at),
        },
      },
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
  assert.equal(manifest.sources["fresh.md"].note.provenance, "sc-hash32");
  assert.equal(manifest.sources["fresh.md"].blocks["#Heading#{1}"].provenance, "sc-hash32");
  assert.equal(manifest.sources["changed.md"].note.provenance, undefined);
  assert.equal(manifest.stats.encoded, f.requests.length - 3);
  assert.equal(await f.current(), receipt.generation);
  const loaded = await f.load(receipt.generation);
  assert.equal(loaded.notes.length, 4);
  assert.ok(f.requests.every(row => !row.input.includes("Removed from the input")));
  assert.ok(loaded.blocks.refs.some(row => row.notePath === "fresh.md" && row.blockKey === "#Heading#{1}"));
  assert.ok(!loaded.blocks.refs.some(row => row.notePath === "fresh.md" && row.blockKey === "#Heading"));
  f.requests.length = 0;
  const incremental = await f.run("--exclude-heading", "Private");
  assert.equal(incremental.encoded, 0);
  assert.equal((await f.manifest(incremental.generation)).sources["fresh.md"].note.provenance, "sc-hash32");
  assert.equal(f.requests.length, 0);
  await f.fail(/requires an index without CURRENT/u, "bootstrap", "--from-smart-env", desktop);
  assert.equal(await f.current(), incremental.generation);
  assert.equal(f.requests.length, 0);
});

test("bootstrap records readable rows and protects active notes when a refresh refuses their encoding", async t => {
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
  assert.ok(!loaded.notes.some(row => row.notePath === "excluded.md"));
  assert.ok(!loaded.blocks.refs.some(row => row.notePath === "excluded.md"));

  await f.put("fresh.md", note("Changed after the bootstrap"));
  f.transformRow((row, item) => ["excluded.md", "fresh.md"].includes(item.source_path)
    ? { ...row, truncated: true, tokens: f.health.max_tokens } : row);
  await f.fail(/Deletion limit exceeded \(1 of 3 active notes not publishable\)/u, "--exclude-heading", "Private");
  assert.equal(await f.current(), receipt.generation);
  assert.deepEqual(await readdir(path.join(f.index, "generations")), [receipt.generation]);
  const refresh = await f.run("--exclude-heading", "Private", "--allow-deletions");
  const refreshed = await f.load(refresh.generation);
  assert.equal(refresh.deletions, 1);
  assert.ok(!refreshed.notes.some(row => row.notePath === "fresh.md"));
  assert.ok(!refreshed.blocks.refs.some(row => row.notePath === "fresh.md"));
});

test("bootstrap applies the producer's strict source size cutoff to note candidates", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  const args = ["bootstrap", "--from-smart-env", desktop, "--min-note-chars", String(note("fresh").length)];
  const preview = await f.run(...args, "--verify-only");
  assert.deepEqual(preview.excludedNotes, { invalidPath: 0, invalidUtf8: 0, belowMinSize: 1 });
  const receipt = await f.run(...args);
  const manifest = await f.manifest(receipt.generation);
  const loaded = await f.load(receipt.generation);
  assert.deepEqual(manifest.skipped, [{ path: "fresh.md", reason: "note_below_min_size" }]);
  assert.equal(manifest.bootstrap.imported.notes, 2);
  assert.ok(!loaded.notes.some(row => row.notePath === "fresh.md"));
  assert.ok(f.requests.every(item => !item.source_path.startsWith("fresh.md")));
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

test("bootstrap reports incompatible selection rules and requires explicit re-encoding to publish", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f, {
    changeRule(name, rule) {
      if (name === "fresh") return { ...rule, version: 3 };
      if (name === "changed") return { ...rule, min_chars: 1 };
      if (name === "excluded") return { ...rule, max_input_chars: rule.max_input_chars - 1 };
      if (name === "unversioned") return undefined;
      return rule;
    },
    extraNames: ["unversioned"],
  });
  const args = ["bootstrap", "--from-smart-env", desktop];
  const preview = await f.run(...args, "--verify-only");
  assert.equal(preview.sectionsWithRuleMismatch, 4);
  assert.deepEqual(preview.imported, { notes: 4, sections: 0 });
  await assert.rejects(f.current(), { code: "ENOENT" });
  f.requests.length = 0;
  await f.fail(/selection rule mismatch for 4 section\(s\)/u, ...args);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await readdir(path.join(f.index, "generations")), []);
  const receipt = await f.run(...args, "--allow-selection-mismatch", "--max-samples", "20");
  const manifest = await f.manifest(receipt.generation);
  assert.equal(manifest.bootstrap.sectionsWithRuleMismatch, 4);
  assert.deepEqual(manifest.bootstrap.imported, { notes: 4, sections: 0 });
  assert.equal(manifest.bootstrap.encoded.sections, 6);
  assert.ok(f.requests.some(row => row.source_path === "fresh.md#Heading#{1}"));
  assert.equal(manifest.sources["fresh.md"].blocks["#Heading#{1}"].provenance, undefined);
});

test("bootstrap samples a rare encoding month in both vector types within the configured cap", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f, { extraNames: Array.from({ length: 52 }, (_, index) => "recent-" + index) });
  const args = ["bootstrap", "--from-smart-env", desktop, "--verify-only"];
  await f.fail(/--max-samples requires bootstrap/u, "--max-samples", "20");
  await f.fail(/from 20 to 500/u, ...args, "--max-samples", "19");
  await f.fail(/from 20 to 500/u, ...args, "--max-samples", "501");

  const limited = await f.run(...args, "--max-samples", "20");
  assert.equal(limited.verification.sampleCount, 20);
  assert.deepEqual(limited.verification.strata, [
    { kind: "notes", period: "2026-10", candidates: 1, planned: 1, compared: 1 },
    { kind: "notes", period: "2026-11", candidates: 54, planned: 9, compared: 9 },
    { kind: "sections", period: "2026-10", candidates: 1, planned: 1, compared: 1 },
    { kind: "sections", period: "2026-11", candidates: 54, planned: 9, compared: 9 },
  ]);
  assert.ok(f.requests.some(row => row.source_path === "fresh.md"));
  assert.ok(f.requests.some(row => row.source_path === "fresh.md#Heading#{1}"));
  f.requests.length = 0;
  const standard = await f.run(...args);
  assert.equal(standard.verification.sampleCount, 100);
  assert.equal(f.requests.length, 100);
});

test("bootstrap re-encodes the renamed note and its section with the new breadcrumb", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f);
  await rename(path.join(f.vault, "fresh.md"), path.join(f.vault, "renamed.md"));
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop);
  const manifest = await f.manifest(receipt.generation);
  assert.equal(manifest.sources["fresh.md"], undefined);
  assert.equal(manifest.sources["renamed.md"].note.provenance, undefined);
  assert.deepEqual(f.requests.filter(row => row.source_path.startsWith("renamed.md")).map(row => row.input), [
    "renamed:\n" + note("fresh"),
    "renamed > Heading\nfresh\n",
  ]);
});

test("bootstrap detects a vector file change before accepting its scanned candidates", async t => {
  const f = await fixture(t);
  const desktop = await realpath(await smartEnvFixture(f));
  const profile = { provider_key: "ollama", model_key: model, dimensions: 2, max_tokens: 256 };
  const fingerprint = "mf_" + smartTextHash(JSON.stringify(profile));
  const vault = await realpath(f.vault);
  const scan = await inventory(vault, []);
  const entries = [...scan.files];
  scan.files[Symbol.iterator] = function* () {
    yield* entries;
    appendFileSync(path.join(desktop, "smart_sources", fingerprint), Buffer.alloc(8));
  };
  await assert.rejects(scanBootstrap(desktop, vault, scan, {
    fingerprint, model: profile,
    chunking: { minNoteChars: 1, minBlockChars: 0, excludedHeadings: [],
      smartEnvSelection: { embedBlocks: true }, blockMaxTokens: 256 },
  }), /Smart Environment changed during bootstrap scan/u);
});

test("Smart Environment range selection favors a child when the parent would lose more text", () => {
  const blocks = [
    ["#", [1, 2], "abcdefghijkl\nno", "Doc"],
    ["##{1}", [1, 1], "abcdefghijkl", "Doc"],
    ["##{2}", [2, 2], "no", "Doc"],
  ];
  assert.deepEqual([...selectSmartEnvBlocks(blocks, 3, 4)], ["##{1}"]);
  assert.deepEqual([...selectSmartEnvBlocks(blocks, 3, 5)], ["#"]);
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
  assert.deepEqual(receipt.toEncode, { notes: 1, sections: 2 });
  assert.deepEqual(receipt.sectionSelection, {
    shared: 3, smartEnvOnly: 1, producerOnly: 2, smartEnvOutsideCorpus: 1,
  });
  assert.deepEqual(receipt.excludedNotes, { invalidPath: 0, invalidUtf8: 1, belowMinSize: 0 });
  assert.equal(f.requests.length, 6);
  await assert.rejects(f.current(), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(f.index, "generations")), []);
});

test("bootstrap and its refresh mirror Smart Environment exclusions and Desktop fence keys", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f, { settings: {
    smart_sources: { file_exclusions_list: ["deleted.md"], folder_exclusions_list: ["hidden-*"] },
    smart_blocks: { embed_blocks: true, min_chars: 0 },
    gitignore_exclusions: ["build"],
  } });
  await mkdir(path.join(f.vault, "hidden-archive"));
  await mkdir(path.join(f.vault, "build"));
  await f.put("build/keep.md", note("The parent matches but this file does not"));
  await f.put("hidden-archive/keep.md", note("Excluded by folder glob"));
  await f.put("ignore#hash.md", note("Excluded by key syntax"));
  await f.put("fenced.md", "# Outer\n~~~\n# Desktop heading\nVisible content\n~~~");
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop);
  const loaded = await f.load(receipt.generation);
  assert.deepEqual(loaded.notes.map(row => row.notePath), ["build/keep.md", "changed.md", "excluded.md", "fenced.md", "fresh.md"]);
  assert.ok(loaded.blocks.refs.some(row => row.notePath === "fenced.md" && row.blockKey === "#Desktop heading#{1}"));
  assert.ok(f.requests.every(row => !/^(?:hidden-archive\/|ignore#hash\.md|deleted\.md)/u.test(row.source_path)));
  f.requests.length = 0;
  const refresh = await f.run();
  assert.equal(refresh.encoded, 0);
  assert.equal(f.requests.length, 0);
});

test("bootstrap honors disabled block embedding even when the store still has block vectors", async t => {
  const f = await fixture(t);
  const desktop = await smartEnvFixture(f, { settings: { smart_blocks: { embed_blocks: false } } });
  const receipt = await f.run("bootstrap", "--from-smart-env", desktop);
  assert.equal(receipt.notes, 4);
  assert.equal(receipt.sections, 0);
  assert.ok(f.requests.every(row => row.entity_kind === "source"));
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
