import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { isSha256, validateVector } from "./bitnet.mjs";
import { sha256 } from "./vault.mjs";

export const currentFile = "CURRENT";
const manifestFile = "generation.json";
const sourceFile = "smart_sources/smart_sources.ajson";
const settingsFile = "smart_env.json";
const modelFile = "embedding_models/embedding_models.ajson";
const modelEntry = "ollama#producer";
const generationId = /^g-[a-f0-9-]{36}$/u;
export const jsonLine = value => JSON.stringify(value) + "\n";

export const vectorFiles = fingerprint => ({
  notes: `smart_sources/${fingerprint}`,
  sections: `smart_blocks/${fingerprint}`,
});

export function sourceRecord(relative, source, fingerprint) {
  function metadata(part) {
    return {
      last_read: { hash: part.readHash },
      embedding: { default: { [fingerprint]: {
        file: fingerprint, file_i: part.row, read_hash: part.readHash,
      } } },
    };
  }
  return {
    path: relative,
    metadata: { tags: source.tags },
    ...metadata(source.note),
    blocks_data: Object.fromEntries(Object.entries(source.blocks).map(([key, block]) => [
      key, { lines: block.lines, ...metadata(block) },
    ])),
  };
}

function ajson(key, value) {
  return JSON.stringify(key) + ": " + JSON.stringify(value) + ",\n";
}

export function sourceLine(relative, source, fingerprint) {
  return ajson("smart_sources:" + relative, sourceRecord(relative, source, fingerprint));
}

export async function writeSynced(filename, data) {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory) {
  // Node cannot open directories for fsync on Windows.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function describeArtifact(filename) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(filename)) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest("hex") };
}

function generationArtifacts(fingerprint) {
  return [sourceFile, settingsFile, modelFile, ...Object.values(vectorFiles(fingerprint))];
}

export async function sealGeneration(directory, manifest) {
  await writeSynced(path.join(directory, settingsFile),
    jsonLine({ embedding_models: { default_model_key: modelEntry } }));
  await writeSynced(path.join(directory, modelFile), ajson("embedding_models:" + modelEntry, manifest.model));
  manifest.artifacts = {};
  for (const file of generationArtifacts(manifest.fingerprint)) {
    manifest.artifacts[file] = await describeArtifact(path.join(directory, file));
  }
  const files = vectorFiles(manifest.fingerprint);
  manifest.vectors = {
    encoding: "float32le",
    notes: { count: manifest.stats.notes, sha256: manifest.artifacts[files.notes].sha256 },
    sections: { count: manifest.stats.sections, sha256: manifest.artifacts[files.sections].sha256 },
  };
  await writeSynced(path.join(directory, manifestFile), jsonLine(manifest));
}

export async function readActiveGeneration(index) {
  const pointer = path.join(index, currentFile);
  let stat;
  try {
    stat = await lstat(pointer);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 64) throw Error("Invalid CURRENT pointer");
  const raw = await readFile(pointer, "utf8");
  const id = raw.slice(0, -1);
  if (!raw.endsWith("\n") || !generationId.test(id)) throw Error("Invalid CURRENT generation id");
  const directory = path.join(index, "generations", id);
  if (!(await lstat(directory)).isDirectory()) throw Error("Invalid active generation directory");
  return { directory, manifest: await readManifest(directory, id) };
}

export async function readManifest(directory, id) {
  const text = await readFile(path.join(directory, manifestFile), "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw Error("Invalid generation manifest JSON");
  }
  if (manifest?.version !== 1 || manifest.generation !== id || !isSha256(manifest.vaultBinding) ||
      !isSha256(manifest.lockHash)) throw Error("Invalid generation manifest");
  return manifest;
}

export async function validateGeneration(directory, manifest) {
  const { fingerprint, model, sources, artifacts, vectors } = manifest;
  if (!/^mf_[a-z0-9]+$/u.test(fingerprint) || vectors.encoding !== "float32le") {
    throw Error("Invalid generation vector format");
  }
  if (sha256(JSON.stringify({ model, identity: manifest.identity, chunking: manifest.chunking })) !== manifest.lockHash) {
    throw Error("Generation encoding identity does not match its profile hash");
  }
  for (const file of generationArtifacts(fingerprint)) {
    if (!isDeepStrictEqual(await describeArtifact(path.join(directory, file)), artifacts[file])) {
      throw Error("Generation artifact checksum mismatch");
    }
  }
  const files = vectorFiles(fingerprint);
  for (const [kind, file] of Object.entries(files)) {
    if (artifacts[file].size !== vectors[kind].count * model.dimensions * 4 ||
        artifacts[file].sha256 !== vectors[kind].sha256) {
      throw Error("Generation vector size or checksum mismatch");
    }
  }
  if (await readFile(path.join(directory, settingsFile), "utf8") !==
        jsonLine({ embedding_models: { default_model_key: modelEntry } }) ||
      await readFile(path.join(directory, modelFile), "utf8") !== ajson("embedding_models:" + modelEntry, model)) {
    throw Error("Generation model records do not match its manifest");
  }
  let noteCount = 0;
  let blockCount = 0;
  const expected = Object.entries(sources)[Symbol.iterator]();
  const lines = createInterface({ input: createReadStream(path.join(directory, sourceFile), "utf8"), crlfDelay: Infinity });
  function checkPart(part, row) {
    if (!isSha256(part.inputSha256) || !/^[a-z0-9]+$/u.test(part.readHash) || part.row !== row) {
      throw Error("Invalid generation vector reference");
    }
  }
  for await (const line of lines) {
    const entry = expected.next().value;
    if (!entry) throw Error("Unexpected source record");
    const [relative, source] = entry;
    if (!isSha256(source.sha256) || line + "\n" !== sourceLine(relative, source, fingerprint)) {
      throw Error("Source record does not match its manifest");
    }
    checkPart(source.note, noteCount++);
    for (const block of Object.values(source.blocks)) {
      if (!Array.isArray(block.lines) || block.lines.length !== 2 ||
          !block.lines.every(Number.isSafeInteger) || block.lines[0] < 1 || block.lines[1] < block.lines[0]) {
        throw Error("Invalid generation block range");
      }
      checkPart(block, blockCount++);
    }
  }
  if (!expected.next().done || vectors.notes.count !== noteCount || vectors.sections.count !== blockCount) {
    throw Error("Incomplete generation coverage");
  }
}

export async function readVector(handle, row, dimensions, { allowInvalid = false } = {}) {
  const bytes = Buffer.allocUnsafe(dimensions * 4);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, row * bytes.length);
  try {
    if (bytesRead !== bytes.length) throw Error("Incomplete cached vector row");
    validateVector(Array.from({ length: dimensions }, (_, i) => bytes.readFloatLE(i * 4)), dimensions);
  } catch (error) {
    if (allowInvalid) return null;
    throw error;
  }
  return bytes;
}

export { sourceFile };
