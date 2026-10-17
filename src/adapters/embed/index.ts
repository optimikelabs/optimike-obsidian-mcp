import { getEmbedder as getOllamaEmbedder } from "./ollama.js";
import { getEmbedder as getOpenAIEmbedder } from "./openai.js";
import { getEmbedder as getTransformersEmbedder } from "./transformers.js";

type EmbedFunction = (text: string) => Promise<number[]>;

export type QueryEmbedderProvider = "auto" | "transformers" | "ollama" | "openai";

export type QueryEmbedderSelection = {
  provider: Exclude<QueryEmbedderProvider, "auto">;
  model: string;
  embed: EmbedFunction;
};

export type QueryEmbedderOptions = {
  provider?: string;
  modelHint?: string;
  // Explicit override (strongest). HuggingFace ids resolve to the built-in Transformers provider.
  model?: string;
  // What Smart Connections stored in .smart-env (often a HuggingFace id when using Transformers).
  vaultModel?: string;
  vaultProvider?: string;
  dimension?: number;
  ollamaBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiDimensions?: number;
};

const looksLikeHuggingFaceId = (id: string): boolean => id.includes("/") && !id.includes(" ");

const looksLikeOpenAIEmbeddingModel = (id: string): boolean =>
  id.startsWith("text-embedding-") || id.startsWith("openai/");

const normaliseProvider = (provider?: string): QueryEmbedderProvider => {
  const raw = (provider ?? "auto").trim().toLowerCase();
  if (raw === "xenova" || raw === "transformers") return "transformers";
  if (raw === "ollama") return "ollama";
  if (raw === "openai") return "openai";
  return "auto";
};

const inferProviderFromModel = (
  model: string,
): Exclude<QueryEmbedderProvider, "auto"> => {
  if (looksLikeOpenAIEmbeddingModel(model)) return "openai";
  if (looksLikeHuggingFaceId(model)) return "transformers";
  return "ollama";
};

export const getQueryEmbedder = async (
  opts: QueryEmbedderOptions,
): Promise<QueryEmbedderSelection> => {
  const provider = normaliseProvider(opts.provider);
  const vaultProvider = normaliseProvider(opts.vaultProvider);
  if (
    provider === "auto" &&
    opts.vaultProvider?.trim() &&
    vaultProvider === "auto" &&
    opts.vaultProvider.trim().toLowerCase() !== "auto"
  ) {
    throw new Error("Unsupported Smart Connections query provider");
  }

  // Strongest precedence: explicit model override
  const modelCandidate =
    opts.model?.trim() || opts.vaultModel?.trim() || "";

  const resolvedProvider: Exclude<QueryEmbedderProvider, "auto"> =
    provider === "auto"
      ? opts.model?.trim() && opts.model.trim() !== opts.vaultModel?.trim()
        ? inferProviderFromModel(modelCandidate)
        : vaultProvider !== "auto"
          ? vaultProvider
          : modelCandidate
            ? inferProviderFromModel(modelCandidate)
            : "ollama"
      : provider;

  if (resolvedProvider === "transformers") {
    const model = modelCandidate;
    const embed = await getTransformersEmbedder(model);
    return { provider: "transformers", model, embed };
  }

  if (resolvedProvider === "openai") {
    const model = modelCandidate || "text-embedding-3-small";
    const embed = await getOpenAIEmbedder({
      apiKey: opts.openaiApiKey,
      baseUrl: opts.openaiBaseUrl,
      model,
      dimensions: opts.openaiDimensions,
    });

    return { provider: "openai", model, embed };
  }

  // ollama
  const model = modelCandidate;
  if (!model) {
    throw new Error(
      "QUERY_EMBEDDER=ollama requires QUERY_EMBEDDER_MODEL or a model to be present in .smart-env",
    );
  }

  const embed = await getOllamaEmbedder(model, opts.ollamaBaseUrl);
  return { provider: "ollama", model, embed };
};
