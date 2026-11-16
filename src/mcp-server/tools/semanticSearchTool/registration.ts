/**
 * Semantic search (Smart Connections) — Implémentation réelle
 * - Lit les embeddings dans `.smart-env`
 * - Encode la requête via un embedder configurable (auto: s'aligne sur le modèle du vault)
 * - Classement cosinus, filtres dossier/tag, snippets optionnels
 * - Expose the single canonical `smart_semantic_search` tool
 * Schéma JSON "Codex-friendly" (pas d'integer ni d'unions).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import { promises as fs } from "fs";
import path from "path";
import { type SmartVec } from "../../../services/smartEnv.js";
import {
  getSemanticCacheService,
  type SemanticSectionSnapshot,
} from "../../../services/semanticCache.js";
import {
  detectSmartEnvQueryProvider,
  smartTextHash,
  type SmartBlockRef,
} from "../../../services/smartEnvV3.js";
import { getQueryEmbedder } from "../../../adapters/embed/index.js";
import {
  detectOllamaBaseUrlFromSmartEnv,
  recordSemanticSearch,
  validQueryVector,
} from "../../../services/semanticSearchHealth.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

async function semanticStage<T>(
  reasonCode: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Semantic search could not complete.",
      { reasonCode },
    );
  }
}
import { resolveNoteAbsolutePath } from "./resolvePath.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { mcpSchema } from "../../mcpSchema.js";

const In = z.object({
  query: z.string().min(2, "query too short"),
  top_k: z.number().min(1).max(100).default(20),
  folders: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  with_snippets: z.boolean().default(true),
  granularity: z
    .enum(["notes", "sections", "both"])
    .default("notes")
    .describe(
      "notes: whole notes (default). sections: the heading sections and paragraphs that match, with heading path and line range [start, end] (1-based, inclusive) in the note. both: notes and sections ranked together.",
    ),
});

const SECTION_SNIPPET_MAX_CHARS = 1200;

const Out = z.object({
  model: z.string().optional(),
  dim: z.number().optional(),
  query_provider: z.string().optional(),
  query_model: z.string().optional(),
  query_dim: z.number().optional(),
  ollama_base_url: z.string().optional(),
  vector_count: z.number().optional(),
  filtered_count: z.number().optional(),
  section_count: z.number().optional(),
  section_filtered_count: z.number().optional(),
  timings_ms: z
    .object({
      total: z.number(),
      semantic_cache: z.number().optional(),
      section_cache: z.number().optional(),
      embedder_setup: z.number().optional(),
      query_embedding: z.number().optional(),
      filter: z.number().optional(),
      ranking: z.number().optional(),
      section_ranking: z.number().optional(),
      snippets: z.number().optional(),
    })
    .optional(),
  results: z.array(
    z.object({
      // Present only when sections were requested.
      kind: z.enum(["note", "section"]).optional(),
      path: z.string(),
      score: z.number(),
      title: z.string().optional(),
      block_key: z.string().optional(),
      headings: z.array(z.string()).optional(),
      lines: z.tuple([z.number(), z.number()]).optional(),
      lines_verified: z.boolean().optional(),
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
  if (ranked.length >= limit && candidate.score <= ranked[ranked.length - 1]!.score)
    return;
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

/**
 * Smart Connections block sub-keys chain headings with `#` (`##A#B`) and mark
 * content blocks under a heading `#{n}`. Best effort: a heading whose text
 * contains `#` is split; `block_key` stays the exact identifier.
 */
function headingPath(blockKey: string): string[] {
  return blockKey
    .split("#")
    .map((segment) => segment.trim())
    .filter((segment) => segment && !/^\{\d+\}$/u.test(segment));
}

// Bounds the search for sections that moved, per request: lines hashed while
// relocating. The search is synchronous; past the budget, lines are unverified.
const SECTION_RELOCATION_MAX_LINES_HASHED = 200_000;

/**
 * Where the embedded text of a section is in the note as it reads now. The
 * block hash covers its lines joined with "\n", so a match proves the text is
 * the one Smart Connections embedded. When an edit elsewhere shifted the
 * section, the nearest identical span wins. Undefined: the text changed (or
 * the search bound was reached); the indexed lines are then unverified.
 */
function locateSection(
  noteLines: readonly string[],
  ref: SmartBlockRef,
  budget: { lines: number },
): [number, number] | undefined {
  const span = ref.lineEnd - ref.lineStart + 1;
  const lastStart = noteLines.length - span + 1;
  const matches = (start: number) =>
    start >= 1 &&
    start <= lastStart &&
    smartTextHash(noteLines.slice(start - 1, start - 1 + span).join("\n")) ===
      ref.readHash;
  // The span no longer fits in the note: no position can match.
  if (lastStart < 1) return undefined;
  if (matches(ref.lineStart)) return [ref.lineStart, ref.lineEnd];
  // Search outward from the nearest valid position, so the loop is bounded by
  // the note length even when the indexed line is far past its end.
  const center = Math.min(Math.max(ref.lineStart, 1), lastStart);
  for (let delta = 0; center - delta >= 1 || center + delta <= lastStart; delta++) {
    for (const start of delta === 0 ? [center] : [center - delta, center + delta]) {
      if (start < 1 || start > lastStart || start === ref.lineStart) continue;
      if (budget.lines < span) return undefined;
      budget.lines -= span;
      if (matches(start)) return [start, start + span - 1];
    }
  }
  return undefined;
}

function matchesFilters(
  input: InType,
  notePath: string,
  tags: readonly string[] | undefined,
): boolean {
  const folderOk =
    !input.folders || input.folders.some((folder) => notePath.startsWith(folder));
  const tagsOk =
    !input.tags || (tags ?? []).some((tag) => input.tags?.includes(tag));
  return folderOk && tagsOk;
}

function rankSections(
  sections: SemanticSectionSnapshot,
  input: InType,
  queryVector: number[],
  queryNorm: number,
): { ranked: Array<{ item: number; score: number }>; filteredCount: number } {
  const { refs, vectors, norms, dimensions, tagsByNote } = sections;
  const query = Float64Array.from(queryVector);
  const ranked: Array<{ item: number; score: number }> = [];
  let filteredCount = 0;
  let lastPath: string | undefined;
  let lastMatch = false;
  for (let row = 0; row < refs.length; row++) {
    const notePath = refs[row]!.notePath;
    if (notePath !== lastPath) {
      lastPath = notePath;
      lastMatch = matchesFilters(input, notePath, tagsByNote.get(notePath));
    }
    if (!lastMatch) continue;
    filteredCount += 1;
    const norm = norms[row]!;
    let dot = 0;
    const offset = row * dimensions;
    for (let i = 0; i < dimensions; i++) dot += query[i]! * vectors[offset + i]!;
    const score = queryNorm && norm ? dot / (queryNorm * norm) : 0;
    insertRankedTopK(ranked, { item: row, score }, input.top_k);
  }
  return { ranked, filteredCount };
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

function makeErrorResult(error: unknown, params: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          publicMcpToolErrorPayload(error, {
            operation: "smart_semantic_search",
            toolName: "smart_semantic_search",
            params,
          }),
          null,
          2,
        ),
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
  const wantNotes = input.granularity !== "sections";
  let sections: SemanticSectionSnapshot | undefined;
  if (input.granularity !== "notes") {
    // Before the note snapshot: one cold source read can then serve both.
    const sectionCacheStartedAt = nowMs();
    sections = await semanticStage("semantic_index_unavailable", () =>
      semanticCache.getSectionSnapshot(),
    );
    timings.section_cache = elapsedSince(sectionCacheStartedAt);
  }
  const semanticCacheStartedAt = nowMs();
  const snapshot = await semanticStage("semantic_index_unavailable", () =>
    semanticCache.getSnapshot(),
  );
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

  // Refuse before embedding the query: sections need block vectors of the
  // very model the query embedder will match.
  if (
    sections &&
    (!sections.refs.length ||
      sections.dimensions !== dimension ||
      sections.model !== model)
  ) {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "No section vectors of the active Smart Connections model are available; search with granularity notes.",
      { reasonCode: "semantic_sections_unavailable" },
    );
  }

  const openaiDimensions = Number.isFinite(Number(OPENAI_EMBEDDING_DIMENSIONS))
    ? Number(OPENAI_EMBEDDING_DIMENSIONS)
    : undefined;

  const inferredOllamaBaseUrl =
    OLLAMA_BASE_URL?.trim() ||
    (await detectOllamaBaseUrlFromSmartEnv(SMART_ENV_DIR, model));

  const embedderSetupStartedAt = nowMs();
  const selection = await semanticStage(
    "semantic_embedder_configuration_invalid",
    async () =>
      getQueryEmbedder({
        provider: QUERY_EMBEDDER,
        modelHint: QUERY_EMBEDDER_MODEL_HINT,
        model: QUERY_EMBEDDER_MODEL,
        vaultModel: model,
        vaultProvider: await detectSmartEnvQueryProvider(SMART_ENV_DIR, model),
        dimension,
        ollamaBaseUrl: inferredOllamaBaseUrl,
        openaiApiKey: OPENAI_API_KEY,
        openaiBaseUrl: OPENAI_BASE_URL,
        openaiDimensions,
      }),
  );
  timings.embedder_setup = elapsedSince(embedderSetupStartedAt);

  const queryEmbeddingStartedAt = nowMs();
  let queryVector: number[];
  try {
    queryVector = await semanticStage("semantic_query_embedding_failed", () =>
      selection.embed(query),
    );
  } catch (error) {
    recordSemanticSearch(selection.embed, dimension, false);
    throw error;
  }
  timings.query_embedding = elapsedSince(queryEmbeddingStartedAt);

  if (!validQueryVector(queryVector, dimension)) {
    recordSemanticSearch(selection.embed, dimension, false);
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Semantic query vector is incompatible.",
      { reasonCode: "semantic_query_vector_invalid" },
    );
  }

  const filterStartedAt = nowMs();
  const filtered = itemsWithDim.filter((item) =>
    matchesFilters(input, item.notePath, item.tags),
  );
  timings.filter = elapsedSince(filterStartedAt);

  const rankingStartedAt = nowMs();
  const queryNorm = vectorNorm(queryVector);
  const ranked: Array<{ item: SmartVec; score: number }> = [];

  for (const item of wantNotes ? filtered : []) {
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

  let rankedSections: Array<{ item: number; score: number }> = [];
  let sectionFilteredCount: number | undefined;
  if (sections) {
    const sectionRankingStartedAt = nowMs();
    const sectionRanking = rankSections(sections, input, queryVector, queryNorm);
    rankedSections = sectionRanking.ranked;
    sectionFilteredCount = sectionRanking.filteredCount;
    timings.section_ranking = elapsedSince(sectionRankingStartedAt);
  }

  // One list, best score first: notes and sections share the query model.
  const merged: Array<
    | { kind: "note"; item: SmartVec; score: number }
    | { kind: "section"; item: number; score: number }
  > = [
    ...ranked.map((entry) => ({ kind: "note" as const, ...entry })),
    ...rankedSections.map((entry) => ({ kind: "section" as const, ...entry })),
  ]
    .sort((left, right) => right.score - left.score)
    .slice(0, input.top_k);

  const results: OutType["results"] = [];
  const noteTexts = new Map<string, Promise<string | undefined>>();
  const readNote = (notePath: string) => {
    let text = noteTexts.get(notePath);
    if (!text) {
      text = fs
        .readFile(resolveNoteAbsolutePath(notePath, OBSIDIAN_VAULT), "utf-8")
        .catch(() => undefined);
      noteTexts.set(notePath, text);
    }
    return text;
  };

  const relocationBudget = { lines: SECTION_RELOCATION_MAX_LINES_HASHED };
  const snippetsStartedAt = nowMs();
  for (const entry of merged) {
    if (entry.kind === "note") {
      const { item, score } = entry;
      const content = input.with_snippets
        ? await readNote(item.notePath)
        : undefined;
      results.push({
        ...(sections ? { kind: "note" as const } : {}),
        path: item.notePath,
        score,
        title: item.title,
        snippet: content?.slice(0, 300),
      });
      continue;
    }
    // Section lines are always checked against the note as it reads now:
    // Smart Connections may not have re-indexed a later edit yet.
    const ref = sections!.refs[entry.item]!;
    const noteLines = (await readNote(ref.notePath))?.split("\n");
    const located = noteLines && locateSection(noteLines, ref, relocationBudget);
    results.push({
      kind: "section",
      path: ref.notePath,
      score: entry.score,
      title: path.basename(ref.notePath, path.extname(ref.notePath)),
      block_key: ref.blockKey,
      headings: headingPath(ref.blockKey),
      lines: located ?? [ref.lineStart, ref.lineEnd],
      lines_verified: Boolean(located),
      snippet:
        input.with_snippets && located
          ? noteLines!
              .slice(located[0] - 1, located[1])
              .map((line) => line.replace(/\r$/u, ""))
              .join("\n")
              .slice(0, SECTION_SNIPPET_MAX_CHARS)
          : undefined,
    });
  }
  timings.snippets = elapsedSince(snippetsStartedAt);
  timings.total = elapsedSince(startedAt);
  recordSemanticSearch(selection.embed, dimension, true);

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
    ...(sections
      ? {
          section_count: sections.refs.length,
          section_filtered_count: sectionFilteredCount,
        }
      : {}),
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

  const dimension =
    snapshot.dominantDim ?? pickDominantDimension(snapshot.items);
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
    vaultProvider: await detectSmartEnvQueryProvider(SMART_ENV_DIR, model),
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
    server.registerTool(
      name,
      {
        description: description,
        inputSchema: mcpSchema(In.shape),
        annotations: READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS,
      },
      async (params: InType, _extra: unknown) => {
        try {
          const payload = await handleSearchRequest(params);
          Out.parse(payload);
          return makeSuccessResult(payload);
        } catch (error) {
          return makeErrorResult(error, params);
        }
      },
    );
  };

  register(
    "smart_semantic_search",
    "Semantic search powered by Smart Connections embeddings (query embedder auto-matches the vault model). Set granularity to sections to get the heading sections and paragraphs that answer, with their line range in the note, instead of whole notes.",
  );
};

// Exported for local testing (non-public API).
export const __testHandleSmartSearch = handleSearchRequest;
