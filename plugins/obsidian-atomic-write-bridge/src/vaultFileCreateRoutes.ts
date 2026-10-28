import { realpathSync } from "node:fs";
import type { App } from "obsidian";
import { NoteNameError, noteNameFixedHint } from "../../../src/services/noteNameRules.js";
import {
  VAULT_FILE_CREATE_PROFILES, assertNewVaultFileName, validateVaultFileCreateContent, vaultFileCreateHash, vaultFileCreatePath,
  type VaultFileCreateApply, type VaultFileCreateKind,
} from "../../../src/services/vaultFileCreateContract.js";
import { ExclusiveNoteCreateFiles, NoteCreateExists } from "./exclusiveNoteCreate.js";
import { EffectFenceRefused, parseEffectFenceToken, type EffectFenceToken } from "./effectFence.js";

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

function body(value: unknown, expected: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_create_request");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join("\0") !== expected.sort().join("\0") || result.contractVersion !== 1) throw new Error("invalid_create_request");
  return result;
}
const plainObject = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Bridge-side shape check before the effect. The MCP seals a stricter format
 * validation at plan time; this guard keeps a direct caller from publishing a
 * file Obsidian itself cannot parse.
 */
export function vaultFileContentParses(kind: VaultFileCreateKind, content: string, parseYaml: (text: string) => unknown): boolean {
  try {
    if (kind === "base") return plainObject(parseYaml(content));
    const value = JSON.parse(content) as Record<string, unknown>;
    return plainObject(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);
  } catch { return false; }
}

/**
 * Absent-only creation of one `.base` or `.canvas` file. Same effect as the
 * Markdown note creation (exclusive create + fsync, never overwrite, existing
 * parent only), without date policy: no automatic field is excused.
 */
export function createVaultFileCreateRoutes(app: App, options: {
  kind: VaultFileCreateKind; binding: () => string; enabled: () => boolean;
  parseYaml: (text: string) => unknown;
  /** Effect fence admission; throws when the attempt must produce no effect. */
  enterEffect?: (fence: EffectFenceToken | undefined) => () => void;
}) {
  const root = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
  if (!root) return undefined;
  const profile = VAULT_FILE_CREATE_PROFILES[options.kind];
  const prefix = `/extensions/obsidian-atomic-write-bridge/${profile.route}`;
  const validPath = (value: unknown) => vaultFileCreatePath(options.kind, value);
  const files = new ExclusiveNoteCreateFiles(root, validPath);
  const bindingFingerprint = vaultFileCreateHash(options.binding() + `\0${profile.bindingDomain}\0` + realpathSync(root));
  function preflight(path: string) {
    assertNewVaultFileName(options.kind, path);
    if (!options.enabled()) throw new Error("file_creates_disabled");
    if (files.hasFoldedSibling(path)) throw new NoteNameError({ reasonCode: "note_name_case_collision", hint: noteNameFixedHint("note_name_case_collision") });
    if (app.vault.getAbstractFileByPath(path) || files.inspect(path).exists) throw new NoteCreateExists();
    return { contractVersion: 1 as const, kind: options.kind, path, bindingFingerprint, absent: true as const, enabled: true as const };
  }
  function inspect(path: string) {
    return { contractVersion: 1 as const, kind: options.kind, path, bindingFingerprint, ...files.inspect(path) };
  }
  function apply(request: VaultFileCreateApply & { fence?: EffectFenceToken }) {
    const common = { contractVersion: 1 as const, kind: options.kind, operationId: request.operationId, path: request.path,
      bindingFingerprint: request.bindingFingerprint, contentSha256: request.contentSha256 };
    let dispatched = false;
    let settleEffect: (() => void) | undefined;
    try {
      const current = preflight(request.path);
      validateVaultFileCreateContent(request.content);
      if (current.bindingFingerprint !== request.bindingFingerprint || vaultFileCreateHash(request.content) !== request.contentSha256 ||
          !vaultFileContentParses(options.kind, request.content, options.parseYaml)) throw new Error("create_precondition_changed");
      // Only effect point; the fence decides in the same synchronous block as the exclusive create.
      settleEffect = options.enterEffect?.(request.fence);
      dispatched = true;
      const result = files.create(request.path, request.content);
      return { ...common, outcome: "created" as const, reason: "exclusive_create_fsynced", contentSha256: result.sha256 };
    } catch (error) {
      if (!dispatched && error instanceof EffectFenceRefused) return { ...common, outcome: "conflict" as const, reason: "create_fence_refused" };
      const known = !dispatched || error instanceof NoteCreateExists;
      return { ...common, outcome: known ? "conflict" as const : "outcome_unknown" as const,
        reason: known ? "create_precondition_failed" : "create_effect_uncertain" };
    } finally {
      settleEffect?.();
    }
  }
  function mount(api: { addRoute: (route: string) => { post: (handler: (req: any, res: any) => void) => unknown } }) {
    const install = (suffix: string, handler: (value: unknown) => unknown) => api.addRoute(prefix + suffix).post((req, res) => {
      try { res.status(200).json(handler(req?.body)); }
      catch (error) {
        const known = error instanceof Error ? error.message : "";
        const reasonCode = error instanceof NoteNameError ? error.violation.reasonCode
          : error instanceof NoteCreateExists ? "file_create_target_exists"
          : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "file_create_parent_missing"
          : known === "file_creates_disabled" ? "file_create_disabled"
          : (known === "invalid_create_request" || known === "invalid_note_path") ? "file_create_request_invalid" : "file_create_failed";
        const status = error instanceof NoteNameError ? 400 : reasonCode === "file_create_target_exists" ? 409
          : reasonCode === "file_create_parent_missing" ? 404
          : reasonCode === "file_create_disabled" ? 403 : reasonCode === "file_create_request_invalid" ? 400 : 500;
        res.status(status).json({ ok: false, contractVersion: 1, retryable: false,
          error: { code: "file_create_rejected", reasonCode, message: `The ${profile.label} creation request could not be admitted or observed.` } });
      }
    });
    install("/preflight", value => { const r = body(value, ["contractVersion", "path"]); return preflight(validPath(r.path)); });
    install("/inspect", value => { const r = body(value, ["contractVersion", "path"]); return inspect(validPath(r.path)); });
    install("/apply", value => {
      const keys = ["contractVersion", "operationId", "path", "content", "contentSha256", "bindingFingerprint"];
      const fenced = !!value && typeof value === "object" && (value as Record<string, unknown>).fence !== undefined;
      const r = body(value, fenced ? [...keys, "fence"] : keys);
      if (fenced) {
        try { r.fence = parseEffectFenceToken(r.fence); } catch { throw new Error("invalid_create_request"); }
      }
      if (typeof r.operationId !== "string" || !UUID.test(r.operationId) || typeof r.content !== "string" ||
          [r.contentSha256, r.bindingFingerprint].some(h => typeof h !== "string" || !HASH.test(h))) {
        throw new Error("invalid_create_request");
      }
      validPath(r.path);
      return apply(r as unknown as VaultFileCreateApply & { fence?: EffectFenceToken });
    });
  }
  return { mount, capabilities: () => ({ supported: true, enabled: options.enabled(), exclusiveCreate: true,
    kind: options.kind, bindingFingerprint, indexing: "eventual_vault_watcher" }) };
}
