#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { modelFingerprint, smartTextHash } from "../dist/services/smartEnvV3.js";
import { bitnetClient, isSha256 } from "./semantic-index/bitnet.mjs";
import { defaultSampleLimit, maxSampleLimit, scanBootstrap, verifyBootstrap } from "./semantic-index/bootstrap.mjs";
import { exclusionMatcher, readSmartEnvSelection } from "./semantic-index/smart-env-selection.mjs";
import {
  currentFile, jsonLine, readActiveGeneration, readManifest, readVector, sealGeneration, sourceFile,
  sourceLine, syncDirectory, validateGeneration, vectorFiles, writeSynced,
} from "./semantic-index/generation.mjs";
import { inventory, parserRevision, readSourceParts, resolveRoots, sha256, verifySources } from "./semantic-index/vault.mjs";
import { runIndexService } from "./semantic-index/service.mjs";

const help = `Usage: optimike-semantic-index --vault DIR --index DIR --endpoint ORIGIN
       --model ID --revision REV --model-sha256 SHA256 [--rebuild]
       [--exclude-path RELATIVE/PATH]... [--exclude-heading TITLE]...
       [--min-note-chars N] [--min-block-chars N]
       [--max-deletion-percent 10] [--max-deletions 50]
       [--allow-deletions]

       optimike-semantic-index service <same options, except --rebuild>
       [--poll-ms 15000] [--debounce-ms 5000]

       optimike-semantic-index bootstrap --from-smart-env DIR --vault DIR
       --index DIR --endpoint ORIGIN --model ID --revision REV
       --model-sha256 SHA256 [--verify-only] [--max-samples 20..500]
       [--allow-selection-mismatch]
       [--exclude-path RELATIVE/PATH]... [--exclude-heading TITLE]...
       [--min-note-chars N] [--min-block-chars N]

Build and publish a Smart Environment v3 document index outside the vault.
Bootstrap requires an index without CURRENT and adopts the source's Smart
Environment selection settings. --verify-only reports coverage and sample
agreement without encoding the remaining rows or publishing.
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
      rows.set(source.note.inputSha256, { kind: "notes", row: source.note.row, provenance: source.note.provenance });
      for (const block of Object.values(source.blocks)) {
        rows.set(block.inputSha256, { kind: "sections", row: block.row, provenance: block.provenance });
      }
    }
  }
  return rows;
}

async function populate(staging, vault, scan, client, manifest, previous, hashes, imported) {
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
    const prepare = (entry, part) => ({ ...part, relative: entry.relative, source: entry.source, inputSha256: sha256(part.input) });
    async function writeParts(parts, kind) {
      const importedRowFor = part => imported?.get(part.relative)?.get(part.key);
      for (let start = 0; start < parts.length; start += batchSize) {
        const batch = parts.slice(start, start + batchSize);
        const misses = batch.filter(part => !importedRowFor(part) && !cached.has(part.inputSha256));
        const encoded = misses.length ? await client.encode(misses, manifest) : [];
        let next = 0;
        for (const part of batch) {
          const existing = cached.get(part.inputSha256);
          const importedRow = importedRowFor(part);
          if (importedRow && importedRow.inputSha256 !== part.inputSha256) {
            throw Error("Imported input changed during bootstrap");
          }
          const row = importedRow?.vector ?? (existing
            ? await readVector(input[existing.kind], existing.row, model.dimensions) : encoded[next++]);
          if (row === null) {
            skipped.push({ path: part.relative, reason: "document_too_long", ...(part.key && { blockKey: part.key }) });
            continue;
          }
          await output[kind].writeFile(row);
          digests[kind].update(row);
          const provenance = importedRow ? "sc-hash32" : existing?.provenance;
          const ref = { row: stats[kind]++, readHash: smartTextHash(part.text), inputSha256: part.inputSha256,
            ...(provenance && { provenance }) };
          if (part.key) part.source.blocks[part.key] = { ...ref, lines: part.range };
          else part.source.note = ref;
          const disposition = importedRow ? "imported" : existing ? "reused" : "encoded";
          stats[disposition]++;
          if (manifest.bootstrap && disposition !== "reused") manifest.bootstrap[disposition][kind]++;
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
      const { digest, parts, reason } = await readSourceParts(vault, relative, expected, chunking);
      hashes.set(relative, digest);
      if (!parts) {
        skipped.push({ path: relative, reason });
        continue;
      }
      const { tags, note, blocks } = parts;
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

async function build(options, vault, index, client, smartEnv) {
  const id = "g-" + randomUUID();
  const generations = path.join(index, "generations");
  const staging = path.join(index, ".staging-" + id);
  const pending = path.join(index, ".CURRENT-" + id);
  const target = path.join(generations, id);
  const previous = await readActiveGeneration(index);
  if (smartEnv && previous) throw Error("Bootstrap requires an index without CURRENT");
  const smartEnvSelection = smartEnv ? await readSmartEnvSelection(smartEnv)
    : previous?.manifest.chunking.smartEnvSelection;
  const excludedByProfile = exclusionMatcher(smartEnvSelection);
  const scan = await inventory(vault, options["exclude-path"], excludedByProfile);
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
  function guardDeletions(count, detail) {
    if (!options["allow-deletions"] && (count > options["max-deletions"] ||
        count * 100 > activePaths.length * options["max-deletion-percent"])) {
      throw Error(`Deletion limit exceeded (${count} of ${activePaths.length} active notes ${detail}). Verify the vault before using --allow-deletions`);
    }
  }
  guardDeletions(activePaths.filter(relative => !scan.files.has(relative)).length, "missing or reader-incompatible");
  const profile = await client.profile();
  const chunking = {
    version: smartEnvSelection ? "smart-env-v3-selection-v2" : "bitnet-markdown-v3",
    jsbrains: parserRevision,
    notes: "breadcrumb + full Markdown, removing excluded heading lines",
    minNoteChars: (options["min-note-chars"] ?? smartEnvSelection?.minNoteChars) || 300,
    sections: smartEnvSelection ? "Smart Environment v3 range selection outside frontmatter and excluded headings"
      : "SmartBlock.should_embed selection outside frontmatter and excluded heading ranges",
    minBlockChars: options["min-block-chars"] ?? smartEnvSelection?.minBlockChars ?? 300,
    overLength: "skip inputs that exceed the BitNet context",
    excludedPaths: [...new Set(options["exclude-path"])].sort(),
    excludedHeadings: [...new Set([...(smartEnvSelection?.headings ?? []), ...options["exclude-heading"]])].sort(),
    ...(smartEnvSelection && { smartEnvSelection, blockMaxTokens: profile.model.max_tokens }),
  };
  const lockHash = sha256(JSON.stringify({ ...profile, chunking }));
  const fingerprint = modelFingerprint(profile.model);
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
    inventoryStamps: Object.fromEntries([...scan.files, ...scan.unsafePaths]),
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
  async function verifyProfile() {
    if (sha256(JSON.stringify({ ...await client.profile(), chunking })) !== lockHash) {
      throw Error("BitNet identity changed during build");
    }
    if (smartEnv && JSON.stringify(await readSmartEnvSelection(smartEnv)) !== JSON.stringify(smartEnvSelection)) {
      throw Error("Smart Environment selection settings changed during build");
    }
  }
  let imported;
  if (smartEnv) {
    const bootstrap = await scanBootstrap(smartEnv, vault, scan, manifest);
    const { sectionsWithRuleMismatch } = bootstrap.report;
    if (sectionsWithRuleMismatch && !options["verify-only"] && !options["allow-selection-mismatch"]) {
      throw Error(`Smart Environment selection rule mismatch for ${sectionsWithRuleMismatch} section(s). Use --verify-only to inspect the scan or --allow-selection-mismatch to re-encode those sections`);
    }
    try {
      await verifyBootstrap(bootstrap, vault, scan, client, manifest, Number(options["max-samples"] ?? defaultSampleLimit));
      await verifyProfile();
    } catch (error) {
      if (options["verify-only"]) console.log(JSON.stringify(bootstrap.report));
      throw error;
    }
    if (options["verify-only"]) return { receipt: bootstrap.report };
    imported = bootstrap.rows;
    const { source, modelMatched, verification, sectionSelection } = bootstrap.report;
    manifest.bootstrap = {
      source, modelMatched, imported: { notes: 0, sections: 0 }, encoded: { notes: 0, sections: 0 },
      verification, sectionSelection, sectionsWithRuleMismatch,
    };
    manifest.stats.imported = 0;
  }
  const directories = ["smart_sources", "smart_blocks", "embedding_models"];
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const directory of directories) await mkdir(path.join(staging, directory), { mode: 0o700 });
    const digests = await populate(staging, vault, scan, client, manifest, reusable, hashes, imported);
    const belowMinimum = new Set(skipped.filter(item => item.reason === "note_below_min_size").map(item => item.path));
    const deletions = activePaths.filter(relative => !manifest.sources[relative] && !belowMinimum.has(relative)).length;
    guardDeletions(deletions, "not publishable");
    requireNotes(manifest.stats.notes);
    manifest.builtAt = new Date().toISOString();
    manifest.coverage = { indexedNotes: manifest.stats.notes, candidateNotes: scan.files.size + scan.unsafePaths.size,
      indexedSections: manifest.stats.sections };
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
    await verifyProfile();
    await verifySources(vault, options["exclude-path"], scan, hashes, excludedByProfile);
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
    return {
      publication: { directory: target, manifest },
      receipt: { generation: id, ...manifest.stats, deletions, skipped: manifest.skipped },
    };
  } finally {
    // Leave any sealed generation intact. Readers may still hold a previous CURRENT.
    await rm(staging, { recursive: true, force: true });
    await rm(pending, { force: true });
  }
}

async function main() {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
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
    "min-note-chars": { type: "string" },
    "min-block-chars": { type: "string" },
    "from-smart-env": { type: "string" },
    "verify-only": { type: "boolean" },
    "max-samples": { type: "string" },
    "allow-selection-mismatch": { type: "boolean" },
    "poll-ms": { type: "string" },
    "debounce-ms": { type: "string" },
    "exclude-path": { type: "string", multiple: true, default: [] },
    "exclude-heading": { type: "string", multiple: true, default: [] },
  } });
  if (options.help) {
    console.log(help);
    return;
  }
  const bootstrap = positionals.length === 1 && positionals[0] === "bootstrap";
  const service = positionals.length === 1 && positionals[0] === "service";
  if (bootstrap ? !options["from-smart-env"]?.trim() || options.rebuild
    : (!service && positionals.length) || (service && options.rebuild) ||
      options["from-smart-env"] !== undefined || options["verify-only"] ||
      options["allow-selection-mismatch"]) {
    throw Error("Invalid bootstrap options. Run with --help");
  }
  for (const [name, fallback, minimum] of [["poll-ms", "15000", 50], ["debounce-ms", "5000", 0]]) {
    const raw = options[name];
    if (!service && raw !== undefined) throw Error(`--${name} requires service mode`);
    const value = Number(raw ?? fallback);
    if (!/^\d+$/u.test(raw ?? fallback) || value < minimum || value > 300_000) {
      throw Error(`--${name} must be an integer from ${minimum} to 300000`);
    }
    options[name] = value;
  }
  if (options["max-samples"] !== undefined && (!bootstrap || !/^\d{2,3}$/u.test(options["max-samples"]) ||
      Number(options["max-samples"]) < 20 || Number(options["max-samples"]) > maxSampleLimit)) {
    throw Error(`--max-samples requires bootstrap and an integer from 20 to ${maxSampleLimit}`);
  }
  if (["vault", "index", "endpoint", "model", "revision"].some(key => !options[key]?.trim()) ||
      !isSha256(options["model-sha256"])) throw Error("Missing or invalid required option. Run with --help");
  if (options["exclude-path"].some(relative => relative.includes("\\") ||
      relative.split("/").some(part => !part || part === "." || part === ".."))) {
    throw Error("Exclusions must be vault-relative paths with forward slashes");
  }
  if (options["exclude-heading"].some(title => !title.trim())) throw Error("Heading exclusions must be nonempty");
  for (const [key, max] of [["max-deletions", Number.MAX_SAFE_INTEGER], ["max-deletion-percent", 100],
    ["min-note-chars", Number.MAX_SAFE_INTEGER], ["min-block-chars", Number.MAX_SAFE_INTEGER]]) {
    if (options[key] === undefined) continue;
    const value = Number(options[key]);
    if (!/^\d+$/u.test(options[key]) || !Number.isSafeInteger(value) || value > max) {
      throw Error(`--${key} must be an integer from 0 to ${max}`);
    }
    options[key] = value;
  }
  const client = bitnetClient(options.endpoint, options.model, options.revision, options["model-sha256"]);
  const { vault, index } = await resolveRoots(options.vault, options.index);
  const smartEnv = bootstrap ? (await resolveRoots(options["from-smart-env"], index)).vault : undefined;
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
    if (service) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        await runIndexService({
          index, active: await readActiveGeneration(index),
          scan: active => inventory(vault, options["exclude-path"],
            exclusionMatcher(active?.manifest.chunking.smartEnvSelection)),
          build: async () => (await build(options, vault, index, client)).publication,
          pollMs: options["poll-ms"], debounceMs: options["debounce-ms"], signal: controller.signal,
        });
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    } else {
      console.log(JSON.stringify((await build(options, vault, index, client, smartEnv)).receipt));
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch(error => {
  // Filesystem errors include local paths. Emit only their code.
  console.error("Semantic index producer:", error.code?.startsWith("EMBEDDING_") ? error.message : error.code ?? error.message);
  process.exitCode = 1;
});
