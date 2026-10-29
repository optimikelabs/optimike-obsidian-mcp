import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseLinktext, resolveSubpath, TFile, TFolder, type App, type EventRef } from "obsidian";
import { MAX_NOTE_BYTES, sha256 } from "./contract.js";
import { hasFoldedNameCollision } from "../../../src/services/noteNameRules.js";
import { projectNoteLinks } from "./noteLinks.js";
import {
  NATIVE_MOVE_MAX_REFERENCES, nativeNotePath, sealNativeMove,
  type NativeSemanticNote, type NativeMoveApply,
} from "../../../src/services/nativeNoteMoveContract.js";
import {
  NativeNoteMoveService, NativeMoveBeforeEffectConflict, linkCoverageRefusal, nativeMoveRefusal, type NativeMoveHost,
} from "./nativeNoteMove.js";
import { parseEffectFenceToken, type EffectFenceToken } from "./effectFence.js";

const PREFIX = "/extensions/obsidian-atomic-write-bridge/native-note-move";
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_native_request");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== keys.sort().join("\0") || record.contractVersion !== 1) {
    throw new Error("invalid_native_request");
  }
  return record;
}

/** The native preference currently has no public typed getter. Never assume its value. */
export function readNativeUpdateLinksPreference(vault: unknown): boolean | null {
  try {
    if (!vault || typeof vault !== "object") return null;
    const getConfig = Reflect.get(vault, "getConfig");
    if (typeof getConfig !== "function") return null;
    const value = Reflect.apply(getConfig, vault, ["alwaysUpdateLinks"]);
    return typeof value === "boolean" ? value : null;
  } catch { return null; }
}

export function createNativeNoteMoveRoutes(
  app: App,
  options: {
    binding: () => string; enabled: () => boolean; registerEvent: (event: EventRef) => void;
    /** Effect fence admission; throws when the attempt must produce no effect. */
    enterEffect?: (fence: EffectFenceToken | undefined) => () => void;
  },
) {
  const adapter = app.vault.adapter as { getBasePath?: () => string; exists?: (path: string) => Promise<boolean> };
  const configuredRoot = adapter.getBasePath?.();
  if (!configuredRoot || !app.metadataCache?.on || typeof adapter.exists !== "function") return undefined;
  const physicalRoot = realpathSync(configuredRoot);
  const binding = sha256(options.binding() + "\0native-note-move\0" + physicalRoot);
  const epoch = randomUUID();
  let resolved = 0;
  options.registerEvent(app.metadataCache.on("resolved", () => { resolved++; }));

  function physical(logical: string, absentLeaf = false): void {
    nativeNotePath(logical);
    if (realpathSync(configuredRoot!) !== physicalRoot) throw new Error("physical_path_unsupported");
    let current = physicalRoot;
    const parts = logical.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) {
        if (absentLeaf && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("physical_path_unsupported");
      }
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) ||
          (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))) {
        throw new Error("physical_path_unsupported");
      }
    }
  }
  /** A sibling differing only by case or Unicode form is the same file on Windows/macOS: the destination is not free. */
  function foldedSibling(logical: string): boolean {
    const parts = logical.split("/");
    try { return hasFoldedNameCollision(parts.at(-1)!, readdirSync(path.join(physicalRoot, ...parts.slice(0, -1)))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  function file(logical: string): TFile {
    nativeNotePath(logical);
    const entry = app.vault.getAbstractFileByPath(logical);
    if (!(entry instanceof TFile) || entry.path !== logical) throw new Error("metadata_snapshot_unavailable");
    physical(logical);
    return entry;
  }
  async function note(logical: string): Promise<NativeSemanticNote> {
    const entry = file(logical);
    const beforeMtime = entry.stat.mtime;
    const beforeResolved = resolved;
    const content = await app.vault.read(entry);
    if (Buffer.byteLength(content, "utf8") > MAX_NOTE_BYTES || entry.path !== logical || entry.stat.mtime !== beforeMtime) {
      throw new Error("metadata_snapshot_unavailable");
    }
    const metadata = app.metadataCache;
    const cache = metadata.getFileCache(entry);
    if (!cache) throw new Error("metadata_snapshot_unavailable");
    const links = projectNoteLinks({
      sourcePath: logical, cacheAvailable: true, links: cache.links ?? [], embeds: cache.embeds ?? [],
      frontmatterLinks: cache?.frontmatterLinks ?? [], resolvedLinks: metadata.resolvedLinks,
      unresolvedLinks: metadata.unresolvedLinks, limit: NATIVE_MOVE_MAX_REFERENCES,
      parseLinktext,
      resolveLink: (link, source) => metadata.getFirstLinkpathDest(link, source)?.path ?? null,
      validateSubpath: (targetPath, subpath) => {
        const target = app.vault.getAbstractFileByPath(targetPath);
        if (!(target instanceof TFile)) return { status: "unknown", reason: "target_file_unavailable" };
        const targetCache = metadata.getFileCache(target);
        if (!targetCache) return { status: "unknown", reason: "target_cache_unavailable" };
        const value = resolveSubpath(targetCache, subpath);
        return value ? { status: "valid", type: value.type } : { status: "invalid" };
      },
    });
    if (resolved !== beforeResolved) throw new Error("metadata_snapshot_unavailable");
    const refusal = linkCoverageRefusal(links.coverage);
    if (refusal) throw new Error(refusal);
    return { path: logical, sha256: sha256(content),
      references: links.outgoing.map((link) => ({ kind: link.kind,
        targetPath: link.resolution.status === "resolved" ? link.resolution.targetPath : null,
        unresolvedPath: link.resolution.status === "unresolved" ? link.linkPath : null,
        subpath: link.subpath,
        anchor: link.subpathValidation.status === "valid" ? "valid:" + link.subpathValidation.type : link.subpathValidation.status,
      })), backlinks: links.backlinks, unresolved: links.unresolved };
  }
  const host: NativeMoveHost = {
    binding: () => binding, enabled: options.enabled,
    preference: () => readNativeUpdateLinksPreference(app.vault),
    clock: () => ({ epoch, resolved }),
    absent: async (logical) => {
      physical(logical, true);
      return app.vault.getAbstractFileByPath(logical) === null && !(await adapter.exists!(logical)) && !foldedSibling(logical);
    },
    parentExists: (logical) => {
      const parent = logical.includes("/") ? logical.slice(0, logical.lastIndexOf("/")) : "";
      return parent === "" || app.vault.getAbstractFileByPath(parent) instanceof TFolder;
    },
    note,
    rename: async (plan, fence) => {
      const fresh: NativeSemanticNote[] = [];
      try {
        for (const item of plan.notes) fresh.push(await note(item.path));
        const checked = sealNativeMove({ ...plan, notes: fresh, updateLinks: host.preference() as boolean });
        if (checked.preconditionDigest !== plan.preconditionDigest || !(await host.absent(plan.destinationPath))) {
          throw new NativeMoveBeforeEffectConflict();
        }
      } catch { throw new NativeMoveBeforeEffectConflict(); }
      const source = file(plan.sourcePath);
      if (!host.enabled() || host.preference() !== plan.updateLinks || !host.parentExists(plan.destinationPath)) {
        throw new NativeMoveBeforeEffectConflict();
      }
      physical(plan.sourcePath); physical(plan.destinationPath, true);
      const barrier = host.clock();
      // Effect point: the fence admits the attempt in the same tick that starts renameFile.
      let settleEffect: (() => void) | undefined;
      try { settleEffect = options.enterEffect?.(fence); }
      catch { throw new NativeMoveBeforeEffectConflict(); }
      // This is a native rename, not an atomic source-content CAS or an OS-wide directory lock.
      try { await app.fileManager.renameFile(source, plan.destinationPath); }
      finally { settleEffect?.(); }
      if (source.path !== plan.destinationPath || app.vault.getAbstractFileByPath(plan.sourcePath) !== null) {
        throw new Error("native_move_result_unproven");
      }
      physical(plan.destinationPath);
      return { afterSha256: sha256(await app.vault.read(source)), barrier };
    },
  };
  const service = new NativeNoteMoveService(host);
  function mount(api: { addRoute: (route: string) => { post: (handler: (req: any, res: any) => Promise<void>) => unknown } }) {
    const install = (suffix: string, handler: (value: unknown) => Promise<unknown>) => {
      api.addRoute(PREFIX + suffix).post(async (req, res) => {
        try { res.status(200).json(await handler(req?.body)); }
        catch (error) { res.status(400).json(nativeMoveRefusal(error)); }
      });
    };
    install("/preflight", async (value) => {
      const r = body(value, ["contractVersion", "sourcePath", "destinationPath"]);
      return service.preflight(nativeNotePath(r.sourcePath), nativeNotePath(r.destinationPath));
    });
    install("/apply", async (value) => {
      const keys = ["contractVersion", "operationId", "sourcePath", "destinationPath", "bindingFingerprint", "preconditionDigest"];
      const fenced = !!value && typeof value === "object" && (value as Record<string, unknown>).fence !== undefined;
      const r = body(value, fenced ? [...keys, "fence"] : keys);
      if (fenced) {
        try { r.fence = parseEffectFenceToken(r.fence); } catch { throw new Error("invalid_native_request"); }
      }
      return service.apply(r as unknown as NativeMoveApply);
    });
    install("/status", async (value) => {
      const r = body(value, ["contractVersion", "operationId", "preconditionDigest"]);
      if (typeof r.operationId !== "string" || !/^[a-f0-9-]{36}$/u.test(r.operationId) ||
          typeof r.preconditionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(r.preconditionDigest)) throw new Error("invalid_native_request");
      return service.status(r.operationId, r.preconditionDigest);
    });
  }
  return { mount, capabilities: () => ({ supported: true, enabled: host.enabled(),
    preferenceReadable: host.preference() !== null, bindingFingerprint: binding,
    persistentBackendReceipts: false, graphScope: "sealed_neighborhood_only" }) };
}
