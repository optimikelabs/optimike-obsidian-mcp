import { promises as fs } from "node:fs";
import path from "node:path";

type Embed = (text: string) => Promise<number[]>;
type Observation = { dimension: number; ok: boolean; at: number };
const observations = new WeakMap<Embed, Observation>();
export const SEMANTIC_HEALTH_TTL_MS = 60_000;
export function recordSemanticSearch(embed: Embed, dimension: number, ok: boolean, now = Date.now()): void {
  observations.set(embed, { dimension, ok, at: now });
}
export function semanticSearchHealth(embed: Embed, dimension: number, now = Date.now()): "verified" | "failed" | "unverified" {
  const value = observations.get(embed);
  if (!value || value.dimension !== dimension || now < value.at || now - value.at > SEMANTIC_HEALTH_TTL_MS) return "unverified";
  return value.ok ? "verified" : "failed";
}
export function validQueryVector(vector: number[], dimension: number): boolean {
  return vector.length === dimension && vector.every(Number.isFinite) && vector.some(value => value !== 0);
}

function wrapLooseObjectToJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  // embedding_models.ajson uses a loose object fragment (no outer braces)
  const withoutTrailingComma = trimmed.replace(/,\s*$/u, "");
  return `{${withoutTrailingComma}}`;
}

export async function detectOllamaBaseUrlFromSmartEnv(
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
      const modelsPath = path.join(
        smartEnvDir,
        "embedding_models",
        "embedding_models.ajson",
      );
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
      const modelsPath = path.join(
        smartEnvDir,
        "embedding_models",
        "embedding_models.ajson",
      );
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

