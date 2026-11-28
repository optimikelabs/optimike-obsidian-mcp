import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { JSON_SCHEMA, load } from "js-yaml";
import picomatch from "picomatch/posix.js";
import { z } from "zod/v3";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { compileFrontmatterPatch, nativeFrontmatterPatchKeys, type FrontmatterPatchOperation } from "../frontmatterPatchCompiler.js";
import { frontmatterEnvelope } from "../obsidianFrontmatterFormat.js";
import { operationDigest } from "./contract.js";

const property = z.string().max(128)
  .regex(/^[\p{L}_](?:[\p{L}\p{M}\p{N}_. -]*[\p{L}\p{M}\p{N}_.-])?$/u)
  .refine(key => !/^(?:null|true|false|yes|no|on|off)$/iu.test(key));
const settings = z.object({
  enableAutoUpdate: z.literal(true),
  enableCreateTime: z.boolean(),
  enableModifiedTime: z.literal(true).optional(),
  headerCreated: property,
  headerUpdated: property,
  headerLastViewed: property.optional(),
  enableLastViewed: z.boolean().optional(),
  dateFormat: z.enum(["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss"]),
  timezone: z.string().max(128).optional(),
  enableContentHashCheck: z.boolean().default(true),
  hashTrackingMode: z.enum(["body", "frontmatter", "both"]).default("body"),
  frontmatterHashExcludeKeys: z.array(z.string()).max(0).optional(),
  trackExcalidraw: z.boolean().default(true),
  minSecondsBetweenSaves: z.number().int().min(5).max(300).default(30),
  enableNumberProperties: z.literal(false).optional(),
  countUpdatesEnabled: z.literal(false).optional(),
  postUpdateCommand: z.literal("").optional(),
  inversionFixStrategy: z.literal("disabled").optional(),
  filterRules: z.string().max(32768),
});

function unavailable(): never {
  throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE,
    "Headless governed writes need readable, unambiguous Frontmatter Date Manager settings.",
    { reasonCode: "headless_date_policy_unavailable" });
}

export const normalizeDateKey = (key: string) => key.normalize("NFC").trim().toLowerCase();

export async function readFilesystemDatePolicy(readConfig: (path: string, optional?: boolean) => Promise<string | undefined>) {
  const json = async (file: string, optional = false): Promise<unknown> => {
    const raw = await readConfig(file, optional);
    return raw === undefined ? undefined : JSON.parse(raw.replace(/^\uFEFF/u, ""));
  };
  try {
    const plugins = z.array(z.string()).parse(await json(".obsidian/community-plugins.json"));
    if (!plugins.includes("frontmatter-date-manager") ||
        plugins.some(id => id === "update-time" || id === "update-time-on-edit")) unavailable();
    const raw = await json(".obsidian/plugins/frontmatter-date-manager/data.json");
    const fdm = settings.parse(raw);
    const processTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const explicitTimezone = fdm.timezone || process.env.TZ;
    if (!explicitTimezone || Intl.DateTimeFormat("en", { timeZone: explicitTimezone }).resolvedOptions().timeZone !== processTimezone) unavailable();
    const keys = [fdm.headerCreated, fdm.headerUpdated, ...(fdm.enableLastViewed ? [fdm.headerLastViewed ?? "viewed"] : [])];
    if (new Set(keys.map(normalizeDateKey)).size !== keys.length) unavailable();
    const templateFolders: string[] = [];
    const templates = await json(".obsidian/templates.json", true);
    const templater = await json(".obsidian/plugins/templater-obsidian/data.json", !plugins.includes("templater-obsidian"));
    for (const folder of [
      z.object({ folder: z.string().optional() }).optional().parse(templates)?.folder,
      z.object({ templates_folder: z.string() }).optional().parse(templater)?.templates_folder,
    ]) {
      const directory = folder?.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
      if (directory && (posix.normalize(directory) !== directory || directory.split("/").includes(".."))) unavailable();
      if (directory) templateFolders.push(directory);
    }
    const rules = fdm.filterRules.split(/\r?\n/u).map(line => line.trim())
      .filter(line => line && !line.startsWith("#")).map(line => {
        const negated = line.startsWith("!");
        const pattern = (negated ? line.slice(1) : line).trim();
        if (!pattern) return undefined;
        const matches = /[*?[{]/u.test(pattern) ? picomatch(pattern) :
          (path: string) => path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
        return { negated, matches };
      });
    return {
      digest: operationDigest({ fdm, templateFolders, timezone: processTimezone }),
      keys, fdm,
      managed(path: string) {
        if (posix.basename(path).toLowerCase() === "canvas.md") return false;
        if (templateFolders.some(folder => path.startsWith(folder + "/"))) return false;
        let excluded = false;
        for (const rule of rules) if (rule?.matches(path)) excluded = !rule.negated;
        return !excluded;
      },
    };
  } catch { return unavailable(); }
}

export type FilesystemDatePolicy = Awaited<ReturnType<typeof readFilesystemDatePolicy>>;

function properties(content: string): Record<string, unknown> {
  return (load(frontmatterEnvelope(content)?.yaml ?? "", { schema: JSON_SCHEMA }) ?? {}) as Record<string, unknown>;
}

function managedNote(policy: FilesystemDatePolicy, path: string, content: string): boolean {
  return policy.managed(path) && Boolean(content.replace(/^\uFEFF/u, "").trim()) &&
    (policy.fdm.trackExcalidraw || !properties(content)["excalidraw-plugin"]);
}

function changesModification(policy: FilesystemDatePolicy, before: string | undefined, after: string) {
  if (before === undefined || !policy.fdm.enableContentHashCheck) return true;
  const body = (content: string) => {
    const envelope = frontmatterEnvelope(content);
    return envelope ? content.slice(envelope.end).replace(/^---\r?\n?/u, "") : content.replace(/^\uFEFF/u, "");
  };
  const mode = policy.fdm.hashTrackingMode;
  if (mode !== "frontmatter" && body(before) !== body(after)) return true;
  if (mode === "body") return false;
  const owned = new Set(policy.keys.map(normalizeDateKey));
  const tracked = (content: string) => Object.fromEntries(Object.entries(properties(content)).filter(([key]) => !owned.has(normalizeDateKey(key))));
  return !isDeepStrictEqual(tracked(before), tracked(after));
}

export function renderFilesystemDates(content: string, updates: FrontmatterPatchOperation[]) {
  if (!updates.length) return content;
  const eol = /^\uFEFF?---(\r?\n)/u.exec(content)?.[1] ?? "\n";
  const entries = Object.fromEntries(nativeFrontmatterPatchKeys(content, updates)
    .map(({ normalized, key, value }) => [normalized, `${key}: ${value}${eol}`]));
  return compileFrontmatterPatch(content, updates, entries).nextContent;
}

function checkSaveInterval(policy: FilesystemDatePolicy, before: string | undefined, now: number) {
  if (before === undefined) return;
  const previous = Object.entries(properties(before)).find(([key]) => normalizeDateKey(key) === normalizeDateKey(policy.fdm.headerUpdated))?.[1];
  if (typeof previous !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/u.test(previous)) return;
  if (now <= new Date(previous).getTime() + policy.fdm.minSecondsBetweenSaves * 1000) {
    throw new McpError(BaseErrorCode.CONFLICT, "The date manager's minimum save interval has not elapsed.", { reasonCode: "headless_date_save_interval" });
  }
}

function timestamp(epochMs: number, seconds: boolean): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime()) || epochMs <= 0) unavailable();
  return new Date(epochMs - date.getTimezoneOffset() * 60_000).toISOString().slice(0, seconds ? 19 : 16);
}

export function sealFilesystemDates(policy: FilesystemDatePolicy, path: string, content: string, now: number,
  source?: { content: string; birthtimeMs: number }): string {
  // Preserve the note's envelope and use its existing EOL convention for a
  // whole replacement. A mixed note's untouched ranges stay byte-for-byte.
  const original = source?.content ?? content;
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const crlf = original.includes("\r\n") && !/(?<!\r)\n/u.test(original);
  const lf = /(?<!\r)\n/u.test(original) && !original.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  let next = content.replace(/^\uFEFF/u, "");
  if (crlf || lf) next = next.replace(/\r?\n/gu, eol);
  if (!managedNote(policy, path, bom + next)) return bom + next;
  const { fdm } = policy;
  const fields = properties(original);
  const created = Object.entries(fields).find(([key]) => normalizeDateKey(key) === normalizeDateKey(fdm.headerCreated))?.[1];
  const setCreated = fdm.enableCreateTime && (created == null || created === "");
  const setUpdated = changesModification(policy, source?.content, bom + next);
  if (!setCreated && !setUpdated) return bom + next;
  if (setUpdated) checkSaveInterval(policy, source?.content, now);
  const fm = frontmatterEnvelope(bom + next);
  if (!fm) next = `---${eol}---${eol}${next}`;
  else if (fm.yaml.trim() === "{}") next = (bom + next).slice(bom.length, fm.start) + (bom + next).slice(fm.end);
  const seconds = fdm.dateFormat.endsWith(":ss");
  const values: FrontmatterPatchOperation[] = [];
  if (setUpdated) values.push({ op: "set", key: fdm.headerUpdated, value: timestamp(now, seconds) });
  if (setCreated) {
    values.push({ op: "set", key: fdm.headerCreated, value: timestamp(source?.birthtimeMs ?? now, seconds) });
  }
  return bom + renderFilesystemDates(next, values);
}

/** The plan seals the field policy and allowed change; the filesystem effect
 * records the exact timestamped bytes just before publication. */
export function materializeFilesystemDates(policy: FilesystemDatePolicy, path: string, content: string, now: number, before?: string) {
  if (!managedNote(policy, path, content) || !changesModification(policy, before, content)) return content;
  checkSaveInterval(policy, before, now);
  const value = timestamp(now, policy.fdm.dateFormat.endsWith(":ss"));
  const updates: FrontmatterPatchOperation[] = [{ op: "set", key: policy.fdm.headerUpdated, value }];
  if (before === undefined && policy.fdm.enableCreateTime) updates.push({ op: "set", key: policy.fdm.headerCreated, value });
  return renderFilesystemDates(content, updates);
}
