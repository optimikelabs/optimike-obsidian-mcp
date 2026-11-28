import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  modelFingerprint, readSmartEnvV3Model, readSmartEnvV3References, smartEnvV3SourceFiles, smartTextHash,
} from "../../dist/services/smartEnvV3.js";
import { readVector, vectorFiles } from "./generation.mjs";
import { noteInput, readSourceParts, sha256 } from "./vault.mjs";

const kinds = ["notes", "sections"];
const medianThreshold = 0.999;
const minThreshold = 0.995;

async function stamp(filename, directory = false) {
  let stat;
  try {
    stat = await lstat(filename, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!(directory ? stat.isDirectory() : stat.isFile()) || await realpath(filename) !== filename) {
    throw Error("Unsafe Smart Environment input path");
  }
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function snapshot(directory, fingerprint) {
  const directories = ["embedding_models", "smart_sources", "smart_blocks"];
  const entries = await Promise.all(directories.map(async name => [
    name, await stamp(path.join(directory, name), true),
  ]));
  const files = await smartEnvV3SourceFiles(directory);
  const inputFiles = [
    "smart_env.json",
    "embedding_models/embedding_models.ajson",
    ...files.map(file => "smart_sources/" + file),
    ...Object.values(vectorFiles(fingerprint)),
  ];
  const fileStamps = await Promise.all(inputFiles.map(async file => [
    file, await stamp(path.join(directory, file)),
  ]));
  return { files, stamps: JSON.stringify([...entries, ...fileStamps]), present: new Map(fileStamps) };
}

export async function scanBootstrap(directory, vault, scan, manifest) {
  const { fingerprint, model, chunking } = manifest;
  const imported = { notes: 0, sections: 0 };
  const toEncode = { notes: 0, sections: 0 };
  const rows = new Map();
  const selection = { shared: 0, smartEnvOnly: 0, producerOnly: 0, smartEnvOutsideCorpus: 0 };
  const excludedNotes = { invalidPath: scan.unsafePaths.size, invalidUtf8: 0, belowMinSize: 0 };
  const before = await snapshot(directory, fingerprint);
  const active = await readSmartEnvV3Model(directory);
  const modelMatched = active?.model_key === model.model_key && active.provider_key === model.provider_key &&
    Number(active.dims || active.dimensions) === model.dimensions &&
    Number(active.max_tokens) === model.max_tokens && modelFingerprint(active) === fingerprint;
  const handles = {};
  const rowCounts = {};
  try {
    const refs = modelMatched
      ? await readSmartEnvV3References(directory, before.files, fingerprint, { blocks: true, strict: true })
      : new Map();
    for (const [relative, source] of refs) {
      if (!scan.files.has(relative)) selection.smartEnvOutsideCorpus += source.blocks?.length ?? 0;
    }
    let importNotes = false;
    if (modelMatched) {
      let settings;
      try {
        settings = JSON.parse(await readFile(path.join(directory, "smart_env.json"), "utf8"));
      } catch {
        throw Error("Could not read Smart Environment settings during bootstrap");
      }
      const exclusions = settings?.smart_sources?.excluded_headings;
      // Without historical input hashes we only reconstruct unfiltered note inputs.
      importNotes = exclusions === undefined || exclusions === "";
      for (const [kind, file] of Object.entries(vectorFiles(fingerprint))) {
        if (!before.present.get(file)) continue;
        handles[kind] = await open(path.join(directory, file), "r");
        rowCounts[kind] = Math.floor((await handles[kind].stat()).size / (model.dimensions * 4));
      }
    }
    for (const [relative, expected] of scan.files) {
      const { parts, reason } = await readSourceParts(vault, relative, expected, chunking);
      const source = refs.get(relative);
      if (!parts) {
        if (reason === "note_below_min_size") excludedNotes.belowMinSize++;
        else excludedNotes.invalidUtf8++;
        selection.smartEnvOnly += source?.blocks?.length ?? 0;
        continue;
      }
      const { note, blocks } = parts;
      const fresh = source && source.readHash === smartTextHash(note.text);
      const blockRefs = new Map(source?.blocks?.map(block => [block.blockKey, block]));
      const shared = blocks.filter(block => blockRefs.has(block.key)).length;
      selection.shared += shared;
      selection.smartEnvOnly += blockRefs.size - shared;
      selection.producerOnly += blocks.length - shared;
      const matches = new Map();
      for (const part of [note, ...blocks]) {
        const kind = part.key ? "sections" : "notes";
        const row = part.key
          ? blockRow(part, fresh ? blockRefs.get(part.key) : undefined)
          : noteRow(relative, note, fresh && importNotes ? source : undefined, fingerprint);
        // Smart Connections does not record per-row truncation. Use a
        // conservative UTF-8 bound, allowing for special tokens and tokenizer
        // whitespace, and avoid the legacy char-capped Markdown input path.
        const vector = Number.isSafeInteger(row) && row >= 0 && row < rowCounts[kind] &&
          Buffer.byteLength(part.input, "utf8") + 4 <= model.max_tokens
          ? await readVector(handles[kind], row, model.dimensions, { allowInvalid: true })
          : null;
        if (vector) {
          matches.set(part.key, { vector, inputSha256: sha256(part.input) });
          imported[kind]++;
        } else {
          toEncode[kind]++;
        }
      }
      if (matches.size) rows.set(relative, matches);
    }
    if ((await snapshot(directory, fingerprint)).stamps !== before.stamps) {
      throw Error("Smart Environment changed during bootstrap scan. Use a stable copy or retry when idle");
    }
    return { rows, report: {
      source: "smart-env-v3", modelMatched, imported, toEncode, excludedNotes,
      sectionSelection: modelMatched ? selection : null,
    } };
  } finally {
    await Promise.all(Object.values(handles).map(handle => handle.close()));
  }
}

function noteRow(relative, note, source, fingerprint) {
  const reference = source?.reference;
  if (reference?.file === fingerprint && reference.read_hash === source.readHash &&
      note.input === noteInput(relative, note.text)) return reference.file_i;
}

function blockRow(part, ref) {
  if (ref && ref.lineStart === part.range[0] && ref.lineEnd === part.range[1] &&
      ref.readHash === smartTextHash(part.text)) return ref.fileIndex;
}

function sampleRows(rows, imported, limit) {
  const candidates = { notes: [], sections: [] };
  for (const [relative, matches] of rows) {
    for (const [key, row] of matches) {
      const rank = sha256(JSON.stringify([relative, key ?? null, row.inputSha256]));
      candidates[key ? "sections" : "notes"].push({ relative, key, row, rank });
    }
  }
  const total = imported.notes + imported.sections;
  const count = Math.min(total, limit, Math.max(20, Math.ceil(total / 100)));
  const notes = Math.min(imported.notes, Math.max(Math.ceil(count / 2), count - imported.sections));
  const quotas = { notes, sections: count - notes };
  return kinds.flatMap(kind => candidates[kind].sort((a, b) => a.rank < b.rank ? -1 : Number(a.rank > b.rank))
    .slice(0, quotas[kind]));
}

function cosine(left, right) {
  let dot = 0, a2 = 0, b2 = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const a = left.readFloatLE(offset);
    const b = right.readFloatLE(offset);
    dot += a * b;
    a2 += a * a;
    b2 += b * b;
  }
  return Math.min(1, dot / Math.sqrt(a2 * b2));
}

export async function verifyBootstrap(bootstrap, vault, scan, client, manifest, limit) {
  const { rows, report } = bootstrap;
  const sample = sampleRows(rows, report.imported, limit);
  const verification = {
    status: sample.length ? "incomplete" : "no-imports",
    sampleCount: 0,
    sampled: { notes: 0, sections: 0 },
    minCosine: null,
    medianCosine: null,
  };
  report.verification = verification;
  const scores = [];
  try {
    for (const { relative, key, row } of sample) {
      const { parts } = await readSourceParts(vault, relative, scan.files.get(relative), manifest.chunking);
      const part = key ? parts?.blocks.find(block => block.key === key) : parts?.note;
      if (!part || sha256(part.input) !== row.inputSha256) {
        throw Error("Sample input changed during bootstrap");
      }
      // One request at a time, leaving the bridge free between documents.
      const [encoded] = await client.encode([{ ...part, relative }], manifest, { fresh: true });
      if (!encoded) throw Error("Bootstrap verification sample was refused by the encoder");
      scores.push(cosine(row.vector, encoded));
      verification.sampled[key ? "sections" : "notes"]++;
    }
  } finally {
    verification.sampleCount = scores.length;
    if (scores.length) {
      scores.sort((a, b) => a - b);
      verification.minCosine = scores[0];
      verification.medianCosine = (scores[Math.floor((scores.length - 1) / 2)] +
        scores[Math.floor(scores.length / 2)]) / 2;
    }
  }
  if (!sample.length) return;
  verification.status = verification.medianCosine >= medianThreshold && verification.minCosine >= minThreshold
    ? "passed" : "failed";
  if (verification.status === "failed") {
    throw Error(`Bootstrap verification failed. Sampled ${scores.length} rows, minimum cosine ` +
      `${verification.minCosine.toFixed(6)} (threshold ${minThreshold}), median cosine ` +
      `${verification.medianCosine.toFixed(6)} (threshold ${medianThreshold})`);
  }
}
