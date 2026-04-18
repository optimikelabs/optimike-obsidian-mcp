import { promises as fs } from "fs";
import { execFile } from "node:child_process";
import path from "path";
import { promisify } from "node:util";

// ---- Types ----
export type SmartVec = {
  id: string;
  notePath: string;
  title?: string;
  tags?: string[];
  model?: string;
  vec: number[];
};

// ---- Scan config ----
const SUBDIRS = ["", "multi", "vectors", "cache"];
const EXTS = [".ajson", ".json", ".jsonl", ".ndjson"];
const execFileAsync = promisify(execFile);

const isNumArr = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === "number");

const isEioError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "EIO";

const splitLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

async function listEmbeddingFilesViaRipgrep(directory: string): Promise<string[]> {
  const args = ["--files", "--max-depth", "1", directory];

  try {
    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: 32 * 1024 * 1024,
    });

    return splitLines(stdout)
      .map((entry) => path.basename(entry))
      .filter((entry) =>
        EXTS.some((extension) => entry.toLowerCase().endsWith(extension)),
      );
  } catch (error) {
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";

    if (!stdout) {
      return [];
    }

    return splitLines(stdout)
      .map((entry) => path.basename(entry))
      .filter((entry) =>
        EXTS.some((extension) => entry.toLowerCase().endsWith(extension)),
      );
  }
}

// ---- Loose parsing helpers ----
const stripBOM = (s: string) => s.replace(/^\uFEFF/, "");

const stripComments = (s: string) =>
  s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const stripTrailingCommas = (s: string) =>
  s.replace(/,\s*([}\]])/g, "$1");

const quoteBareKeys = (s: string) =>
  s.replace(/(^|[{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

const singleToDoubleQuotes = (s: string) =>
  s.replace(/'([^'\\]|\\.)*'/g, (match) => {
    const inner = match.slice(1, -1).replace(/"/g, '\\"');
    return `"${inner}"`;
  });

async function parseJSON5IfAvailable(input: string): Promise<unknown[] | null> {
  try {
    const mod = await import("json5");
    const parsed = (mod as { parse: (source: string) => unknown }).parse(input);
    return coerceRecords(parsed);
  } catch {
    return null;
  }
}

const toNumberArray = (value: unknown): number[] | null => {
  if (isNumArr(value)) return value;

  if (typeof value === "string") {
    const parts = value
      .trim()
      .replace(/\[|\]/g, "")
      .split(/[\s,]+/)
      .map((token) => Number(token))
      .filter((token) => Number.isFinite(token));

    return parts.length ? parts : null;
  }

  return null;
};

function coerceRecords(obj: unknown): unknown[] {
  if (!obj || typeof obj !== "object") return [];

  if (Array.isArray(obj)) return obj;

  const record = obj as Record<string, unknown>;

  const candidates = ["items", "records", "vectors", "data"] as const;

  for (const key of candidates) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }

  if (
    typeof record.path === "string" ||
    typeof record.notePath === "string" ||
    typeof record.filePath === "string" ||
    typeof record.file === "string" ||
    typeof record.fullPath === "string" ||
    isNumArr(record.vec) ||
    isNumArr(record.vector) ||
    isNumArr(record.embedding) ||
    isNumArr(record.values)
  ) {
    return [record];
  }

  const nested = Object.entries(record)
    .filter(([, value]) => value && typeof value === "object")
    .map(([key, value]) => ({
      __smartEnvKey: key,
      ...(value as Record<string, unknown>),
    }));

  if (nested.length) {
    return nested;
  }

  return [record];
}

async function parseLooseJSONLike(raw: string): Promise<unknown[] | null> {
  let content = stripBOM(raw);

  try {
    const parsed = JSON.parse(content);
    return coerceRecords(parsed);
  } catch {
    // Ignore and try other fallbacks.
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length > 1) {
    const records: unknown[] = [];
    let parsedAny = false;

    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
        parsedAny = true;
      } catch {
        // ignore individual ndjson failures
      }
    }

    if (parsedAny) return records;
  }

  const json5Parsed = await parseJSON5IfAvailable(content);
  if (json5Parsed) return json5Parsed;

  content = stripComments(content);
  content = stripTrailingCommas(content);
  content = singleToDoubleQuotes(content);
  content = quoteBareKeys(content);

  let trimmed = content.trim();

  if (
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[") &&
    /["'][^"']+["']\s*:/.test(trimmed)
  ) {
    trimmed = `{${trimmed.replace(/,\s*$/u, "")}}`;
  }

  content = trimmed;

  try {
    const parsed = JSON.parse(content);
    return coerceRecords(parsed);
  } catch {
    return null;
  }
}

function mapDocToSmartVec(doc: unknown, fallbackId: string): SmartVec | null {
  if (!doc || typeof doc !== "object") return null;

  const candidate = doc as Record<string, unknown>;
  const embedding =
    candidate.embedding ??
    candidate.vector ??
    candidate.vec ??
    candidate.emb ??
    candidate.values;

  let vec = toNumberArray(embedding);
  let derivedModel: string | undefined;

  if (!vec) {
    const embeddings = candidate.embeddings;
    if (embeddings && typeof embeddings === "object") {
      for (const [key, value] of Object.entries(
        embeddings as Record<string, unknown>,
      )) {
        if (!value || typeof value !== "object") continue;
        const nested = value as Record<string, unknown>;
        const nestedVec = toNumberArray(
          nested.vec ?? nested.embedding ?? nested.vector ?? nested.values,
        );
        if (nestedVec) {
          vec = nestedVec;
          derivedModel =
            typeof nested.model === "string"
              ? nested.model
              : typeof key === "string"
                ? key
                : undefined;
          break;
        }
      }
    }
  }
  const notePath =
    candidate.path ??
    candidate.notePath ??
    candidate.filePath ??
    candidate.file ??
    candidate.fullPath;

  if (!vec || typeof notePath !== "string") return null;

  const title =
    typeof candidate.title === "string"
      ? candidate.title
      : typeof candidate.name === "string"
        ? candidate.name
        : undefined;

  const tags =
    Array.isArray(candidate.tags)
      ? candidate.tags.filter((entry): entry is string => typeof entry === "string")
      : typeof candidate.tags === "string"
        ? candidate.tags.split(/[,\s]+/).filter((entry) => entry.length > 0)
        : undefined;

  let model =
    typeof candidate.model === "string"
      ? candidate.model
      : typeof candidate.encoder === "string"
        ? candidate.encoder
        : typeof candidate.embedding_model === "string"
          ? candidate.embedding_model
          : undefined;

  if (!model && derivedModel) {
    model = derivedModel;
  }

  const keyHint = (candidate as { __smartEnvKey?: unknown }).__smartEnvKey;
  const sourceKey = typeof keyHint === "string" ? keyHint : fallbackId;

  return {
    id:
      typeof candidate.id === "string" && candidate.id
        ? candidate.id
        : sourceKey,
    notePath,
    title,
    tags,
    model,
    vec,
  };
}

async function listEmbeddingFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const handle = await fs.opendir(directory);
  let hadEio = false;

  try {
    for await (const entry of handle) {
      if (!entry.isFile()) continue;

      const name = entry.name;
      if (EXTS.some((extension) => name.toLowerCase().endsWith(extension))) {
        files.push(name);
      }
    }
  } catch (error) {
    // WSL + drvfs can raise EIO while iterating large directories.
    // Keep already-read entries instead of failing the whole scan.
    if (!(isEioError(error) && files.length > 0)) {
      throw error;
    }
    hadEio = true;
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (!hadEio) {
    return files;
  }

  const fromRipgrep = await listEmbeddingFilesViaRipgrep(directory);
  if (!fromRipgrep.length) {
    return files;
  }

  return [...new Set([...files, ...fromRipgrep])];
}

export async function loadSmartEnv(baseDir: string): Promise<SmartVec[]> {
  const collected: SmartVec[] = [];

  for (const subdir of SUBDIRS) {
    const directory = subdir ? path.join(baseDir, subdir) : baseDir;
    let files: string[] = [];

    try {
      files = await listEmbeddingFiles(directory);
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = path.join(directory, file);

      try {
        const raw = await fs.readFile(fullPath, "utf-8");
        const records = await parseLooseJSONLike(raw);

        if (!records) continue;

        for (const record of records) {
          const item = mapDocToSmartVec(
            record,
            file.replace(/\.(a)?json(l)?$/i, ""),
          );
          if (item) collected.push(item);
        }
      } catch {
        // ignore malformed file
      }
    }
  }

  if (!collected.length) {
    throw new Error(`No embeddings found in ${baseDir}`);
  }

  return collected;
}

export class SmartEnvCache {
  private cache: SmartVec[] | null = null;

  private expiresAt = 0;

  constructor(
    private readonly directory: string,
    private readonly ttlMs: number,
  ) {}

  public clear(): void {
    this.cache = null;
    this.expiresAt = 0;
  }

  public async getVectors(): Promise<SmartVec[]> {
    if (!this.directory) {
      throw new Error("SMART_ENV_DIR is not configured");
    }

    const now = Date.now();

    if (
      !this.cache ||
      this.ttlMs <= 0 ||
      now >= this.expiresAt ||
      !this.cache.length
    ) {
      this.cache = await loadSmartEnv(this.directory);
      this.expiresAt = now + Math.max(this.ttlMs, 0);
    }

    return this.cache;
  }
}

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const valueA = a[index];
    const valueB = b[index];
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
};
