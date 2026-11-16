import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SmartVec } from "./smartEnv.js";

type ModelRecord = {
  key?: string;
  provider_key?: string;
  model_key?: string;
  dims?: number;
  dimensions?: number;
  max_tokens?: number;
};

type VectorReference = { file?: string; file_i?: number; read_hash?: string };

type BlockRecord = {
  lines?: unknown;
  last_read?: { hash?: string };
  embedding?: { default?: Record<string, VectorReference> };
};

type SourceRecord = {
  path?: string;
  last_import?: { hash?: string };
  last_read?: { hash?: string };
  embedding?: {
    default?: Record<string, VectorReference>;
  };
  metadata?: { tags?: string[] };
  blocks_data?: Record<string, BlockRecord | null>;
};

type SearchSource = {
  path: string;
  reference: VectorReference | undefined;
  readHash: string | undefined;
  tags: string[] | undefined;
  blocks: SmartBlockCandidate[] | undefined;
};

/** A block whose current vector reference passed every metadata check. */
export type SmartBlockCandidate = {
  /** Sub-key after the note path, for example `##Heading#Sub#{1}`. */
  blockKey: string;
  lineStart: number;
  lineEnd: number;
  fileIndex: number;
  /** `smartTextHash` of the embedded lines, as Smart Connections read them. */
  readHash: string;
};

export type SmartBlockRef = SmartBlockCandidate & { notePath: string };

/**
 * Section (block) vectors of the active model. Row `i` of `vectors` (length
 * `dimensions`) belongs to `refs[i]`; `norms[i]` is its Euclidean norm.
 */
export type SmartBlockIndex = {
  model: string;
  /** Model fingerprint: block vectors are read from `smart_blocks/<fingerprint>`. */
  fingerprint: string;
  dimensions: number;
  refs: SmartBlockRef[];
  vectors: Float32Array;
  norms: Float32Array;
  tagsByNote: Map<string, string[]>;
};

export type SmartEnvV3Index = {
  notes: SmartVec[];
  /** Present only when blocks were requested and a model is active. */
  blocks?: SmartBlockIndex;
};

function hash32(value: string): number {
  let hash = 0;
  let offset = 0;
  while (offset + 4 <= value.length) {
    let chunk =
      (value.charCodeAt(offset) & 255) |
      ((value.charCodeAt(offset + 1) & 255) << 8) |
      ((value.charCodeAt(offset + 2) & 255) << 16) |
      ((value.charCodeAt(offset + 3) & 255) << 24);
    offset += 4;
    chunk = Math.imul(chunk, 0xcc9e2d51);
    chunk = (chunk << 15) | (chunk >>> 17);
    chunk = Math.imul(chunk, 0x1b873593);
    hash ^= chunk;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }
  let tail = 0;
  for (let index = 0; offset + index < value.length; index++) {
    tail |= (value.charCodeAt(offset + index) & 255) << (index * 8);
  }
  if (tail) {
    tail = Math.imul(tail, 0xcc9e2d51);
    tail = (tail << 15) | (tail >>> 17);
    tail = Math.imul(tail, 0x1b873593);
    hash ^= tail;
  }
  hash ^= value.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * The content hash Smart Connections records as `last_read.hash`. For a block
 * it covers the note lines `[start, end]` joined with "\n"; for a source, the
 * whole note. Comparing it with the current file proves the text is unchanged.
 */
export function smartTextHash(text: string): string {
  return hash32(text).toString(36);
}

function modelFingerprint(model: ModelRecord): string {
  const key = JSON.stringify({
    provider_key: model.provider_key || "",
    model_key: model.model_key || "",
    dimensions: model.dims || model.dimensions || "",
    max_tokens: Number(model.max_tokens || 0),
  });
  return `mf_${hash32(key).toString(36)}`;
}

async function activeModel(baseDir: string): Promise<ModelRecord | null> {
  let selected: string;
  try {
    const settings = JSON.parse(await fs.readFile(path.join(baseDir, "smart_env.json"), "utf8"));
    selected = settings.embedding_models?.default_model_key;
  } catch {
    return null;
  }
  if (!selected) return null;
  let registry: string;
  try {
    registry = await fs.readFile(
      path.join(baseDir, "embedding_models", "embedding_models.ajson"),
      "utf8",
    );
  } catch {
    return null;
  }
  let active: ModelRecord | null = null;
  for (const line of registry.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed) continue;
    try {
      const records = JSON.parse(`{${trimmed}}`) as Record<string, ModelRecord>;
      const model = records[`embedding_models:${selected}`];
      if (model) active = model;
    } catch {
      // Ignore a malformed registry entry without losing later append-only values.
    }
  }
  return active;
}

export async function detectSmartEnvQueryProvider(
  baseDir: string,
  expectedModel?: string,
): Promise<string | undefined> {
  const model = await activeModel(baseDir);
  if (!model || (expectedModel && model.model_key !== expectedModel)) return undefined;
  return model.provider_key;
}

export async function loadSmartEnvV3(baseDir: string): Promise<SmartVec[] | null> {
  return (await readSmartEnvV3(baseDir, { blocks: false }))?.notes ?? null;
}

// The frontmatter block holds YAML properties, not prose an agent would quote.
const FRONTMATTER_BLOCK = /^#+---frontmatter---/u;

function blockCandidates(
  blocks: SourceRecord["blocks_data"],
  fingerprint: string,
): SmartBlockCandidate[] | undefined {
  if (!blocks || typeof blocks !== "object") return undefined;
  const candidates: SmartBlockCandidate[] = [];
  for (const [blockKey, block] of Object.entries(blocks)) {
    if (!block || FRONTMATTER_BLOCK.test(blockKey)) continue;
    const reference = block.embedding?.default?.[fingerprint];
    const index = reference?.file_i;
    const lines = block.lines;
    // Same freshness rule as sources: the vector must describe the block text
    // Smart Connections read last, from the active model's file.
    if (
      reference?.file !== fingerprint ||
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !reference.read_hash ||
      reference.read_hash !== block.last_read?.hash ||
      !Array.isArray(lines) ||
      !Number.isSafeInteger(lines[0]) ||
      !Number.isSafeInteger(lines[1]) ||
      lines[0] < 1 ||
      lines[1] < lines[0]
    ) continue;
    candidates.push({
      blockKey,
      lineStart: lines[0],
      lineEnd: lines[1],
      fileIndex: index,
      readHash: reference.read_hash,
    });
  }
  return candidates.length ? candidates : undefined;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const BLOCK_READ_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Reads the referenced rows of a Smart Connections float32 little-endian
 * vector file into one contiguous Float32Array, in bounded chunks: the file is
 * never held whole in memory. Rows past the end of the file or holding a
 * non-finite value are dropped. Sorts `refs` by file index in place.
 */
export async function readSmartBlockVectors(
  vectorFile: string,
  refs: SmartBlockRef[],
  dimensions: number,
): Promise<{ refs: SmartBlockRef[]; vectors: Float32Array; norms: Float32Array }> {
  refs.sort((left, right) => left.fileIndex - right.fileIndex);
  const rowBytes = dimensions * 4;
  const chunkRows = Math.max(1, Math.floor(BLOCK_READ_CHUNK_BYTES / rowBytes));
  const chunk = new ArrayBuffer(chunkRows * rowBytes);
  const chunkBytes = new Uint8Array(chunk);
  const chunkFloats = new Float32Array(chunk);
  const chunkView = new DataView(chunk);
  const vectors = new Float32Array(refs.length * dimensions);
  const norms = new Float32Array(refs.length);
  const kept: SmartBlockRef[] = [];
  let chunkStart = 0;
  let chunkEnd = 0;
  const handle = await fs.open(vectorFile, "r");
  try {
    const rowCount = Math.floor((await handle.stat()).size / rowBytes);
    for (const ref of refs) {
      // Sorted: every later row is past the end of the file too. Checked
      // before reading, so an absurd index cannot overflow the file position.
      if (ref.fileIndex >= rowCount) break;
      if (ref.fileIndex < chunkStart || ref.fileIndex >= chunkEnd) {
        const { bytesRead } = await handle.read(
          chunkBytes,
          0,
          chunk.byteLength,
          ref.fileIndex * rowBytes,
        );
        chunkStart = ref.fileIndex;
        chunkEnd = chunkStart + Math.floor(bytesRead / rowBytes);
        if (ref.fileIndex >= chunkEnd) break;
      }
      const rowOffset = (ref.fileIndex - chunkStart) * dimensions;
      const target = kept.length * dimensions;
      let sum = 0;
      let finite = true;
      for (let i = 0; i < dimensions; i++) {
        const value = LITTLE_ENDIAN
          ? chunkFloats[rowOffset + i]!
          : chunkView.getFloat32((rowOffset + i) * 4, true);
        if (!Number.isFinite(value)) {
          finite = false;
          break;
        }
        vectors[target + i] = value;
        sum += value * value;
      }
      if (!finite) continue;
      norms[kept.length] = Math.sqrt(sum);
      kept.push(ref);
    }
  } finally {
    await handle.close();
  }
  // A view, not a copy: dropping a few rows must not duplicate the array.
  return {
    refs: kept,
    vectors: vectors.subarray(0, kept.length * dimensions),
    norms: norms.subarray(0, kept.length),
  };
}

/**
 * One pass over the append-only source records yields the current note vector
 * references and, when requested, the current block (section) references.
 * Note and block bodies are parsed one line at a time and never retained.
 * Returns null when the directory holds no Smart Environment v3 sources.
 */
export async function readSmartEnvV3(
  baseDir: string,
  options: { blocks: boolean; notes?: boolean },
): Promise<SmartEnvV3Index | null> {
  const directory = path.join(baseDir, "smart_sources");
  let files: string[];
  try {
    files = (await fs.readdir(directory))
      .filter((file) => /^smart_sources(?:_\d+)?\.ajson$/i.test(file))
      .sort((left, right) => {
        const shard = (name: string) => Number(name.match(/_(\d+)\.ajson$/i)?.[1] ?? 0);
        return shard(left) - shard(right);
      });
  } catch {
    return null;
  }
  if (!files.length) return null;
  const model = await activeModel(baseDir);
  const dimensions = Number(model?.dims || model?.dimensions || 0);
  if (!model?.model_key || !Number.isInteger(dimensions) || dimensions <= 0) return { notes: [] };
  const fingerprint = modelFingerprint(model);
  const latest = new Map<string, SearchSource>();
  for (const file of files) {
    const lines = readline.createInterface({
      input: createReadStream(path.join(directory, file), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const trimmed = line.trim().replace(/,$/, "");
      if (!trimmed.startsWith('"smart_sources:')) continue;
      try {
        const records = JSON.parse(`{${trimmed}}`) as Record<string, SourceRecord | null>;
        const [key, source] = Object.entries(records)[0] ?? [];
        // Smart Connections appends `"smart_sources:<path>": null` when a note
        // is deleted; the latest record wins, so the note leaves the index.
        if (source === null && key?.startsWith("smart_sources:")) {
          latest.delete(key.slice("smart_sources:".length));
          continue;
        }
        // Search needs only the current vector reference and search metadata.
        // Never retain whole note bodies from the append-only source history.
        if (source?.path) latest.set(source.path, {
          path: source.path,
          reference: source.embedding?.default?.[fingerprint],
          readHash: source.last_read?.hash ?? source.last_import?.hash,
          tags: Array.isArray(source.metadata?.tags) ? source.metadata.tags : undefined,
          blocks: options.blocks
            ? blockCandidates(source.blocks_data, fingerprint)
            : undefined,
        });
      } catch {
        // A partial append must not prevent reading the other source records.
      }
    }
  }
  // A caller whose note snapshot already matches these files skips them.
  const vectors =
    options.notes === false
      ? []
      : await readNoteVectors(
          path.join(directory, fingerprint),
          latest,
          fingerprint,
          dimensions,
          model.model_key,
        );
  if (!options.blocks) return { notes: vectors };

  const refs: SmartBlockRef[] = [];
  const tagsByNote = new Map<string, string[]>();
  for (const source of latest.values()) {
    if (!source.blocks) continue;
    if (source.tags?.length) tagsByNote.set(source.path, source.tags);
    for (const block of source.blocks) refs.push({ notePath: source.path, ...block });
  }
  latest.clear();
  // Block vectors live in their own file: never assume that sources and
  // blocks share one (brianpetro/obsidian-smart-connections#1375).
  let rows: Awaited<ReturnType<typeof readSmartBlockVectors>>;
  try {
    rows = await readSmartBlockVectors(
      smartBlockVectorFile(baseDir, fingerprint),
      refs,
      dimensions,
    );
  } catch {
    rows = { refs: [], vectors: new Float32Array(0), norms: new Float32Array(0) };
  }
  return {
    notes: vectors,
    blocks: { model: model.model_key, fingerprint, dimensions, ...rows, tagsByNote },
  };
}

export function smartBlockVectorFile(baseDir: string, fingerprint: string): string {
  return path.join(baseDir, "smart_blocks", fingerprint);
}

async function readNoteVectors(
  vectorFile: string,
  latest: Map<string, SearchSource>,
  fingerprint: string,
  dimensions: number,
  modelKey: string,
): Promise<SmartVec[]> {
  let binary: Buffer;
  try {
    binary = await fs.readFile(vectorFile);
  } catch {
    return [];
  }
  const vectors: SmartVec[] = [];
  for (const source of latest.values()) {
    const reference = source.reference;
    const index = reference?.file_i;
    if (
      reference?.file !== fingerprint ||
      !Number.isInteger(index) ||
      index === undefined ||
      index < 0 ||
      !reference.read_hash ||
      reference.read_hash !== source.readHash
    ) continue;
    const offset = index * dimensions * 4;
    if (offset + dimensions * 4 > binary.length) continue;
    const vec = Array.from({ length: dimensions }, (_, i) => binary.readFloatLE(offset + i * 4));
    if (vec.some((number) => !Number.isFinite(number))) continue;
    const notePath = source.path!;
    vectors.push({
      id: notePath,
      notePath,
      title: path.basename(notePath, path.extname(notePath)),
      tags: source.tags,
      model: modelKey,
      vec,
    });
  }
  return vectors;
}
