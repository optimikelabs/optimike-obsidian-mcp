type EmbedFunction = (text: string) => Promise<number[]>;

// Query-side profile of the Smart Connections built-in models (Smart Environment
// transformers_v4 adapter). A query must reuse the exact pooling, normalisation,
// prefix and revision of the stored document vectors, so unknown models are refused.
type TransformersModelProfile = {
  revision?: string;
  pooling: "mean" | "cls";
  normalize: boolean;
  queryPrefix: string;
};

const TRANSFORMERS_MODELS: Record<string, TransformersModelProfile> = {
  "TaylorAI/bge-micro-v2": { pooling: "mean", normalize: true, queryPrefix: "" },
  "Snowflake/snowflake-arctic-embed-xs": {
    pooling: "cls",
    normalize: true,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Snowflake/snowflake-arctic-embed-s": {
    revision: "e596f507467533e48a2e17c007f0e1dacc837b33",
    pooling: "cls",
    normalize: true,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Xenova/multilingual-e5-small": { pooling: "mean", normalize: true, queryPrefix: "query: " },
  "onnx-community/granite-embedding-97m-multilingual-r2-ONNX": {
    revision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
    pooling: "cls",
    normalize: true,
    queryPrefix: "",
  },
  "onnx-community/DenseOn-ONNX": {
    revision: "8606070c911ab26c582ce23db387abd3885541f2",
    pooling: "cls",
    normalize: true,
    queryPrefix: "query: ",
  },
};

const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

// fp32 reproduces Smart Connections scores exactly; q8 drifts enough to reorder the top 3.
const DTYPE = "fp32";

const assertPackageInstalled = (): void => {
  try {
    import.meta.resolve(TRANSFORMERS_PACKAGE);
  } catch {
    throw new Error(
      `The Smart Connections built-in model needs the optional package ${TRANSFORMERS_PACKAGE}. ` +
        `Install it next to the MCP (npm install ${TRANSFORMERS_PACKAGE}), or use QUERY_EMBEDDER=ollama or openai.`,
    );
  }
};

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

const embedderCache = new Map<string, EmbedFunction>();

export const getEmbedder = async (model: string): Promise<EmbedFunction> => {
  const modelId = model?.trim();
  const profile = modelId ? TRANSFORMERS_MODELS[modelId] : undefined;
  if (!modelId || !profile) {
    throw new Error(
      `Unsupported Smart Connections built-in model "${modelId ?? ""}": its query profile is unknown.`,
    );
  }
  assertPackageInstalled();

  const cached = embedderCache.get(modelId);
  if (cached) return cached;

  // The model is loaded on the first query only: diagnostics stay cheap and offline.
  let extractor: Promise<FeatureExtractor> | null = null;
  const loadExtractor = (): Promise<FeatureExtractor> => {
    extractor ??= (async () => {
      const { pipeline } = (await import(TRANSFORMERS_PACKAGE)) as {
        pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<FeatureExtractor>;
      };
      return pipeline("feature-extraction", modelId, {
        dtype: DTYPE,
        ...(profile.revision ? { revision: profile.revision } : {}),
      });
    })().catch((error) => {
      extractor = null;
      throw error;
    });
    return extractor;
  };

  const embed: EmbedFunction = async (text: string) => {
    const input = text.trim();
    if (!input) return [];
    const run = await loadExtractor();
    const output = await run(profile.queryPrefix + input, {
      pooling: profile.pooling,
      normalize: profile.normalize,
    });
    return Array.from(output.data);
  };

  embedderCache.set(modelId, embed);
  return embed;
};
