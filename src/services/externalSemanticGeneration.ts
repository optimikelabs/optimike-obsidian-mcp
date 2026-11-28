import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import { getQueryEmbedder } from "../adapters/embed/index.js";
import { readSmartEnvV3, smartBlockVectorFile, smartModelFingerprint } from "./smartEnvV3.js";

const generationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const fingerprintPattern = /^mf_[a-z0-9]+$/u;
const count = z.number().int().nonnegative().safe();
const isoTime = z.string().datetime({ precision: 3 }).refine(
  value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
);
const vectorFile = z.object({
  count: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const manifestSchema = z.object({
  generation: z.string().regex(generationIdPattern),
  createdAt: isoTime.optional().catch(undefined),
  builtAt: isoTime.optional().catch(undefined),
  coverage: z.object({ indexedNotes: count, indexedSections: count, candidateNotes: count }).optional().catch(undefined),
  model: z.object({
    provider_key: z.enum(["ollama", "openai", "transformers", "xenova"]),
    model_key: z.string().trim().min(1),
    dimensions: z.number().int().positive().safe(),
    max_tokens: z.number().int().nonnegative().safe().optional(),
  }),
  fingerprint: z.string().regex(fingerprintPattern),
  vectors: z.object({
    encoding: z.literal("float32le"),
    notes: vectorFile.extend({ count: z.number().int().positive().safe() }),
    sections: vectorFile,
  }),
});

export type ExternalSemanticGeneration = {
  id: string;
  directory: string;
  cacheKey: string;
  sourceFileCount: number;
  manifest: z.infer<typeof manifestSchema>;
};

export function externalSemanticGenerationConfigured(): boolean {
  return process.env.SMART_ENV_GENERATION_POINTER !== undefined;
}

function canonicalProvider(provider: string): string {
  return provider === "xenova" ? "transformers" : provider;
}

export async function resolveExternalSemanticGeneration(): Promise<ExternalSemanticGeneration | undefined> {
  const pointerPath = process.env.SMART_ENV_GENERATION_POINTER;
  if (pointerPath === undefined) return undefined;
  if (!path.isAbsolute(pointerPath)) throw new Error("Expected an absolute semantic generation pointer path");
  const pointerDir = await fs.realpath(path.dirname(pointerPath));
  const pointer = path.join(pointerDir, path.basename(pointerPath));
  const pointerStat = await fs.lstat(pointer, { bigint: true });
  if (!pointerStat.isFile() || pointerStat.size > 128n)
    throw new Error("Invalid semantic generation pointer");
  // Read the pointer once. Everything else is relative to the captured ID.
  const [line = "", tail, extra] = (await fs.readFile(pointer, "utf8")).split("\n");
  if (tail !== "" || extra !== undefined)
    throw new Error("Semantic generation pointer must contain one terminated line");
  const id = line.replace(/^\uFEFF/u, "").replace(/\r$/u, "");
  if (!generationIdPattern.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id))
    throw new Error("Invalid semantic generation ID");
  const directory = path.join(pointerDir, "generations", id);
  if (path.relative(directory, await fs.realpath(directory)) !== "")
    throw new Error("Semantic generation directory must not redirect");

  const requiredFile = async (relative: string) => {
    const file = path.join(directory, relative);
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.dev !== pointerStat.dev ||
        path.relative(file, await fs.realpath(file)) !== "")
      throw new Error("Semantic generation files must be regular files on the pointer volume");
    return stat;
  };
  await requiredFile("generation.json");
  const manifestText = await fs.readFile(path.join(directory, "generation.json"), "utf8");
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  const { model, fingerprint, vectors } = manifest;
  if (manifest.generation !== id ||
      fingerprint !== smartModelFingerprint(model) ||
      fingerprint !== process.env.SMART_ENV_QUERY_FINGERPRINT?.trim())
    throw new Error("Semantic generation fingerprint does not match the pinned query profile");
  const configuredProvider = process.env.QUERY_EMBEDDER?.trim().toLowerCase() || "auto";
  const configuredModel = process.env.QUERY_EMBEDDER_MODEL?.trim();
  const configuredDimensions = process.env.OPENAI_EMBEDDING_DIMENSIONS?.trim();
  if ((configuredProvider !== "auto" && canonicalProvider(configuredProvider) !== canonicalProvider(model.provider_key)) ||
      (configuredModel && configuredModel !== model.model_key) ||
      (model.provider_key === "openai" && configuredDimensions && Number(configuredDimensions) !== model.dimensions))
    throw new Error("Semantic generation does not match the configured query encoder");

  const shards = (await fs.readdir(path.join(directory, "smart_sources")))
    .filter((name) => /^smart_sources(?:_\d+)?\.ajson$/iu.test(name))
    .sort();
  if (!shards.length) throw new Error("Semantic generation has no source records");
  const files = [
    "smart_env.json",
    "embedding_models/embedding_models.ajson",
    ...shards.map((name) => `smart_sources/${name}`),
    `smart_sources/${fingerprint}`,
    `smart_blocks/${fingerprint}`,
  ];
  const stats = await Promise.all(files.map(requiredFile));
  const rowBytes = BigInt(model.dimensions) * 4n;
  if (stats.at(-2)!.size !== rowBytes * BigInt(vectors.notes.count) ||
      stats.at(-1)!.size !== rowBytes * BigInt(vectors.sections.count))
    throw new Error("Semantic generation vector file size does not match its manifest");
  const cacheKey = createHash("sha256")
    .update(JSON.stringify([
      "external-smart-env-v3-v2",
      directory,
      id,
      manifestText,
      files,
      stats.map(({ dev, ino, size, mtimeNs, ctimeNs }) => [dev, ino, size, mtimeNs, ctimeNs].map(String)),
    ]))
    .digest("hex");
  return { id, directory, cacheKey, sourceFileCount: files.length, manifest };
}

export async function readExternalSemanticGeneration(generation: ExternalSemanticGeneration) {
  const { directory, manifest: { model, fingerprint, vectors } } = generation;
  const checkChecksum = async (file: string, expected: string) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== expected) throw new Error("Invalid semantic generation vector checksum");
  };
  await Promise.all([
    checkChecksum(path.join(directory, "smart_sources", fingerprint), vectors.notes.sha256),
    checkChecksum(smartBlockVectorFile(directory, fingerprint), vectors.sections.sha256),
  ]);
  const index = await readSmartEnvV3(directory, {
    blocks: true,
    expected: {
      fingerprint,
      model,
      noteCount: vectors.notes.count,
      sectionCount: vectors.sections.count,
    },
  });
  if (index?.blocks?.model !== model.model_key || index.blocks.dimensions !== model.dimensions)
    throw new Error("Semantic generation registry does not match its manifest");
  return index;
}

export async function getExternalQueryEmbedder(generation: ExternalSemanticGeneration) {
  const { model } = generation.manifest;
  return getQueryEmbedder({
    provider: canonicalProvider(model.provider_key),
    vaultModel: model.model_key,
    dimension: model.dimensions,
    // Endpoint settings belong to the reader. The producer cannot select a host.
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL?.trim(),
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    openaiDimensions: process.env.OPENAI_EMBEDDING_DIMENSIONS?.trim() ? model.dimensions : undefined,
  });
}
