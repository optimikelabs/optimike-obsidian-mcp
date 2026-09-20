import { realpathSync } from "node:fs";
import type { App } from "obsidian";
import { nativeNotePath } from "../../../src/services/nativeNoteMoveContract.js";
import { createPolicyDigest, noteCreateHash, validateNoteCreate, type NoteCreateApply } from "../../../src/services/noteCreateContract.js";
import { ExclusiveNoteCreateFiles, NoteCreateExists } from "./exclusiveNoteCreate.js";
import { noteCreateDatePolicy } from "./noteCreatePolicy.js";

const PREFIX = "/extensions/obsidian-atomic-write-bridge/note-create";
const HASH = /^[a-f0-9]{64}$/u;
function body(value: unknown, expected: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_create_request");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join("\0") !== expected.sort().join("\0") || result.contractVersion !== 1) throw new Error("invalid_create_request");
  return result;
}
export function createNoteCreateRoutes(app: App, options: { binding: () => string; enabled: () => boolean }) {
  const root = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
  if (!root) return undefined;
  const files = new ExclusiveNoteCreateFiles(root);
  const bindingFingerprint = noteCreateHash(options.binding() + "\0exclusive-note-create\0" + realpathSync(root));
  function preflight(path: string) {
    nativeNotePath(path);
    if (!options.enabled()) throw new Error("note_creates_disabled");
    const policy = noteCreateDatePolicy(app), policyDigest = createPolicyDigest(policy);
    if (app.vault.getAbstractFileByPath(path) || files.inspect(path).exists) throw new NoteCreateExists();
    return { contractVersion: 1 as const, path, bindingFingerprint, absent: true as const, enabled: true as const, policy, policyDigest };
  }
  function inspect(path: string) {
    nativeNotePath(path);
    return { contractVersion: 1, path, bindingFingerprint, policyDigest: createPolicyDigest(noteCreateDatePolicy(app)), ...files.inspect(path) };
  }
  function apply(request: NoteCreateApply) {
    const common = { contractVersion: 1, operationId: request.operationId, path: request.path,
      bindingFingerprint, policyDigest: request.policyDigest, contentSha256: request.contentSha256 };
    let dispatched = false;
    try {
      const current = preflight(request.path);
      validateNoteCreate(request.path, request.content, current.policy);
      if (current.bindingFingerprint !== request.bindingFingerprint || current.policyDigest !== request.policyDigest ||
          noteCreateHash(request.content) !== request.contentSha256) throw new Error("create_precondition_changed");
      // This is the only effect point. O_EXCL, not a read-then-overwriting REST PUT, fences collisions.
      dispatched = true;
      const result = files.create(request.path, request.content);
      return { ...common, outcome: "created", reason: "exclusive_create_fsynced", contentSha256: result.sha256 };
    } catch (error) {
      return { ...common, outcome: !dispatched || error instanceof NoteCreateExists ? "conflict" : "outcome_unknown",
        reason: !dispatched || error instanceof NoteCreateExists ? "create_precondition_failed" : "create_effect_uncertain" };
    }
  }
  function mount(api: { addRoute: (route: string) => { post: (handler: (req: any, res: any) => void) => unknown } }) {
    const install = (suffix: string, handler: (value: unknown) => unknown) => api.addRoute(PREFIX + suffix).post((req, res) => {
      try { res.status(200).json(handler(req?.body)); }
      catch { res.status(400).json({ ok: false, contractVersion: 1, retryable: false,
        error: { code: "note_create_rejected", reasonCode: "request_or_precondition_rejected", message: "The note creation request could not be admitted or observed." } }); }
    });
    install("/preflight", value => { const r = body(value, ["contractVersion", "path"]); return preflight(nativeNotePath(r.path)); });
    install("/inspect", value => { const r = body(value, ["contractVersion", "path"]); return inspect(nativeNotePath(r.path)); });
    install("/apply", value => {
      const r = body(value, ["contractVersion", "operationId", "path", "content", "contentSha256", "bindingFingerprint", "policyDigest"]);
      if (typeof r.operationId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(r.operationId) ||
          typeof r.content !== "string" || [r.contentSha256, r.bindingFingerprint, r.policyDigest].some(h => typeof h !== "string" || !HASH.test(h))) {
        throw new Error("invalid_create_request");
      }
      nativeNotePath(r.path);
      return apply(r as unknown as NoteCreateApply);
    });
  }
  return { mount, capabilities: () => ({ supported: true, enabled: options.enabled(), exclusiveCreate: true,
    indexing: "eventual_vault_watcher", automaticDatePolicy: "qualified_fields_only" }) };
}
