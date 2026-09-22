import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ExternalRootsService } from "../externalRootsService.js";
import type { ToolProfileId } from "../../mcp-server/toolProfiles.js";
import { SkillDirectoryError, type SkillSourceSnapshot } from "./skillSourceSnapshot.js";
import { SkillValidationError, skillUtf8, validateSkillFrontmatter, validateSkillReferences,
  type SkillFrontmatter } from "./skillValidation.js";

const ROOT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const PROFILE_IDS = ["standard", "authoring", "tasks", "full"] as const;
const relativeDirectory = z.string().min(1).max(1024).refine(value =>
  !/[\\:\x00-\x1f]/u.test(value) && value.split("/").every(segment =>
    Boolean(segment) && segment !== "." && segment !== ".." && !segment.startsWith(".") && !/[. ]$/u.test(segment)));
const PublicationSchema = z.object({
  rootId: z.string().regex(ROOT_ID),
  path: relativeDirectory,
  profiles: z.array(z.enum(PROFILE_IDS)).min(1).max(4).default(["full"]),
  listed: z.boolean().default(true),
}).strict();
export const SkillsPublicationConfigSchema = z.object({
  version: z.literal(1),
  pageSize: z.number().int().min(1).max(10).default(5),
  skills: z.array(PublicationSchema).max(64),
}).strict();
type Publication = z.infer<typeof PublicationSchema>;
type PublicationConfig = z.infer<typeof SkillsPublicationConfigSchema>;
export type SkillEntry = {
  uri: string;
  frontmatter: SkillFrontmatter;
  resources: Array<{ uri: string; digest: string; size: number }>;
};
export type SkillRegistryReason = "configuration_invalid" | "not_found" | "cursor_invalid" |
  "source_denied" | "source_changed" | "source_limit" | "source_unavailable" |
  "frontmatter_invalid" | "reference_invalid" | "validation_limit";
export class SkillRegistryError extends Error {
  constructor(readonly reason: SkillRegistryReason) {
    super("The requested skill or resource is unavailable under the active publication policy.");
    this.name = "SkillRegistryError";
  }
}
const reject = (reason: SkillRegistryReason): never => { throw new SkillRegistryError(reason); };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const rootUri = (pub: Publication) => `skill://${pub.rootId}/${pub.path.split("/").map(encode).join("/")}`;
const fileUri = (pub: Publication, relative: string) => `${rootUri(pub)}/${relative.split("/").map(encode).join("/")}`;
const freshness = { resultType: "complete", ttlMs: 0, cacheScope: "private" } as const;
export function isSkillResourceUri(value: string): boolean { return /^skill:/iu.test(value); }

/** This is an operator-selected config, not a path supplied over MCP. A bounded
 * opened-file read prevents oversized configs and common replacement races.
 * Root filesystem authorization is still owned by ExternalRootsService.
 */
export async function readSkillsPublicationConfig(file: string): Promise<unknown> {
  if (!path.isAbsolute(file)) return reject("configuration_invalid");
  try {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 64n * 1024n) return reject("configuration_invalid");
    const handle = await open(file, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) return reject("configuration_invalid");
      const buffer = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) return reject("configuration_invalid");
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const final = await lstat(file, { bigint: true });
      const same = (a: typeof opened, b: typeof opened) =>
        a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
      if (!same(opened, after) || !same(after, final) || final.isSymbolicLink()) return reject("configuration_invalid");
      return JSON.parse(skillUtf8(buffer));
    } finally { await handle.close(); }
  } catch { return reject("configuration_invalid"); }
}

const mimeTypes: Readonly<Record<string, string>> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".csv": "text/csv", ".html": "text/html", ".xml": "application/xml",
  ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/plain", ".sh": "text/x-shellscript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip",
};

export class SkillRegistry {
  private readonly publications: Publication[];
  private readonly config: PublicationConfig;
  private readonly cursorBinding: string;
  constructor(private readonly roots: Pick<ExternalRootsService, "readSkillDirectorySnapshot">,
    config: unknown, readonly profile: ToolProfileId) {
    const parsed = SkillsPublicationConfigSchema.safeParse(config);
    if (!parsed.success || !PROFILE_IDS.includes(profile)) throw new SkillRegistryError("configuration_invalid");
    this.config = parsed.data;
    const uris = new Set<string>();
    for (const publication of this.config.skills) {
      const uri = fileUri(publication, "SKILL.md");
      if (uris.has(uri)) throw new SkillRegistryError("configuration_invalid");
      uris.add(uri);
    }
    this.publications = this.config.skills.filter(pub => pub.profiles.includes(profile))
      .sort((a, b) => compare(rootUri(a), rootUri(b)));
    this.cursorBinding = digest(JSON.stringify({ profile, config: this.config })).slice(0, 32);
  }

  private async load(pub: Publication): Promise<{ entry: SkillEntry; snapshot: SkillSourceSnapshot }> {
    try {
      const snapshot = await this.roots.readSkillDirectorySnapshot(pub.rootId, pub.path);
      const skill = snapshot.files.find(file => file.path === "SKILL.md");
      if (!skill) return reject("frontmatter_invalid");
      const frontmatter = validateSkillFrontmatter(skill.bytes, pub.path.split("/").at(-1)!);
      validateSkillReferences(snapshot.files);
      return { snapshot, entry: {
        uri: fileUri(pub, "SKILL.md"), frontmatter,
        resources: snapshot.files.map(file => ({ uri: fileUri(pub, file.path),
          digest: `sha256:${digest(file.bytes)}`, size: file.bytes.length })),
      } };
    } catch (error) {
      if (error instanceof SkillRegistryError) throw error;
      if (error instanceof SkillDirectoryError || error instanceof SkillValidationError)
        return reject(error.code);
      return reject("source_unavailable");
    }
  }

  private offset(cursor: string | undefined, length: number): number {
    if (cursor === undefined) return 0;
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(cursor)) return reject("cursor_invalid");
    try {
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.toString("base64url") !== cursor) return reject("cursor_invalid");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== this.cursorBinding ||
        !Number.isSafeInteger(value[1]) || value[1] < 1 || value[1] >= length) return reject("cursor_invalid");
      return value[1];
    } catch { return reject("cursor_invalid"); }
  }

  async list(cursor?: string) {
    const listed = this.publications.filter(pub => pub.listed);
    let offset = this.offset(cursor, listed.length);
    const skills: SkillEntry[] = [];
    while (offset < listed.length && skills.length < this.config.pageSize) {
      const pub = listed[offset++];
      try { skills.push((await this.load(pub)).entry); }
      catch { /* Invalid/unavailable sources are omitted, never partially published. Use the readonly local audit for reasons. */ }
    }
    return { ...freshness, skills, ...(offset < listed.length
      ? { nextCursor: Buffer.from(JSON.stringify([this.cursorBinding, offset])).toString("base64url") } : {}) };
  }

  async get(uri: string) {
    const pub = this.publications.find(pub => uri === fileUri(pub, "SKILL.md"));
    if (!pub || uri.length > 4096) return reject("not_found");
    return { ...freshness, skill: (await this.load(pub)).entry };
  }

  async read(uri: string) {
    if (uri.length > 4096) return reject("not_found");
    // Match the exact authored namespace and then the complete manifest. Never
    // normalize attacker-controlled URLs (URL would erase ../ and aliases).
    const candidates = this.publications.filter(pub => uri.startsWith(rootUri(pub) + "/"))
      .sort((a, b) => rootUri(b).length - rootUri(a).length);
    for (const pub of candidates) {
      const { snapshot } = await this.load(pub);
      const file = snapshot.files.find(file => uri === fileUri(pub, file.path));
      if (!file) continue;
      const mimeType = mimeTypes[path.posix.extname(file.path).toLowerCase()] ?? "application/octet-stream";
      let text: string | undefined;
      if (!file.bytes.includes(0)) {
        try { text = skillUtf8(file.bytes); } catch { /* binary */ }
      }
      return { ...freshness, contents: [{ uri, mimeType, ...(text === undefined
        ? { blob: file.bytes.toString("base64") } : { text }) }] };
    }
    return reject("not_found");
  }

  /** Operator-facing audit of configured logical URIs only. Not a new MCP tool. */
  async audit() {
    const results: Array<{ uri: string; state: "eligible" | "refused"; reason?: SkillRegistryReason }> = [];
    for (const pub of this.publications) {
      try { await this.load(pub); results.push({ uri: fileUri(pub, "SKILL.md"), state: "eligible" }); }
      catch (error) { results.push({ uri: fileUri(pub, "SKILL.md"), state: "refused",
        reason: error instanceof SkillRegistryError ? error.reason : "source_unavailable" }); }
    }
    return results;
  }
}
