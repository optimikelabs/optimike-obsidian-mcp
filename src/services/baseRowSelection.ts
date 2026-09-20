import { createHash } from "node:crypto";
import { load } from "js-yaml";
import { z } from "zod";
import { nativeNotePath } from "./nativeNoteMoveContract.js";
import type { ObsidianRestApiService } from "./obsidianRestAPI/service.js";
import { requestContextService } from "../utils/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";

export const BaseRowTargetSchema = z.object({
  baseId: z.string().min(1).max(1024),
  view: z.string().trim().min(1).max(256),
  path: z.string().min(1).max(1024),
}).strict();
export type BaseRowTarget = z.infer<typeof BaseRowTargetSchema>;
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const BaseRowSelectionSchema = BaseRowTargetSchema.extend({
  baseSha256: Hash,
  baseBindingFingerprint: Hash,
  source: z.literal("bases-bridge-supported-filter-snapshot"),
  freshness: z.literal("unknown"),
}).strict();
export type BaseRowSelection = z.infer<typeof BaseRowSelectionSchema>;
const Document = z.object({
  ok: z.literal(true), contractVersion: z.literal(1), path: z.string(),
  yaml: z.string().max(256 * 1024), sha256: Hash,
  size: z.number().int().nonnegative().max(256 * 1024), bindingFingerprint: Hash,
}).strict();
const Query = z.object({
  total: z.number().int().nonnegative().max(500), page: z.literal(1),
  rows: z.array(z.object({ file: z.object({ path: z.string().min(1).max(1024) }).passthrough() }).passthrough()).max(500),
  baseSnapshot: z.object({ contractVersion: z.literal(1), path: z.string().min(1).max(1024),
    sha256: Hash, bindingFingerprint: Hash }).strict(),
  source: z.literal("fallback"), evaluate: z.literal(false),
  warnings: z.array(z.string()).max(0),
}).passthrough();
export interface BaseRowSelectionTransport {
  read(baseId: string): Promise<unknown>;
  query(baseId: string, view: string): Promise<unknown>;
}
function refuse(reason: string): never {
  throw new McpError(BaseErrorCode.CONFLICT, "The Base row selection is unavailable, ambiguous or changed; replan is required.", { reason });
}
export function baseRowTarget(value: unknown): BaseRowTarget {
  const p = BaseRowTargetSchema.parse(value);
  if (!p.baseId.endsWith(".base")) refuse("invalid_base_path");
  nativeNotePath(p.baseId.slice(0, -5) + ".md");
  nativeNotePath(p.path);
  return p;
}
function document(value: unknown, target: BaseRowTarget) {
  const d = Document.safeParse(value);
  if (!d.success) refuse("invalid_base_snapshot");
  const p = d.data;
  if (p.path !== target.baseId || Buffer.byteLength(p.yaml, "utf8") !== p.size ||
      createHash("sha256").update(p.yaml, "utf8").digest("hex") !== p.sha256) refuse("invalid_base_snapshot");
  let config: unknown;
  try { config = load(p.yaml); } catch { refuse("invalid_base_yaml"); }
  const parsed = z.object({ views: z.array(z.object({ name: z.string() }).passthrough()).max(100) }).passthrough().safeParse(config);
  if (!parsed.success || parsed.data.views.filter(v => v.name === target.view).length !== 1) refuse("ambiguous_base_view");
  return p;
}
/** A read-only supported-filter snapshot, not a native engine or a transaction. */
export class BaseRowSelectionReader {
  constructor(private readonly transport: BaseRowSelectionTransport) {}
  async select(input: BaseRowTarget): Promise<BaseRowSelection> {
    const target = baseRowTarget(input);
    const before = document(await this.transport.read(target.baseId), target);
    const q = Query.safeParse(await this.transport.query(target.baseId, target.view));
    if (!q.success || q.data.total !== q.data.rows.length) refuse("incomplete_or_unsupported_selection");
    if (q.data.baseSnapshot.path !== target.baseId || q.data.baseSnapshot.sha256 !== before.sha256 ||
        q.data.baseSnapshot.bindingFingerprint !== before.bindingFingerprint) refuse("query_base_snapshot_mismatch");
    const paths = q.data.rows.map(row => row.file.path);
    if (new Set(paths).size !== paths.length || !paths.includes(target.path)) refuse("row_not_uniquely_selected");
    const after = document(await this.transport.read(target.baseId), target);
    if (after.sha256 !== before.sha256 || after.bindingFingerprint !== before.bindingFingerprint) refuse("base_changed_during_selection");
    return { ...target, baseSha256: before.sha256, baseBindingFingerprint: before.bindingFingerprint,
      source: "bases-bridge-supported-filter-snapshot", freshness: "unknown" };
  }
}
export function restBaseRowSelection(rest: ObsidianRestApiService): BaseRowSelectionReader {
  return new BaseRowSelectionReader({
    read: path => rest.readAtomicBase({ contractVersion: 1, path }, requestContextService.createRequestContext({ operation: "BaseRowSealRead" })),
    query: (baseId, view) => rest.queryBase(baseId, { view, evaluate: false, limit: 500, page: 1 },
      requestContextService.createRequestContext({ operation: "BaseRowSelection" })),
  });
}
