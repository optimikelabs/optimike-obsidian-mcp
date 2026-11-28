import { randomUUID } from "node:crypto";
import path from "node:path";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { NATIVE_MOVE_PREFIX, nativeDigest } from "../nativeNoteMoveContract.js";
import { NOTE_DELETE_PREFIX } from "../noteDeleteContract.js";
import { assertNewNotePath } from "../noteNameMcp.js";
import { assertWriteAllowed } from "../writePolicy.js";
import type { VaultCacheService } from "../obsidianRestAPI/vaultCache/service.js";
import { extractMarkdownLinkReferences } from "../obsidianRestAPI/vaultCache/markdownLinkReferences.js";
import { MarkdownLinkResolver } from "../obsidianRestAPI/vaultCache/markdownLinkResolver.js";
import { HeadlessOperationJournal, type HeadlessRow } from "./headlessOperationJournal.js";
import {
  applyLinkEdits, rewriteIncoming,
} from "./headlessMoveLinks.js";
import {
  HeadlessVaultFiles, filesystemConflict, foldedPath, readVaultAppSettings, safeRelativePath, vaultBinding,
} from "./headlessVaultFiles.js";

const PREVIEW_LIMIT = 12;
const BACKLINK_LIMIT = 200;
const PREFIX = { move: NATIVE_MOVE_PREFIX, delete: NOTE_DELETE_PREFIX };
type Intent = { kind: "move"; source: string; destination: string } |
  { kind: "delete"; source: string; acknowledged: boolean };
type Rewrite = NonNullable<ReturnType<typeof rewriteIncoming>> & { path: string; beforeHash: string };
type Snapshot = {
  intent: Intent; destination: string; beforeHash: string; identity: string; size: number;
  settings: ReturnType<typeof readVaultAppSettings>; rewrites: Rewrite[];
  backlinks: Array<{ sourcePath: string; count: number }>;
};

export class HeadlessNoteOperations {
  constructor(private readonly root: string, private readonly journalPath: string, private readonly cache: VaultCacheService) {}

  private bound() {
    const binding = vaultBinding(this.root);
    return {
      files: new HeadlessVaultFiles(binding.canonical),
      journal: new HeadlessOperationJournal<Snapshot>(this.journalPath, binding.fingerprint),
      fingerprint: binding.fingerprint,
    };
  }

  private authorize(kind: Intent["kind"], phase: "plan" | "apply", source: string) {
    assertWriteAllowed({ operation: `obsidian_note_${kind}_${phase}`, action: phase,
      target: source, targetType: "filePath", destructive: true });
  }

  private async capture(intent: Intent, files: HeadlessVaultFiles): Promise<Snapshot> {
    const settings = readVaultAppSettings(files.root);
    const inventory = await this.cache.readFilesystemMoveInventory(intent.source);
    const source = "/" + intent.source;
    if (!inventory.paths.includes(source) || !this.cache.allowsHeadlessOperationSource(intent.source)) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "The source is outside the filesystem link inventory.");
    }
    const original = files.state(intent.source, { readBytes: settings.updateLinks && intent.kind === "move" &&
      inventory.sources.includes(source) });
    if (!original) throw new McpError(BaseErrorCode.NOT_FOUND, "Source file unavailable.");
    const before = MarkdownLinkResolver.fromPaths(inventory.paths);
    const isTrash = (value: string) => foldedPath(value).startsWith(foldedPath(settings.trashFolder) + "/");
    if (isTrash(intent.source)) filesystemConflict("The source is already in the vault trash.");
    const destination = intent.kind === "move" ? intent.destination : this.trashDestination(intent.source, files, settings.trashFolder);
    if (intent.kind === "move" && (isTrash(destination) || !this.cache.allowsHeadlessOperationSource(destination))) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The destination is outside the filesystem link inventory.");
    }
    if (files.state(destination, { allowMissingParents: intent.kind === "delete" })) filesystemConflict("The destination already exists.");
    const after = MarkdownLinkResolver.fromPaths(inventory.paths.filter(item => item !== source).concat("/" + destination));
    const snapshot: Snapshot = { intent, destination, beforeHash: original.hash, identity: original.identity,
      size: original.size, settings, rewrites: [], backlinks: [] };
    for (const indexedPath of inventory.sources) {
      if ((intent.kind === "move" && !settings.updateLinks) || (intent.kind === "delete" && indexedPath === source)) continue;
      const note = indexedPath.slice(1);
      const state = note === intent.source ? original : files.state(note, { readBytes: true });
      if (!state?.bytes) filesystemConflict("An indexed backlink source disappeared.");
      const content = state.bytes.toString("utf8");
      if (intent.kind === "delete") {
        const count = extractMarkdownLinkReferences(content).filter(ref => before.resolve(indexedPath, ref.linkPath)?.path === source).length;
        if (count) snapshot.backlinks.push({ sourcePath: note, count });
      } else if (settings.updateLinks) {
        const rewrite = rewriteIncoming(content, indexedPath, source, "/" + destination, before, after, settings);
        if (!rewrite) continue;
        if (!Buffer.from(content).equals(state.bytes)) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "A backlink source is not valid UTF-8.");
        }
        snapshot.rewrites.push({ path: note, beforeHash: state.hash, ...rewrite });
      }
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The operation exceeds the sealed plan size limit.");
    }
    return snapshot;
  }

  private trashDestination(source: string, files: HeadlessVaultFiles, folder: string): string {
    const { dir, name, ext } = path.posix.parse(source);
    for (let suffix = 0; suffix <= 1000; suffix++) {
      const candidate = path.posix.join(folder, dir, name + (suffix ? `.${suffix}` : "") + ext);
      try {
        if (!files.state(candidate, { allowMissingParents: true })) return candidate;
      } catch (error) {
        if (!(error instanceof McpError && error.code === BaseErrorCode.CONFLICT &&
            error.message === "The vault path has a case or Unicode collision.")) throw error;
      }
    }
    return filesystemConflict("No collision-free trash destination is available.");
  }

  async planMove(input: { sourcePath: string; destinationPath: string; idempotencyKey: string }) {
    const source = safeRelativePath(input.sourcePath);
    const destination = safeRelativePath(input.destinationPath);
    assertNewNotePath(destination, { extensions: null });
    if (foldedPath(source) === foldedPath(destination) ||
        path.posix.extname(source).toLowerCase() !== path.posix.extname(destination).toLowerCase()) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Choose a different destination with the same extension.");
    }
    return this.plan({ kind: "move", source, destination }, input.idempotencyKey);
  }

  async planDelete(input: { path: string; acknowledgeBacklinks?: boolean; idempotencyKey: string }) {
    const source = safeRelativePath(input.path);
    if (!source.toLowerCase().endsWith(".md")) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Deletion requires a Markdown note.");
    }
    return this.plan({ kind: "delete", source, acknowledged: input.acknowledgeBacklinks === true }, input.idempotencyKey);
  }

  private async plan(intent: Intent, key: string) {
    this.authorize(intent.kind, "plan", intent.source);
    const { files, journal } = this.bound();
    const internalKey = this.key(intent.kind, key);
    const replay = (existing: HeadlessRow<Snapshot>) => {
      if (nativeDigest(intent) !== nativeDigest(existing.payload.intent)) filesystemConflict("The idempotency key names another request.");
      return this.receipt(existing);
    };
    const existing = journal.transaction(tx => tx.read(internalKey, true));
    if (existing) return replay(existing);
    const payload = await this.capture(intent, files);
    return journal.transaction(tx => {
      const winner = tx.read(internalKey, true);
      if (winner) return replay(winner);
      const now = new Date().toISOString();
      const refused = intent.kind === "delete" && payload.backlinks.length > 0 && !intent.acknowledged;
      return this.receipt(tx.insert({ id: randomUUID(), key: internalKey, phase: refused ? "rejected" : "planned",
        payload, createdAt: now, updatedAt: now }));
    });
  }

  private key(kind: Intent["kind"], key: string) {
    return nativeDigest([kind, key]);
  }

  private get(kind: Intent["kind"], ref: string, journal: HeadlessOperationJournal<Snapshot>, key?: string) {
    const id = ref.slice(PREFIX[kind].length);
    if (!ref.startsWith(PREFIX[kind]) || !/^[a-f0-9-]{36}$/u.test(id)) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Invalid plan reference.");
    }
    const row = journal.transaction(tx => tx.read(id));
    if (!row || row.payload.intent.kind !== kind) throw new McpError(BaseErrorCode.NOT_FOUND, "Plan unavailable.");
    if (key !== undefined && row.key !== this.key(kind, key)) filesystemConflict("The idempotency key does not match.");
    return row;
  }

  async apply(kind: Intent["kind"], ref: string, key: string) {
    const { files, journal, fingerprint } = this.bound();
    const row = this.get(kind, ref, journal, key);
    if (row.phase !== "planned") return this.status(kind, ref);
    this.authorize(kind, "apply", row.payload.intent.source);
    const revision = journal.transaction(tx => tx.revision());
    let fresh: Snapshot | undefined;
    try { fresh = await this.capture(row.payload.intent, files); }
    catch (error) {
      if (!(error instanceof McpError && [BaseErrorCode.NOT_FOUND, BaseErrorCode.CONFLICT, BaseErrorCode.VALIDATION_ERROR].includes(error.code))) throw error;
    }
    if (this.bound().fingerprint !== fingerprint) filesystemConflict("The configured vault changed.");
    const claimed = journal.transaction(tx => {
      const current = tx.read(row.id)!;
      if (current.phase !== "planned") return { row: current, run: false };
      if (tx.revision() !== revision) filesystemConflict("The vault graph changed during validation. Recheck the same plan.");
      if (!fresh || nativeDigest(fresh) !== nativeDigest(current.payload) || !this.allBefore(files, current.payload)) {
        return { row: tx.settle(current, "conflict"), run: false };
      }
      return { row: tx.claim(current, this.paths(current.payload)), run: true };
    });
    if (!claimed.run) return this.receipt(claimed.row);
    return this.execute(files, journal, row.id);
  }

  async status(kind: Intent["kind"], ref: string) {
    const { files, journal } = this.bound();
    const row = this.get(kind, ref, journal);
    const reconciled = journal.transaction(tx => {
      const current = tx.read(row.id)!;
      return current.phase === "applying" && this.observe(files, current.payload).complete
        ? tx.settle(current, "committed") : current;
    });
    return this.withCache(reconciled);
  }

  async recover(kind: Intent["kind"], ref: string, key: string) {
    const { files, journal, fingerprint } = this.bound();
    const row = this.get(kind, ref, journal, key);
    if (row.phase !== "applying") return this.withCache(row);
    this.authorize(kind, "apply", row.payload.intent.source);
    if (!this.observe(files, row.payload).safe) {
      filesystemConflict("A sealed path changed after dispatch. Restore the recorded files before retrying recovery.");
    }
    // If the crash preceded all effects, validate the graph again before resuming.
    if (this.allBefore(files, row.payload)) {
      const fresh = await this.capture(row.payload.intent, files);
      if (this.bound().fingerprint !== fingerprint || nativeDigest(fresh) !== nativeDigest(row.payload)) {
        filesystemConflict("The pending plan's preconditions changed.");
      }
    }
    return this.execute(files, journal, row.id);
  }

  private paths(plan: Snapshot) {
    return [plan.intent.source, plan.destination, ...plan.rewrites.map(item => item.path)];
  }

  private allBefore(files: HeadlessVaultFiles, plan: Snapshot) {
    const source = files.state(plan.intent.source);
    return source?.hash === plan.beforeHash && source.identity === plan.identity &&
      !files.state(plan.destination, { allowMissingParents: plan.intent.kind === "delete" }) &&
      plan.rewrites.every(item => files.state(item.path)?.hash === item.beforeHash);
  }

  private observe(files: HeadlessVaultFiles, plan: Snapshot) {
    const source = files.state(plan.intent.source);
    const target = files.state(plan.destination, { allowMissingParents: plan.intent.kind === "delete" });
    const validSource = source?.identity === plan.identity && source.hash === plan.beforeHash;
    const movedRewrite = plan.rewrites.find(item => item.path === plan.intent.source);
    const publishedOriginal = target?.identity === plan.identity && target.hash === plan.beforeHash;
    const moved = !source && (publishedOriginal || (!!movedRewrite && target?.hash === movedRewrite.afterHash));
    if (!(validSource && (!target || publishedOriginal) || moved)) return { safe: false, complete: false };
    let complete = !!moved;
    for (const rewrite of plan.rewrites) {
      const current = files.state(rewrite.path === plan.intent.source && moved ? plan.destination : rewrite.path);
      if (current?.hash === rewrite.afterHash) continue;
      if (current?.hash !== rewrite.beforeHash) return { safe: false, complete: false };
      complete = false;
    }
    return { safe: true, complete };
  }

  private async execute(files: HeadlessVaultFiles, journal: HeadlessOperationJournal<Snapshot>, id: string) {
    const row = journal.transaction(tx => {
      const current = tx.read(id)!;
      if (current.phase !== "applying") return current;
      const plan = current.payload;
      try {
        const observed = this.observe(files, plan);
        if (!observed.safe) return current;
        if (!observed.complete) {
          if (files.state(plan.intent.source)) {
            if (plan.intent.kind === "delete") files.createTrashParents(plan.destination);
            files.relocate(plan.intent.source, plan.destination, plan.beforeHash, plan.identity);
          }
          for (const rewrite of plan.rewrites) {
            const target = rewrite.path === plan.intent.source ? plan.destination : rewrite.path;
            const state = files.state(target, { readBytes: true });
            if (state?.hash === rewrite.afterHash) continue;
            if (!state?.bytes || state.hash !== rewrite.beforeHash) return current;
            files.replace(target, rewrite.beforeHash, Buffer.from(applyLinkEdits(state.bytes.toString("utf8"), rewrite.edits)));
          }
        }
        if (!this.observe(files, plan).complete) return current;
      } catch {
        // A failed filesystem call may have published an effect. Keep the
        // durable reservation until status or exact-plan recovery can prove it.
        return current;
      }
      return tx.settle(current, "committed");
    });
    return this.withCache(row);
  }

  private async withCache(row: HeadlessRow<Snapshot>) {
    if (row.phase !== "committed" && row.phase !== "applying") return this.receipt(row);
    try {
      await this.cache.readFilesystemMoveInventory(row.payload.intent.source);
      return { ...this.receipt(row), cache: "refreshed" };
    } catch {
      return { ...this.receipt(row), cache: "unavailable" };
    }
  }

  private receipt(row: HeadlessRow<Snapshot>) {
    const { intent, destination, beforeHash, size, settings, rewrites, backlinks } = row.payload;
    const digest = nativeDigest(row.payload);
    const pending = row.phase === "applying";
    const committed = row.phase === "committed";
    const affectedPaths = [...new Set(this.paths(row.payload))];
    const common = {
      contractVersion: 1, operationKind: `obsidian.note.${intent.kind}`, operationId: row.id,
      planRef: PREFIX[intent.kind] + row.id, planDigest: digest, affectedPaths,
      phase: row.phase === "planned" ? "planned" : "terminal",
      outcome: row.phase === "planned" ? null : pending ? "outcome_unknown" : row.phase,
      ...(row.phase === "conflict" ? { reasonCode: BaseErrorCode.CONFLICT } : {}),
      applyAllowed: row.phase === "planned", recoveryAllowed: pending,
      nextAction: row.phase === "planned" ? "apply" : pending ? "recover" : "none",
      admittedAt: row.createdAt, updatedAt: row.updatedAt,
    };
    if (intent.kind === "move") {
      return { ...common, target: { sourcePath: intent.source, destinationPath: destination },
        beforeProof: { sourceSha256: beforeHash, neighborhoodDigest: digest },
        expectedGraphDigest: nativeDigest(rewrites.map(rewrite => [rewrite.path, rewrite.afterHash])),
        graph_postflight: committed && settings.updateLinks ? "verified" : "indeterminate",
        scope: "sealed_neighborhood_only", updateLinks: settings.updateLinks,
        preview: { noteCount: rewrites.length, rewriteCount: rewrites.reduce((sum, item) => sum + item.count, 0),
          truncated: rewrites.length > PREVIEW_LIMIT,
          notes: rewrites.slice(0, PREVIEW_LIMIT).map(item => ({ path: item.path, ...item.sample })) },
        limitations: ["indexed_markdown_sources_only", "external_writers_do_not_share_locks"],
      };
    }
    return { ...common, target: { path: intent.source },
      beforeProof: { sha256: beforeHash, byteLength: size, preconditionDigest: digest },
      incomingLinks: { acknowledged: intent.acknowledged, sourceCount: backlinks.length,
        count: backlinks.reduce((total, item) => total + item.count, 0), sources: backlinks.slice(0, BACKLINK_LIMIT),
        truncated: backlinks.length > BACKLINK_LIMIT },
      trash: { preference: "local", destination: "vault_trash_folder", path: destination },
      postflight: { status: committed ? "verified" : "indeterminate",
        reason: row.phase === "rejected" ? "delete_note_has_backlinks" : null },
      limitations: ["indexed_markdown_sources_only", "external_writers_do_not_share_locks"],
    };
  }
}
