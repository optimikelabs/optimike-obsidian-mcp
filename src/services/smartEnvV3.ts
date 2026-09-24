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

type SourceRecord = {
  path?: string;
  last_import?: { hash?: string };
  embedding?: {
    default?: Record<string, { file?: string; file_i?: number; read_hash?: string }>;
  };
  metadata?: { tags?: string[] };
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
  for (const line of registry.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed) continue;
    try {
      const records = JSON.parse(`{${trimmed}}`) as Record<string, ModelRecord>;
      const model = records[`embedding_models:${selected}`];
      if (model) return model;
    } catch {
      // Ignore a malformed registry entry without losing the others.
    }
  }
  return null;
}

export async function loadSmartEnvV3(baseDir: string): Promise<SmartVec[] | null> {
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
  if (!model?.model_key || !Number.isInteger(dimensions) || dimensions <= 0) return [];
  const fingerprint = modelFingerprint(model);
  const latest = new Map<string, SourceRecord>();
  for (const file of files) {
    const lines = readline.createInterface({
      input: createReadStream(path.join(directory, file), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const trimmed = line.trim().replace(/,$/, "");
      if (!trimmed.startsWith('"smart_sources:')) continue;
      try {
        const records = JSON.parse(`{${trimmed}}`) as Record<string, SourceRecord>;
        const source = Object.values(records)[0];
        if (source?.path) latest.set(source.path, source);
      } catch {
        // A partial append must not prevent reading the other source records.
      }
    }
  }
  const vectorFile = path.join(directory, fingerprint);
  let binary: Buffer;
  try {
    binary = await fs.readFile(vectorFile);
  } catch {
    return [];
  }
  const vectors: SmartVec[] = [];
  for (const source of latest.values()) {
    const reference = source.embedding?.default?.[fingerprint];
    const index = reference?.file_i;
    if (
      reference?.file !== fingerprint ||
      !Number.isInteger(index) ||
      index === undefined ||
      index < 0 ||
      reference.read_hash !== source.last_import?.hash
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
      tags: Array.isArray(source.metadata?.tags) ? source.metadata.tags : undefined,
      model: model.model_key,
      vec,
    });
  }
  return vectors;
}
