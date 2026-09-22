import path from "node:path";
import { parseDocument } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { SkillSourceFile } from "./skillSourceSnapshot.js";

export type SkillJson = null | boolean | number | string | SkillJson[] | { [key: string]: SkillJson };
export type SkillFrontmatter = { name: string; description: string; [key: string]: SkillJson };
export type SkillValidationCode = "frontmatter_invalid" | "reference_invalid" | "validation_limit";
export class SkillValidationError extends Error {
  constructor(readonly code: SkillValidationCode) {
    super("The skill does not satisfy publication validation.");
    this.name = "SkillValidationError";
  }
}
const fail = (code: SkillValidationCode = "frontmatter_invalid"): never => { throw new SkillValidationError(code); };
const record = (v: SkillJson): v is { [key: string]: SkillJson } => v !== null && typeof v === "object" && !Array.isArray(v);
const length = (s: string) => [...s].length;

export function skillUtf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail(); }
}

/** YAML is parsed as data only. Preserve all authored JSON-compatible fields,
 * not a curated subset; aliases, duplicate/non-string keys and unrepresentable
 * numbers fail closed. Limits are publication policy, not Agent Skills fields.
 */
export function validateSkillFrontmatter(bytes: Buffer, directoryName: string): SkillFrontmatter {
  if (bytes.length > 1024 * 1024) return fail("validation_limit");
  const text = skillUtf8(bytes).replace(/^\ufeff/u, ""); // BOM is retained in raw resource bytes.
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match || Buffer.byteLength(match[1], "utf8") > 64 * 1024) return fail();
  let nodes = 0;
  function json(value: unknown, depth = 0): SkillJson {
    if (++nodes > 8192 || depth > 16) return fail("validation_limit");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return fail();
      return Number(value);
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : fail();
    if (Array.isArray(value)) return value.map(v => json(v, depth + 1));
    if (value instanceof Map) return Object.fromEntries([...value].map(([key, child]) => {
      if (typeof key !== "string") return fail();
      return [key, json(child, depth + 1)];
    }));
    return fail();
  }
  let fm: SkillJson;
  try {
    const doc = parseDocument(match[1], { schema: "core", version: "1.2", uniqueKeys: true, intAsBigInt: true });
    if (doc.errors.length || doc.warnings.length) return fail();
    fm = json(doc.toJS({ mapAsMap: true, maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    return fail(); // Never expose YAML parser messages containing authored content.
  }
  if (!record(fm) || typeof fm.name !== "string" || typeof fm.description !== "string") return fail();
  if (length(fm.name) < 1 || length(fm.name) > 64 || fm.name !== fm.name.toLowerCase() ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(fm.name) || fm.name !== directoryName) return fail();
  if (!fm.description.trim() || length(fm.description) > 1024) return fail();
  for (const key of ["license", "allowed-tools"]) if (fm[key] !== undefined && typeof fm[key] !== "string") return fail();
  if (fm.compatibility !== undefined && (typeof fm.compatibility !== "string" ||
    !fm.compatibility.trim() || length(fm.compatibility) > 500)) return fail();
  if (fm.metadata !== undefined && (!record(fm.metadata) || Object.values(fm.metadata).some(v => typeof v !== "string"))) return fail();
  return fm as SkillFrontmatter;
}

/** Check explicit local Markdown links against the complete file set. External
 * HTTP/mail/skill URIs are prerequisites, never fetched or added to manifests.
 * Ordinary relative links resolve from their containing document; they cannot
 * escape the published directory. Text mentioning a path is not an access grant.
 */
export function validateSkillReferences(files: readonly SkillSourceFile[]): void {
  const present = new Set(files.map(f => f.path));
  type Node = { type: string; url?: string; children?: Node[] };
  for (const file of files) {
    if (!/\.(?:md|markdown)$/iu.test(file.path)) continue;
    if (file.bytes.length > 1024 * 1024) return fail("validation_limit");
    const queue: Node[] = [fromMarkdown(skillUtf8(file.bytes)) as Node];
    let visited = 0;
    while (queue.length) {
      if (++visited > 200_000) return fail("validation_limit");
      const node = queue.pop()!;
      for (const child of node.children ?? []) queue.push(child);
      if (!["link", "image", "definition"].includes(node.type) || typeof node.url !== "string") continue;
      const url = node.url;
      if (!url || url.startsWith("#")) continue;
      if (/^(?:https?:|mailto:|skill:)/iu.test(url)) continue;
      if (/^[a-z][a-z0-9+.-]*:/iu.test(url) || url.startsWith("//")) return fail("reference_invalid");
      let target: string;
      try { target = decodeURIComponent(url.split(/[?#]/u, 1)[0]); }
      catch { return fail("reference_invalid"); }
      if (!target) continue;
      if (target.startsWith("/") || /[\\:\x00-\x1f]/u.test(target)) return fail("reference_invalid");
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
      if (resolved === ".." || resolved.startsWith("../") || !present.has(resolved)) return fail("reference_invalid");
    }
  }
}
