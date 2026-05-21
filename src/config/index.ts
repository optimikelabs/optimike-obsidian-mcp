import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { parseVaultExcludePatterns } from "../services/vaultExclusions.js";

dotenv.config();

// --- Determine Project Root ---
/**
 * Finds the project root directory by searching upwards for package.json.
 * @param startDir The directory to start searching from.
 * @returns The absolute path to the project root, or throws an error if not found.
 */
const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached the root of the filesystem without finding package.json
      throw new Error(
        `Could not find project root (package.json) starting from ${startDir}`,
      );
    }
    currentDir = parentDir;
  }
};

let projectRoot: string;
try {
  // For ESM, __dirname is not available directly.
  const currentModuleDir = dirname(fileURLToPath(import.meta.url));
  projectRoot = findProjectRoot(currentModuleDir);
} catch (error: any) {
  console.error(`FATAL: Error determining project root: ${error.message}`);
  projectRoot = process.cwd();
  console.warn(
    `Warning: Using process.cwd() (${projectRoot}) as fallback project root.`,
  );
}
// --- End Determine Project Root ---

const pkgPath = join(projectRoot, "package.json");
let pkg = { name: "optimike-obsidian-mcp", version: "0.0.0" };

try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
} catch (error) {
  if (process.stderr.isTTY) {
    console.error(
      "Warning: Could not read package.json for default config values. Using hardcoded defaults.",
      error,
    );
  }
}

/**
 * Zod schema for validating environment variables.
 * @private
 */
const RuntimeModeSchema = z
  .enum(["live", "hybrid", "headless-readonly", "headless-guarded"])
  .default("live");

const EnvSchema = z
  .object({
  MCP_SERVER_NAME: z.string().optional(),
  MCP_SERVER_VERSION: z.string().optional(),
  MCP_LOG_LEVEL: z.string().default("info"),
  LOGS_DIR: z.string().default(path.join(projectRoot, "logs")),
  NODE_ENV: z.string().default("development"),
  MCP_TRANSPORT_TYPE: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3010),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_AUTH_MODE: z.enum(["jwt", "oauth"]).optional(),
  MCP_AUTH_SECRET_KEY: z
    .string()
    .min(
      32,
      "MCP_AUTH_SECRET_KEY must be at least 32 characters long for security",
    )
    .optional(),
  OAUTH_ISSUER_URL: z.string().url().optional(),
  OAUTH_AUDIENCE: z.string().optional(),
  OAUTH_JWKS_URI: z.string().url().optional(),
  // --- Obsidian Specific Config ---
  OBSIDIAN_RUNTIME_MODE: RuntimeModeSchema,
  OBSIDIAN_API_KEY: z.string().optional(),
  OBSIDIAN_BASE_URL: z.string().url().default("http://127.0.0.1:27123"),
  OBSIDIAN_VERIFY_SSL: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("false"),
  OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  OBSIDIAN_ENABLE_CACHE: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("true"),
  OBSIDIAN_API_SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),
  OBSIDIAN_CACHE_SOURCE: z
    .enum(["auto", "rest", "filesystem"])
    .default("auto"),
  OBSIDIAN_CACHE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  OBSIDIAN_VAULT_EXCLUDE_PATTERNS: z.string().optional(),
  OBSIDIAN_SHARED_CACHE_DB_PATH: z.string().optional(),
  OBSIDIAN_CONTENT_HOT_CACHE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(64),
  OBSIDIAN_STARTUP_MAX_RETRIES: z.coerce.number().int().positive().default(5),
  OBSIDIAN_STARTUP_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3000),
  OBSIDIAN_STARTUP_BLOCKING: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("true"),
  // --- Public runtime safety ---
  MCP_WRITE_MODE: z.enum(["readonly", "guarded", "full"]).optional(),
  MCP_GUARDED_MAX_WRITE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(100000),
  MCP_GUARDED_MAX_BATCH_OPERATIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(25),
  MCP_PROTECTED_FRONTMATTER_KEYS: z
    .string()
    .default("création,modification"),
  // --- Smart Connections Semantic Search ---
  SMART_SEARCH_MODE: z.enum(["plugin", "smartenv", "files"]).default("plugin"),
  SMART_ENV_DIR: z.string().optional(),
  ENABLE_QUERY_EMBEDDING: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("true"),
  // Preferred: "auto" (aligns query embedder to vault embeddings)
  QUERY_EMBEDDER: z.string().default("auto"),
  // Strongest override: forces model regardless of vault detected model.
  QUERY_EMBEDDER_MODEL: z.string().optional(),
  QUERY_EMBEDDER_MODEL_HINT: z.string().optional(),
  // Ollama query embedding support (when vault embeddings were produced via Ollama / Smart Connections)
  OLLAMA_BASE_URL: z.string().optional(),
  // OpenAI query embedding support
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_EMBEDDING_DIMENSIONS: z.string().optional(),
  SMART_ENV_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60000),
  SEMANTIC_SEARCH_PREWARM: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("true"),
  SEMANTIC_SEARCH_PREWARM_TEXT: z
    .string()
    .default("optimike semantic search warmup"),
  OBSIDIAN_VAULT: z.string().optional(),
})
  .superRefine((env, ctx) => {
    if (env.OBSIDIAN_RUNTIME_MODE === "live" && !env.OBSIDIAN_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OBSIDIAN_API_KEY"],
        message: "OBSIDIAN_API_KEY is required in live mode",
      });
    }

    if (
      env.OBSIDIAN_RUNTIME_MODE.startsWith("headless") &&
      !env.OBSIDIAN_VAULT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OBSIDIAN_VAULT"],
        message: "OBSIDIAN_VAULT is required in headless modes",
      });
    }

    if (
      env.OBSIDIAN_RUNTIME_MODE === "hybrid" &&
      !env.OBSIDIAN_API_KEY &&
      !env.OBSIDIAN_VAULT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OBSIDIAN_VAULT"],
        message:
          "OBSIDIAN_VAULT is required in hybrid mode when OBSIDIAN_API_KEY is not configured",
      });
    }
  });

const parsedEnv = EnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const errorDetails = parsedEnv.error.flatten().fieldErrors;
  if (process.stderr.isTTY) {
    console.error("❌ Invalid environment variables:", errorDetails);
  }
  throw new Error(
    `Invalid environment configuration. Please check your .env file or environment variables. Details: ${JSON.stringify(errorDetails)}`,
  );
}

const env = parsedEnv.data;

// --- Directory Ensurance Function ---
const ensureDirectory = (
  dirPath: string,
  rootDir: string,
  dirName: string,
): string | null => {
  const resolvedDirPath = path.isAbsolute(dirPath)
    ? dirPath
    : path.resolve(rootDir, dirPath);

  if (
    !resolvedDirPath.startsWith(rootDir + path.sep) &&
    resolvedDirPath !== rootDir
  ) {
    if (process.stderr.isTTY) {
      console.error(
        `Error: ${dirName} path "${dirPath}" resolves to "${resolvedDirPath}", which is outside the project boundary "${rootDir}".`,
      );
    }
    return null;
  }

  if (!existsSync(resolvedDirPath)) {
    try {
      mkdirSync(resolvedDirPath, { recursive: true });
    } catch (err: unknown) {
      if (process.stderr.isTTY) {
        console.error(
          `Error creating ${dirName} directory at ${resolvedDirPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  } else {
    try {
      if (!statSync(resolvedDirPath).isDirectory()) {
        if (process.stderr.isTTY) {
          console.error(
            `Error: ${dirName} path ${resolvedDirPath} exists but is not a directory.`,
          );
        }
        return null;
      }
    } catch (statError: any) {
      if (process.stderr.isTTY) {
        console.error(
          `Error accessing ${dirName} path ${resolvedDirPath}: ${statError.message}`,
        );
      }
      return null;
    }
  }
  return resolvedDirPath;
};
// --- End Directory Ensurance Function ---

const validatedLogsPath = ensureDirectory(env.LOGS_DIR, projectRoot, "logs");

if (!validatedLogsPath) {
  if (process.stderr.isTTY) {
    console.error(
      "FATAL: Logs directory configuration is invalid or could not be created. Please check permissions and path. Exiting.",
    );
  }
  process.exit(1);
}

/**
 * Main application configuration object.
 */
export const config = {
  pkg,
  projectRoot,
  mcpServerName: env.MCP_SERVER_NAME || pkg.name,
  mcpServerVersion: env.MCP_SERVER_VERSION || pkg.version,
  logLevel: env.MCP_LOG_LEVEL,
  logsPath: validatedLogsPath,
  environment: env.NODE_ENV,
  mcpTransportType: env.MCP_TRANSPORT_TYPE,
  mcpHttpPort: env.MCP_HTTP_PORT,
  mcpHttpHost: env.MCP_HTTP_HOST,
  mcpAllowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  mcpAuthMode: env.MCP_AUTH_MODE,
  mcpAuthSecretKey: env.MCP_AUTH_SECRET_KEY,
  oauthIssuerUrl: env.OAUTH_ISSUER_URL,
  oauthAudience: env.OAUTH_AUDIENCE,
  oauthJwksUri: env.OAUTH_JWKS_URI,
  obsidianApiKey: env.OBSIDIAN_API_KEY,
  obsidianRuntimeMode: env.OBSIDIAN_RUNTIME_MODE,
  obsidianBaseUrl: env.OBSIDIAN_BASE_URL,
  obsidianVerifySsl: env.OBSIDIAN_VERIFY_SSL,
  obsidianCacheRefreshIntervalMin: env.OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN,
  obsidianEnableCache: env.OBSIDIAN_ENABLE_CACHE,
  obsidianApiSearchTimeoutMs: env.OBSIDIAN_API_SEARCH_TIMEOUT_MS,
  obsidianCacheSource: env.OBSIDIAN_CACHE_SOURCE,
  obsidianCacheConcurrency: env.OBSIDIAN_CACHE_CONCURRENCY,
  obsidianVaultExcludePatterns: parseVaultExcludePatterns(
    env.OBSIDIAN_VAULT_EXCLUDE_PATTERNS,
  ),
  obsidianSharedCacheDbPath:
    env.OBSIDIAN_SHARED_CACHE_DB_PATH ||
    path.join(
      env.OBSIDIAN_VAULT ||
        env.SMART_ENV_DIR?.replace(/[/\\]\.smart-env(?:[/\\].*)?$/u, "") ||
        projectRoot,
      ".obsidian",
      "optimike-mcp",
      "shared-cache.sqlite",
    ),
  obsidianContentHotCacheLimit: env.OBSIDIAN_CONTENT_HOT_CACHE_LIMIT,
  obsidianStartupMaxRetries: env.OBSIDIAN_STARTUP_MAX_RETRIES,
  obsidianStartupRetryDelayMs: env.OBSIDIAN_STARTUP_RETRY_DELAY_MS,
  obsidianStartupBlocking: env.OBSIDIAN_STARTUP_BLOCKING,
  mcpWriteMode:
    env.MCP_WRITE_MODE ||
    (env.OBSIDIAN_RUNTIME_MODE === "headless-guarded"
      ? "guarded"
      : env.OBSIDIAN_RUNTIME_MODE === "headless-readonly"
        ? "readonly"
        : "full"),
  mcpGuardedMaxWriteChars: env.MCP_GUARDED_MAX_WRITE_CHARS,
  mcpGuardedMaxBatchOperations: env.MCP_GUARDED_MAX_BATCH_OPERATIONS,
  mcpProtectedFrontmatterKeys: env.MCP_PROTECTED_FRONTMATTER_KEYS.split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  smartSearchMode: env.SMART_SEARCH_MODE,
  smartEnvDir: env.SMART_ENV_DIR,
  enableQueryEmbedding: env.ENABLE_QUERY_EMBEDDING,
  queryEmbedder: env.QUERY_EMBEDDER,
  queryEmbedderModel: env.QUERY_EMBEDDER_MODEL,
  queryEmbedderModelHint: env.QUERY_EMBEDDER_MODEL_HINT,
  ollamaBaseUrl: env.OLLAMA_BASE_URL,
  openaiApiKey: env.OPENAI_API_KEY,
  openaiBaseUrl: env.OPENAI_BASE_URL,
  openaiEmbeddingDimensions: env.OPENAI_EMBEDDING_DIMENSIONS,
  smartEnvCacheTtlMs: env.SMART_ENV_CACHE_TTL_MS,
  semanticSearchPrewarm: env.SEMANTIC_SEARCH_PREWARM,
  semanticSearchPrewarmText: env.SEMANTIC_SEARCH_PREWARM_TEXT,
  obsidianVaultPath: env.OBSIDIAN_VAULT,
};

/**
 * The configured logging level for the application.
 * Exported separately for convenience (e.g., logger initialization).
 * @type {string}
 */
export const logLevel = config.logLevel;

/**
 * The configured runtime environment for the application.
 * Exported separately for convenience.
 * @type {string}
 */
export const environment = config.environment;
