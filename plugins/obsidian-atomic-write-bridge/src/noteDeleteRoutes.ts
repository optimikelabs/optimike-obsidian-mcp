import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { TFile, type App, type EventRef } from "obsidian";
import { MAX_NOTE_BYTES, sha256 } from "./contract.js";
import {
  NOTE_DELETE_MAX_BACKLINKS, sealNoteDelete,
  type NoteDeleteApply, type NoteDeleteBacklink, type NoteDeletePreflight, type NoteDeleteTrashOption,
} from "../../../src/services/noteDeleteContract.js";
import { nativeNotePath } from "../../../src/services/nativeNoteMoveContract.js";
import { parseEffectFenceToken, type EffectFenceToken } from "./effectFence.js";
import { NoteDeleteBeforeEffectConflict, NoteDeleteService, type NoteDeleteHost } from "./noteDelete.js";

const PREFIX = "/extensions/obsidian-atomic-write-bridge/note-delete";
const TRASH_DIRECTORY = ".trash";
const MAX_TRASH_CANDIDATES = 200;
const SAFE_REASONS = new Set([
  "invalid_delete_request", "invalid_note_path", "note_delete_disabled", "trash_preference_permanent",
  "trash_preference_unavailable", "note_has_backlinks", "delete_backlink_limit", "metadata_snapshot_unavailable",
  "physical_path_unsupported", "note_not_found", "delete_operation_identity_conflict", "invalid_delete_snapshot",
]);
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_delete_request");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== keys.sort().join("\0") || record.contractVersion !== 1) {
    throw new Error("invalid_delete_request");
  }
  return record;
}

/** `Vault.getConfig("trashOption")`: "system", "local" (the vault's .trash folder) or "none" (permanent). Never assume it. */
export function readTrashOption(vault: unknown): NoteDeleteTrashOption | "permanent" | null {
  try {
    if (!vault || typeof vault !== "object") return null;
    const getConfig = Reflect.get(vault, "getConfig");
    if (typeof getConfig !== "function") return null;
    const value = Reflect.apply(getConfig, vault, ["trashOption"]);
    return value === "system" || value === "local" ? value : value === "none" ? "permanent" : null;
  } catch { return null; }
}

export function createNoteDeleteRoutes(
  app: App,
  options: {
    binding: () => string; enabled: () => boolean; registerEvent: (event: EventRef) => void;
    /** Effect fence admission; throws when the attempt must produce no effect. */
    enterEffect?: (fence: EffectFenceToken | undefined) => () => void;
  },
) {
  const adapter = app.vault.adapter as {
    getBasePath?: () => string;
    exists?: (path: string) => Promise<boolean>;
    list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
    read?: (path: string) => Promise<string>;
  };
  const configuredRoot = adapter.getBasePath?.();
  if (!configuredRoot || !app.metadataCache?.on || typeof adapter.exists !== "function" ||
      typeof adapter.list !== "function" || typeof adapter.read !== "function") return undefined;
  const physicalRoot = realpathSync(configuredRoot);
  const binding = sha256(options.binding() + "\0note-delete\0" + physicalRoot);
  let resolved = 0;
  options.registerEvent(app.metadataCache.on("resolved", () => { resolved++; }));

  function physical(logical: string): void {
    nativeNotePath(logical);
    if (realpathSync(configuredRoot!) !== physicalRoot) throw new Error("physical_path_unsupported");
    let current = physicalRoot;
    const parts = logical.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = lstatSync(current); } catch { throw new Error("physical_path_unsupported"); }
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) ||
          (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))) {
        throw new Error("physical_path_unsupported");
      }
    }
  }
  function file(logical: string): TFile {
    nativeNotePath(logical);
    const entry = app.vault.getAbstractFileByPath(logical);
    if (entry === null) throw new Error("note_not_found");
    if (!(entry instanceof TFile) || entry.path !== logical) throw new Error("metadata_snapshot_unavailable");
    physical(logical);
    return entry;
  }
  async function observe(logical: string) {
    const entry = file(logical);
    const beforeMtime = entry.stat.mtime;
    const beforeResolved = resolved;
    const content = await app.vault.read(entry);
    const byteLength = Buffer.byteLength(content, "utf8");
    const metadata = app.metadataCache;
    if (byteLength > MAX_NOTE_BYTES || entry.path !== logical || entry.stat.mtime !== beforeMtime ||
        !metadata.getFileCache(entry)) throw new Error("metadata_snapshot_unavailable");
    const backlinks: NoteDeleteBacklink[] = [];
    for (const [sourcePath, targets] of Object.entries(metadata.resolvedLinks)) {
      const count = targets[logical];
      if (sourcePath !== logical && typeof count === "number" && count > 0) backlinks.push({ sourcePath, count });
    }
    if (backlinks.length > NOTE_DELETE_MAX_BACKLINKS) throw new Error("delete_backlink_limit");
    // A resolution pass in the middle of the read would make the link snapshot unreliable.
    if (resolved !== beforeResolved) throw new Error("metadata_snapshot_unavailable");
    return { sha256: sha256(content), byteLength, backlinks };
  }
  const host: NoteDeleteHost = {
    binding: () => binding,
    enabled: options.enabled,
    trashOption: () => readTrashOption(app.vault),
    observe,
    absent: async (logical) =>
      app.vault.getAbstractFileByPath(logical) === null && !(await adapter.exists!(logical)),
    trashCopies: async (logical, hash) => {
      const base = logical.slice(logical.lastIndexOf("/") + 1);
      const stem = base.replace(/\.md$/iu, "");
      if (!(await adapter.exists!(TRASH_DIRECTORY))) return [];
      const names = (await adapter.list!(TRASH_DIRECTORY)).files
        .filter((name) => { const leaf = name.slice(name.lastIndexOf("/") + 1); return /\.md$/iu.test(leaf) && leaf.startsWith(stem); })
        .slice(0, MAX_TRASH_CANDIDATES);
      const matches: string[] = [];
      for (const name of names) {
        try { if (sha256(await adapter.read!(name)) === hash) matches.push(name); } catch { /* unreadable candidates never match */ }
      }
      return matches;
    },
    trash: async (plan: NoteDeletePreflight, fence) => {
      let fresh;
      try {
        fresh = await observe(plan.path);
        const checked = sealNoteDelete({
          bindingFingerprint: plan.bindingFingerprint, path: plan.path, trashOption: plan.trashOption,
          acknowledgeBacklinks: plan.acknowledgeBacklinks, ...fresh,
        });
        if (checked.preconditionDigest !== plan.preconditionDigest) throw new NoteDeleteBeforeEffectConflict();
      } catch { throw new NoteDeleteBeforeEffectConflict(); }
      const target = file(plan.path);
      if (!host.enabled() || host.trashOption() !== plan.trashOption) throw new NoteDeleteBeforeEffectConflict();
      physical(plan.path);
      // Effect point: the fence admits the attempt in the same tick that starts trashFile.
      let settleEffect: (() => void) | undefined;
      try { settleEffect = options.enterEffect?.(fence); }
      catch { throw new NoteDeleteBeforeEffectConflict(); }
      // FileManager.trashFile follows the vault's "Deleted files" preference; it is not an atomic content CAS.
      try { await app.fileManager.trashFile(target); }
      finally { settleEffect?.(); }
      if (app.vault.getAbstractFileByPath(plan.path) !== null) throw new Error("native_trash_result_unproven");
    },
  };
  const service = new NoteDeleteService(host);
  function mount(api: { addRoute: (route: string) => { post: (handler: (req: any, res: any) => Promise<void>) => unknown } }) {
    const install = (suffix: string, handler: (value: unknown) => Promise<unknown>) => {
      api.addRoute(PREFIX + suffix).post(async (req, res) => {
        try { res.status(200).json(await handler(req?.body)); }
        catch (error) {
          const message = error instanceof Error ? error.message : "";
          res.status(400).json({ ok: false, contractVersion: 1, retryable: false,
            error: { code: "note_delete_rejected", reasonCode: SAFE_REASONS.has(message) ? message : "note_delete_failed",
              message: "The note deletion request could not be admitted or observed." } });
        }
      });
    };
    install("/preflight", async (value) => {
      const r = body(value, ["contractVersion", "path", "acknowledgeBacklinks"]);
      if (typeof r.acknowledgeBacklinks !== "boolean") throw new Error("invalid_delete_request");
      return service.preflight(nativeNotePath(r.path), r.acknowledgeBacklinks);
    });
    install("/apply", async (value) => {
      const keys = ["contractVersion", "operationId", "path", "bindingFingerprint", "preconditionDigest"];
      const fenced = !!value && typeof value === "object" && (value as Record<string, unknown>).fence !== undefined;
      const r = body(value, fenced ? [...keys, "fence"] : keys);
      if (fenced) {
        try { r.fence = parseEffectFenceToken(r.fence); } catch { throw new Error("invalid_delete_request"); }
      }
      return service.apply(r as unknown as NoteDeleteApply);
    });
    install("/status", async (value) => {
      const r = body(value, ["contractVersion", "operationId", "preconditionDigest"]);
      if (typeof r.operationId !== "string" || !/^[a-f0-9-]{36}$/u.test(r.operationId) ||
          typeof r.preconditionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(r.preconditionDigest)) throw new Error("invalid_delete_request");
      return service.status(r.operationId, r.preconditionDigest);
    });
  }
  const preference = () => readTrashOption(app.vault);
  return { mount, capabilities: () => ({ supported: true, enabled: host.enabled(),
    trashPreference: preference() ?? "unknown", bindingFingerprint: binding,
    persistentBackendReceipts: false, permanentDeletion: false }) };
}
