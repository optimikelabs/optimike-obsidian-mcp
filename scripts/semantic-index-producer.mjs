#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { smartTextHash } from "../dist/services/smartEnvV3.js";
import { bitnetClient, isSha256 } from "./semantic-index/bitnet.mjs";
import {
  currentFile, jsonLine, readActiveGeneration, readManifest, readVector, sealGeneration, sourceFile,
  sourceLine, syncDirectory, validateGeneration, vectorFiles, writeSynced,
} from "./semantic-index/generation.mjs";
import { inventory, parserRevision, readSource, resolveRoots, sha256, sourceParts, verifySources } from "./semantic-index/vault.mjs";

const help = `Usage: optimike-semantic-index --vault DIR --index DIR --endpoint ORIGIN
       --model ID --revision REV --model-sha256 SHA256 [--rebuild]
       [--exclude-path RELATIVE/PATH]... [--exclude-heading TITLE]...
       [--min-block-chars 250] [--max-deletion-percent 10] [--max-deletions 50]
       [--allow-deletions]

Build and publish a Smart Environment v3 document index outside the vault.
`;

async function withFiles(callback) {
  const handles = [];
  try {
    return await callback(async (...options) => {
      const handle = await open(...options);
      handles.push(handle);
      return handle;
    });
  } finally {
    await Promise.all(handles.map(handle => handle.close()));
  }
}

function previousRows(manifest) {
  const rows = new Map();
  if (manifest) {
    for (const source of Object.values(manifest.sources)) {
      rows.set(source.note.inputSha256, { kind: "notes", row: source.note.row });
      for (const block of Object.values(source.blocks)) {
        rows.set(block.inputSha256, { kind: "sections", row: block.row });
      }
    }
  }
  return rows;
}

async function populate(staging, vault, scan, client, manifest, previous, hashes) {
  const { fingerprint, stats, sources, chunking, model, skipped } = manifest;
  const files = vectorFiles(fingerprint);
  const digests = { notes: createHash("sha256"), sections: createHash("sha256") };
  await withFiles(async openFile => {
    const output = {
      notes: await openFile(path.join(staging, files.notes), "wx", 0o600),
      sections: await openFile(path.join(staging, files.sections), "wx", 0o600),
    };
    const metadata = await openFile(path.join(staging, sourceFile), "wx", 0o600);
    const cached = previousRows(previous?.manifest);
    const input = previous && {
      notes: await openFile(path.join(previous.directory, files.notes), "r"),
      sections: await openFile(path.join(previous.directory, files.sections), "r"),
    };
    const batchSize = manifest.identity.documentDevice === "cuda" ? 4 : 1;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const prepare = (entry, part) => ({ ...part, relative: entry.relative, source: entry.source, inputSha256: sha256(part.input) });
    async function writeParts(parts, kind) {
      for (let start = 0; start < parts.length; start += batchSize) {
        const batch = parts.slice(start, start + batchSize);
        const misses = batch.filter(part => !cached.has(part.inputSha256));
        const encoded = misses.length ? await client.encode(misses, manifest) : [];
        let next = 0;
        for (const part of batch) {
          const existing = cached.get(part.inputSha256);
          const row = existing ? await readVector(input[existing.kind], existing.row, model.dimensions) : encoded[next++];
          if (row === null) {
            skipped.push({ path: part.relative, reason: "document_too_long", ...(part.key && { blockKey: part.key }) });
            continue;
          }
          await output[kind].writeFile(row);
          digests[kind].update(row);
          const ref = { row: stats[kind]++, readHash: smartTextHash(part.text), inputSha256: part.inputSha256 };
          if (part.key) part.source.blocks[part.key] = { ...ref, lines: part.range };
          else part.source.note = ref;
          stats[existing ? "reused" : "encoded"]++;
        }
      }
    }
    // Encode notes across files first, so a refused note never leaves orphan
    // block rows. Keep only a bounded window of parsed notes in memory.
    async function writeWindow(entries) {
      await writeParts(entries.map(entry => prepare(entry, entry.note)), "notes");
      const accepted = entries.filter(entry => entry.source.note);
      await writeParts(accepted.flatMap(entry => entry.blocks.map(part => prepare(entry, part))), "sections");
      for (const { relative, source } of accepted) {
        sources[relative] = source;
        await metadata.writeFile(sourceLine(relative, source, fingerprint));
      }
    }
    let window = [];
    for (const [relative, expected] of scan.files) {
      const bytes = await readSource(vault, relative, expected);
      const digest = sha256(bytes);
      hashes.set(relative, digest);
      let text;
      try {
        text = decoder.decode(bytes);
      } catch (error) {
        if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
        skipped.push({ path: relative, reason: "invalid_utf8" });
        continue;
      }
      const { tags, note, blocks } = sourceParts(relative, text, chunking.excludedHeadings, chunking.minBlockChars);
      const source = { sha256: digest, tags, note: null, blocks: Object.create(null) };
      window.push({ relative, source, note, blocks });
      if (window.length === batchSize) {
        await writeWindow(window);
        window = [];
      }
    }
    await writeWindow(window);
    await Promise.all([metadata.sync(), output.notes.sync(), output.sections.sync()]);
  });
  return Object.fromEntries(Object.entries(digests).map(([kind, hash]) => [kind, hash.digest("hex")]));
}

async function build(options, vault, index, client) {
  const id = "g-" + randomUUID();
  const generations = path.join(index, "generations");
  const staging = path.join(index, ".staging-" + id);
  const pending = path.join(index, ".CURRENT-" + id);
  const target = path.join(generations, id);
  const previous = await readActiveGeneration(index);
  const scan = await inventory(vault, options["exclude-path"]);
  if (previous && previous.manifest.vaultBinding !== scan.binding) {
    throw Error("Vault root or volume differs from the active generation");
  }
  const skipped = [...scan.unsafePaths.keys()].map(relative => ({ path: relative, reason: "invalid_note_path" }));
  function requireNotes(count) {
    if (!count) {
      const summary = skipped.length ? ` Skipped: ${JSON.stringify(skipped)}` : "";
      throw Error("An external semantic generation requires at least one Markdown note." + summary);
    }
  }
  requireNotes(scan.files.size);
  const activePaths = Object.keys(previous?.manifest.sources ?? {});
  const deletions = activePaths.filter(relative => !scan.files.has(relative) && !scan.unsafePaths.has(relative)).length;
  if (!options["allow-deletions"] && (deletions > options["max-deletions"] ||
      deletions * 100 > activePaths.length * options["max-deletion-percent"])) {
    throw Error(`Deletion limit exceeded (${deletions} of ${activePaths.length} active notes missing). Verify the vault before using --allow-deletions`);
  }
  const chunking = {
    version: "bitnet-markdown-v2",
    jsbrains: parserRevision,
    notes: "breadcrumb + full Markdown, removing excluded heading lines",
    sections: "SmartBlock.should_embed selection outside frontmatter and excluded heading ranges",
    minBlockChars: options["min-block-chars"],
    overLength: "skip inputs that exceed the BitNet context",
    excludedPaths: [...new Set(options["exclude-path"])].sort(),
    excludedHeadings: [...new Set(options["exclude-heading"])].sort(),
  };
  const profile = await client.profile();
  const lockHash = sha256(JSON.stringify({ ...profile, chunking }));
  const fingerprint = "mf_" + smartTextHash(JSON.stringify(profile.model));
  if (previous && !options.rebuild && (previous.manifest.lockHash !== lockHash ||
      previous.manifest.fingerprint !== fingerprint)) {
    throw Error("Encoding profile changed. Use --rebuild to encode every document under the new profile");
  }
  const reusable = options.rebuild ? null : previous;
  if (reusable) await validateGeneration(reusable.directory, reusable.manifest);

  const manifest = {
    version: 1,
    generation: id,
    createdAt: new Date().toISOString(),
    ...profile,
    chunking,
    vaultBinding: scan.binding,
    fingerprint,
    lockHash,
    sources: Object.create(null),
    skipped,
    stats: { notes: 0, sections: 0, encoded: 0, reused: 0 },
  };
  const hashes = new Map();
  const directories = ["smart_sources", "smart_blocks", "embedding_models"];
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const directory of directories) await mkdir(path.join(staging, directory), { mode: 0o700 });
    const digests = await populate(staging, vault, scan, client, manifest, reusable, hashes);
    requireNotes(manifest.stats.notes);
    await sealGeneration(staging, manifest);
    const persisted = await readManifest(staging, id);
    if (persisted.vectors.notes.sha256 !== digests.notes || persisted.vectors.sections.sha256 !== digests.sections) {
      throw Error("Persisted vectors do not match encoded rows");
    }
    await validateGeneration(staging, persisted);
    for (const directory of directories) await syncDirectory(path.join(staging, directory));
    await syncDirectory(staging);
    await rename(staging, target);
    await syncDirectory(generations);

    await writeSynced(pending, id + "\n");
    if (sha256(JSON.stringify({ ...await client.profile(), chunking })) !== lockHash) {
      throw Error("BitNet identity changed during build");
    }
    await verifySources(vault, options["exclude-path"], scan, hashes);
    try {
      await rename(pending, path.join(index, currentFile));
    } catch (error) {
      throw Error(`CURRENT replacement failed (${error.code}); the previous pointer was preserved`);
    }
    try {
      await syncDirectory(index);
    } catch (error) {
      console.error("CURRENT was replaced, but syncing its directory failed:", error.code);
      process.exitCode = 1;
    }
    return { generation: id, ...manifest.stats, deletions, skipped: manifest.skipped };
  } finally {
    // Leave any sealed generation intact. Readers may still hold a previous CURRENT.
    await rm(staging, { recursive: true, force: true });
    await rm(pending, { force: true });
  }
}

async function main() {
  const { values: options } = parseArgs({ options: {
    help: { type: "boolean", short: "h" },
    vault: { type: "string" },
    index: { type: "string" },
    endpoint: { type: "string" },
    model: { type: "string" },
    revision: { type: "string" },
    "model-sha256": { type: "string" },
    rebuild: { type: "boolean" },
    "allow-deletions": { type: "boolean" },
    "max-deletions": { type: "string", default: "50" },
    "max-deletion-percent": { type: "string", default: "10" },
    "min-block-chars": { type: "string", default: "250" },
    "exclude-path": { type: "string", multiple: true, default: [] },
    "exclude-heading": { type: "string", multiple: true, default: [] },
  } });
  if (options.help) {
    console.log(help);
    return;
  }
  if (["vault", "index", "endpoint", "model", "revision"].some(key => !options[key]?.trim()) ||
      !isSha256(options["model-sha256"])) throw Error("Missing or invalid required option. Run with --help");
  if (options["exclude-path"].some(relative => relative.includes("\\") ||
      relative.split("/").some(part => !part || part === "." || part === ".."))) {
    throw Error("Exclusions must be vault-relative paths with forward slashes");
  }
  if (options["exclude-heading"].some(title => !title.trim())) throw Error("Heading exclusions must be nonempty");
  for (const [key, max] of [["max-deletions", Number.MAX_SAFE_INTEGER], ["max-deletion-percent", 100],
    ["min-block-chars", Number.MAX_SAFE_INTEGER]]) {
    const value = Number(options[key]);
    if (!/^\d+$/u.test(options[key]) || !Number.isSafeInteger(value) || value > max) {
      throw Error(`--${key} must be an integer from 0 to ${max}`);
    }
    options[key] = value;
  }
  const client = bitnetClient(options.endpoint, options.model, options.revision, options["model-sha256"]);
  const { vault, index } = await resolveRoots(options.vault, options.index);
  await mkdir(index, { recursive: true, mode: 0o700 });
  if (await realpath(index) !== index) throw Error("Index path changed during setup");
  const lockPath = path.join(index, ".producer.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      let owner;
      try {
        const info = await lstat(lockPath);
        if (info.isFile() && info.size <= 256) {
          const { pid, startedAt } = JSON.parse(await readFile(lockPath, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0 && typeof startedAt === "string" &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(startedAt)) {
            owner = ` (PID ${pid}, started ${startedAt})`;
          }
        }
      } catch {
        // A newly acquired or released lock may have no readable owner yet.
      }
      throw Error("Index already has a producer lock" + (owner ?? ""));
    }
    throw error;
  }
  try {
    await lock.writeFile(jsonLine({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.sync();
    const generations = path.join(index, "generations");
    await mkdir(generations, { recursive: true, mode: 0o700 });
    if (!(await lstat(generations)).isDirectory() || await realpath(generations) !== generations) {
      throw Error("Generations path must be a regular directory under the index root");
    }
    console.log(JSON.stringify(await build(options, vault, index, client)));
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch(error => {
  // Filesystem errors include local paths. Emit only their code.
  console.error("Semantic index producer:", error.code ?? error.message);
  process.exitCode = 1;
});
