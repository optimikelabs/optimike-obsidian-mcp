/**
 * Semantic search (Smart Connections) — Implémentation réelle
 * - Lit les embeddings dans `.smart-env`
 * - Encode la requête via un embedder configurable (auto: s'aligne sur le modèle du vault)
 * - Classement cosinus, filtres dossier/tag, snippets optionnels
 * - Expose `smart_semantic_search` + alias `smart_search` et `smart-search`
 * Schéma JSON "Codex-friendly" (pas d'integer ni d'unions).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { type SmartVec } from "../../../services/smartEnv.js";
import { getSemanticCacheService } from "../../../services/semanticCache.js";
import { getQueryEmbedder } from "../../../adapters/embed/index.js";
import { resolveNoteAbsolutePath } from "./resolvePath.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";

const In = z.object({
  query: z.string().min(2, "query too short"),
  top_k: z.number().min(1).max(100).default(20),
  folders: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  with_snippets: z.boolean().default(true),
});

const Out = z.object({
  model: z.string().optional(),
  dim: z.number().optional(),
  query_provider: z.string().optional(),
  query_model: z.string().optional(),
  query_dim: z.number().optional(),
  ollama_base_url: z.string().optional(),
  vector_count: z.number().optional(),
  filtered_count: z.number().optional(),
  timings_ms: z
    .object({
      total: z.number(),
      semantic_cache: z.number().optional(),
      embedder_setup: z.number().optional(),
      query_embedding: z.number().optional(),
      filter: z.number().optional(),
      ranking: z.number().optional(),
      snippets: z.number().optional(),
    })
    .optional(),
  results: z.array(
    z.object({
      path: z.string(),
      score: z.number(),
      title: z.string().optional(),
      snippet: z.string().optional(),
    }),
  ),
});

type InType = z.infer<typeof In>;
type OutType = z.infer<typeof Out>;

const vectorNormCache = new WeakMap<number[], number>();

function getEnv() {
  const env = process.env;
  const SMART_ENV_DIR = env.SMART_ENV_DIR;
  const ENABLE_QUERY_EMBEDDING =
    (env.ENABLE_QUERY_EMBEDDING ?? "true").toLowerCase() === "true";
  const QUERY_EMBEDDER_MODEL_HINT = env.QUERY_EMBEDDER_MODEL_HINT;
  const QUERY_EMBEDDER = env.QUERY_EMBEDDER;
  const QUERY_EMBEDDER_MODEL = env.QUERY_EMBEDDER_MODEL;
  const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL;
  const OPENAI_API_KEY = env.OPENAI_API_KEY;
  const OPENAI_BASE_URL = env.OPENAI_BASE_URL;
  const OPENAI_EMBEDDING_DIMENSIONS = env.OPENAI_EMBEDDING_DIMENSIONS;
  const OBSIDIAN_VAULT =
    env.OBSIDIAN_VAULT ??
    SMART_ENV_DIR?.replace(/[/\\]\.smart-env.*/u, "") ??
    "";
  const CACHE_TTL = Number.isFinite(Number(env.SMART_ENV_CACHE_TTL_MS))
    ? Number(env.SMART_ENV_CACHE_TTL_MS)
    : 60000;
  const SEMANTIC_SEARCH_PREWARM_TEXT =
    env.SEMANTIC_SEARCH_PREWARM_TEXT?.trim() ||
    "optimike semantic search warmup";

  return {
    SMART_ENV_DIR,
    ENABLE_QUERY_EMBEDDING,
    QUERY_EMBEDDER,
    QUERY_EMBEDDER_MODEL,
    QUERY_EMBEDDER_MODEL_HINT,
    OLLAMA_BASE_URL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_EMBEDDING_DIMENSIONS,
    OBSIDIAN_VAULT,
    CACHE_TTL,
    SEMANTIC_SEARCH_PREWARM_TEXT,
  };
}

function nowMs(): number {
  return Date.now();
}

function elapsedSince(startMs: number): number {
  return nowMs() - startMs;
}

function vectorNorm(vector: number[]): number {
  const cached = vectorNormCache.get(vector);
  if (cached !== undefined) return cached;

  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }

  const norm = Math.sqrt(sum);
  vectorNormCache.set(vector, norm);
  return norm;
}

function cosineWithCachedNorm(
  queryVector: number[],
  queryNorm: number,
  itemVector: number[],
): number {
  const itemNorm = vectorNorm(itemVector);
  if (!queryNorm || !itemNorm) return 0;

  let dot = 0;
  for (let index = 0; index < queryVector.length; index += 1) {
    dot += queryVector[index] * itemVector[index];
  }

  return dot / (queryNorm * itemNorm);
}

function insertRankedTopK<T>(
  ranked: Array<{ item: T; score: number }>,
  candidate: { item: T; score: number },
  limit: number,
): void {
  const insertAt = ranked.findIndex((entry) => candidate.score > entry.score);
  if (insertAt === -1) {
    if (ranked.length < limit) {
      ranked.push(candidate);
    }
    return;
  }

  ranked.splice(insertAt, 0, candidate);
  if (ranked.length > limit) {
    ranked.pop();
  }
}

function pickDominantDimension(items: SmartVec[]): number {
  const counts = new Map<number, number>();
  for (const item of items) {
    const dim = item.vec?.length ?? 0;
    if (!dim) continue;
    counts.set(dim, (counts.get(dim) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? 0;
}

function pickDominantModel(items: SmartVec[]): string | undefined {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.model) continue;
    counts.set(item.model, (counts.get(item.model) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0];
}

function wrapLooseObjectToJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  // embedding_models.ajson uses a loose object fragment (no outer braces)
  const withoutTrailingComma = trimmed.replace(/,\s*$/u, "");
  return `{${withoutTrailingComma}}`;
}

async function detectOllamaBaseUrlFromSmartEnv(
  smartEnvDir: string,
  preferredModel?: string,
): Promise<string | undefined> {
  // 1) Prefer Smart Environment default embedding model host, if present.
  try {
    const smartEnvJsonPath = path.join(smartEnvDir, "smart_env.json");
    const smartEnvRaw = await fs.readFile(smartEnvJsonPath, "utf-8");
    const smartEnv = JSON.parse(smartEnvRaw) as {
      embedding_models?: { default_model_key?: string };
    };

    const defaultKey = smartEnv.embedding_models?.default_model_key;
    if (defaultKey) {
      const modelsPath = path.join(smartEnvDir, "embedding_models", "embedding_models.ajson");
      const modelsRaw = await fs.readFile(modelsPath, "utf-8");
      const models = JSON.parse(wrapLooseObjectToJson(modelsRaw)) as Record<
        string,
        { host?: unknown; model_key?: unknown }
      >;

      const rec = models[`embedding_models:${defaultKey}`];
      if (rec && typeof rec.host === "string" && rec.host.trim()) {
        return rec.host.trim();
      }
    }
  } catch {
    // ignore and fall back
  }

  // 2) Fallback: scan embedding_models.ajson for a matching model_key.
  if (preferredModel) {
    try {
      const modelsPath = path.join(smartEnvDir, "embedding_models", "embedding_models.ajson");
      const modelsRaw = await fs.readFile(modelsPath, "utf-8");
      const models = JSON.parse(wrapLooseObjectToJson(modelsRaw)) as Record<
        string,
        { host?: unknown; model_key?: unknown }
      >;

      for (const rec of Object.values(models)) {
        if (
          rec &&
          typeof rec.model_key === "string" &&
          rec.model_key === preferredModel &&
          typeof rec.host === "string" &&
          rec.host.trim()
        ) {
          return rec.host.trim();
        }
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

function makeSuccessResult(payload: OutType) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: false,
  };
}

function makeErrorResult(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

async function performSearch(input: InType): Promise<OutType> {
  const startedAt = nowMs();
  const timings: NonNullable<OutType["timings_ms"]> = {
    total: 0,
  };
  const {
    SMART_ENV_DIR,
    ENABLE_QUERY_EMBEDDING,
    QUERY_EMBEDDER,
    QUERY_EMBEDDER_MODEL,
    QUERY_EMBEDDER_MODEL_HINT,
    OLLAMA_BASE_URL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_EMBEDDING_DIMENSIONS,
    OBSIDIAN_VAULT,
  } = getEnv();

  if (!SMART_ENV_DIR) {
    throw new Error("SMART_ENV_DIR is not set");
  }

  if (!ENABLE_QUERY_EMBEDDING) {
    throw new Error("ENABLE_QUERY_EMBEDDING=false");
  }

  const query = input.query.trim();
  if (!query) {
    timings.total = elapsedSince(startedAt);
    return {
      model: undefined,
      dim: undefined,
      query_provider: undefined,
      query_model: undefined,
      query_dim: undefined,
      ollama_base_url: undefined,
      vector_count: 0,
      filtered_count: 0,
      timings_ms: timings,
      results: [],
    };
  }

  const semanticCache = getSemanticCacheService();
  const semanticCacheStartedAt = nowMs();
  const snapshot = await semanticCache.getSnapshot();
  timings.semantic_cache = elapsedSince(semanticCacheStartedAt);
  const items = snapshot.items;
  if (!items.length) {
    throw new Error(`No embeddings found in ${SMART_ENV_DIR}`);
  }

  const dimension = snapshot.dominantDim ?? pickDominantDimension(items);
  if (!dimension) {
    throw new Error("Embeddings are missing vector data");
  }

  const itemsWithDim = items.filter((item) => item.vec?.length === dimension);
  const model = snapshot.dominantModel ?? pickDominantModel(itemsWithDim);

  const openaiDimensions = Number.isFinite(Number(OPENAI_EMBEDDING_DIMENSIONS))
    ? Number(OPENAI_EMBEDDING_DIMENSIONS)
    : undefined;

  const inferredOllamaBaseUrl =
    OLLAMA_BASE_URL?.trim() ||
    (await detectOllamaBaseUrlFromSmartEnv(SMART_ENV_DIR, model));

  const embedderSetupStartedAt = nowMs();
  const selection = await getQueryEmbedder({
    provider: QUERY_EMBEDDER,
    modelHint: QUERY_EMBEDDER_MODEL_HINT,
    model: QUERY_EMBEDDER_MODEL,
    vaultModel: model,
    dimension,
    ollamaBaseUrl: inferredOllamaBaseUrl,
    openaiApiKey: OPENAI_API_KEY,
    openaiBaseUrl: OPENAI_BASE_URL,
    openaiDimensions,
  });
  timings.embedder_setup = elapsedSince(embedderSetupStartedAt);

  const queryEmbeddingStartedAt = nowMs();
  const queryVector = await selection.embed(query);
  timings.query_embedding = elapsedSince(queryEmbeddingStartedAt);

  if (queryVector.length !== dimension) {
    throw new Error(
      `Query embedder produced ${queryVector.length} dimensions, expected ${dimension}`,
    );
  }

  const filterStartedAt = nowMs();
  const filtered = itemsWithDim.filter((item) => {
    const folderOk =
      !input.folders ||
      input.folders.some((folder) => item.notePath.startsWith(folder));
    const tagsOk =
      !input.tags ||
      (item.tags ?? []).some((tag) => input.tags?.includes(tag));
    return folderOk && tagsOk;
  });
  timings.filter = elapsedSince(filterStartedAt);

  const rankingStartedAt = nowMs();
  const queryNorm = vectorNorm(queryVector);
  const ranked: Array<{ item: SmartVec; score: number }> = [];

  for (const item of filtered) {
    insertRankedTopK(
      ranked,
      {
        item,
        score: cosineWithCachedNorm(queryVector, queryNorm, item.vec),
      },
      input.top_k,
    );
  }
  timings.ranking = elapsedSince(rankingStartedAt);

  const results: OutType["results"] = [];

  const snippetsStartedAt = nowMs();
  for (const { item, score } of ranked) {
    let snippet: string | undefined;

    if (input.with_snippets) {
      const absolutePath = resolveNoteAbsolutePath(item.notePath, OBSIDIAN_VAULT);
      try {
        const content = await fs.readFile(absolutePath, "utf-8");
        snippet = content.slice(0, 300);
      } catch {
        snippet = undefined;
      }
    }

    results.push({
      path: item.notePath,
      score,
      title: item.title,
      snippet,
    });
  }
  timings.snippets = elapsedSince(snippetsStartedAt);
  timings.total = elapsedSince(startedAt);

  return {
    model,
    dim: dimension,
    query_provider: selection.provider,
    query_model: selection.model,
    query_dim: queryVector.length,
    ollama_base_url:
      selection.provider === "ollama" ? inferredOllamaBaseUrl : undefined,
    vector_count: itemsWithDim.length,
    filtered_count: filtered.length,
    timings_ms: timings,
    results,
  };
}

export type SemanticSearchPrewarmResult = {
  ok: boolean;
  skipped?: string;
  model?: string;
  dim?: number;
  query_provider?: string;
  query_model?: string;
  query_dim?: number;
  vector_count?: number;
  ollama_base_url?: string;
  timings_ms: NonNullable<OutType["timings_ms"]>;
};

export async function prewarmSemanticSearch(): Promise<SemanticSearchPrewarmResult> {
  const startedAt = nowMs();
  const timings: NonNullable<OutType["timings_ms"]> = {
    total: 0,
  };
  const {
    SMART_ENV_DIR,
    ENABLE_QUERY_EMBEDDING,
    QUERY_EMBEDDER,
    QUERY_EMBEDDER_MODEL,
    QUERY_EMBEDDER_MODEL_HINT,
    OLLAMA_BASE_URL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_EMBEDDING_DIMENSIONS,
    SEMANTIC_SEARCH_PREWARM_TEXT,
  } = getEnv();

  const skipped = (reason: string): SemanticSearchPrewarmResult => {
    timings.total = elapsedSince(startedAt);
    return {
      ok: true,
      skipped: reason,
      timings_ms: timings,
    };
  };

  if (!SMART_ENV_DIR) {
    return skipped("SMART_ENV_DIR is not set");
  }

  if (!ENABLE_QUERY_EMBEDDING) {
    return skipped("ENABLE_QUERY_EMBEDDING=false");
  }

  const semanticCacheStartedAt = nowMs();
  const snapshot = await getSemanticCacheService().getSnapshot();
  timings.semantic_cache = elapsedSince(semanticCacheStartedAt);

  if (!snapshot.items.length) {
    return skipped(`No embeddings found in ${SMART_ENV_DIR}`);
  }

  const dimension = snapshot.dominantDim ?? pickDominantDimension(snapshot.items);
  if (!dimension) {
    return skipped("Embeddings are missing vector data");
  }

  const itemsWithDim = snapshot.items.filter(
    (item) => item.vec?.length === dimension,
  );
  const model = snapshot.dominantModel ?? pickDominantModel(itemsWithDim);
  const openaiDimensions = Number.isFinite(Number(OPENAI_EMBEDDING_DIMENSIONS))
    ? Number(OPENAI_EMBEDDING_DIMENSIONS)
    : undefined;
  const inferredOllamaBaseUrl =
    OLLAMA_BASE_URL?.trim() ||
    (await detectOllamaBaseUrlFromSmartEnv(SMART_ENV_DIR, model));

  const embedderSetupStartedAt = nowMs();
  const selection = await getQueryEmbedder({
    provider: QUERY_EMBEDDER,
    modelHint: QUERY_EMBEDDER_MODEL_HINT,
    model: QUERY_EMBEDDER_MODEL,
    vaultModel: model,
    dimension,
    ollamaBaseUrl: inferredOllamaBaseUrl,
    openaiApiKey: OPENAI_API_KEY,
    openaiBaseUrl: OPENAI_BASE_URL,
    openaiDimensions,
  });
  timings.embedder_setup = elapsedSince(embedderSetupStartedAt);

  const queryEmbeddingStartedAt = nowMs();
  const warmupVector = await selection.embed(SEMANTIC_SEARCH_PREWARM_TEXT);
  timings.query_embedding = elapsedSince(queryEmbeddingStartedAt);
  timings.total = elapsedSince(startedAt);

  return {
    ok: true,
    model,
    dim: dimension,
    query_provider: selection.provider,
    query_model: selection.model,
    query_dim: warmupVector.length,
    vector_count: itemsWithDim.length,
    ollama_base_url:
      selection.provider === "ollama" ? inferredOllamaBaseUrl : undefined,
    timings_ms: timings,
  };
}

async function handleSearchRequest(params: unknown): Promise<OutType> {
  const parsed = In.parse(params);
  return performSearch(parsed);
}

export const registerSemanticSearchTool = async (
  server: McpServer,
  _obsidianService: ObsidianRestApiService | undefined,
  _vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const register = (name: string, description: string) => {
    server.tool(
      name,
      description,
      In.shape,
      READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS,
      async (params: InType, _extra: unknown) => {
        try {
          const payload = await handleSearchRequest(params);
          Out.parse(payload);
          return makeSuccessResult(payload);
        } catch (error) {
          return makeErrorResult(error);
        }
      },
    );
  };

  register(
    "smart_semantic_search",
    "Semantic search powered by Smart Connections embeddings (query embedder auto-matches the vault model).",
  );
  register(
    "smart_search",
    "Alias of smart_semantic_search (same implementation).",
  );
  register(
    "smart-search",
    "Alias of smart_semantic_search (same implementation).",
  );
};

// Exported for local testing (non-public API).
export const __testHandleSmartSearch = handleSearchRequest;
