import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { NATIVE_MOVE_PREFIX, nativeDigest } from "../nativeNoteMoveContract.js";
import { NOTE_DELETE_PREFIX } from "../noteDeleteContract.js";
import { assertNewNotePath } from "../noteNameMcp.js";
import { assertWriteAllowed } from "../writePolicy.js";
import type { VaultCacheService } from "../obsidianRestAPI/vaultCache/service.js";
import { LARGE_LINK_SOURCE_BYTES } from "../obsidianRestAPI/vaultCache/boundedLinkReferences.js";
import { extractMarkdownLinkReferences } from "../obsidianRestAPI/vaultCache/markdownLinkReferences.js";
import { MarkdownLinkResolver } from "../obsidianRestAPI/vaultCache/markdownLinkResolver.js";
import { HeadlessOperationJournal, type HeadlessRow } from "./headlessOperationJournal.js";
import {
  applyLinkEdits, rewriteIncoming,
} from "./headlessMoveLinks.js";
import {
  HeadlessVaultFiles, filesystemConflict, foldedPath, readVaultAppSettings, safeRelativePath, startProbeCleanup, vaultBinding,
} from "./headlessVaultFiles.js";

const PREVIEW_LIMIT = 12;
const BACKLINK_LIMIT = 100;
const BACKLINK_INSPECTION_LIMIT = 1000;
type RecoveryAction = "resume" | "abandon";
const PREFIX = { move: NATIVE_MOVE_PREFIX, delete: NOTE_DELETE_PREFIX };
const WRITE_OPERATIONS = {
  move: { plan: "obsidian_note_move_plan", apply: "obsidian_note_move_apply" },
  delete: { plan: "obsidian_note_delete_plan", apply: "obsidian_note_delete_apply" },
} as const;
type Intent = { kind: "move"; source: string; destination: string } |
  { kind: "delete"; source: string; acknowledged: boolean };
type Rewrite = NonNullable<ReturnType<typeof rewriteIncoming>> & { path: string; beforeHash: string };
type Snapshot = {
  intent: Intent; destination: string; beforeHash: string; identity: string; size: number;
  settings: ReturnType<typeof readVaultAppSettings>; rewrites: Rewrite[];
  graphProofs?: Array<{ path: string; digest: string }>;
  backlinks: Array<{ sourcePath: string; count: number }>;
};

function graphProof(content: string, note: string, resolver: MarkdownLinkResolver): string {
  return nativeDigest(extractMarkdownLinkReferences(content).map(ref =>
    [resolver.resolve(note, ref.linkPath)?.path ?? null, ref.subpath, ref.kind]));
}

function inverseEdits(rewrite: Rewrite) {
  let shift = 0;
  return [...rewrite.edits].reverse().map(edit => {
    const start = edit.start + shift;
    shift += edit.after.length - (edit.end - edit.start);
    return { start, end: start + edit.after.length, before: rewrite.beforeText.slice(edit.start, edit.end) };
  }).reverse();
}

export class HeadlessNoteOperations {
  private readonly probeCleanup: Promise<void>;

  constructor(private readonly root: string, private readonly journalPath: string, private readonly cache: VaultCacheService) {
    this.probeCleanup = startProbeCleanup(root);
  }

  private bound() {
    const binding = vaultBinding(this.root);
    return {
      files: new HeadlessVaultFiles(binding.canonical),
      journal: new HeadlessOperationJournal<Snapshot>(this.journalPath, binding.fingerprint),
      fingerprint: binding.fingerprint,
    };
  }

  private authorize(kind: Intent["kind"], phase: "plan" | "apply", source: string) {
    assertWriteAllowed({ operation: WRITE_OPERATIONS[kind][phase], action: phase,
      target: source, targetType: "filePath", destructive: true });
  }

  private async capture(intent: Intent, files: HeadlessVaultFiles): Promise<Snapshot> {
    const settings = readVaultAppSettings(files.root);
    const inspectLinks = intent.kind === "delete" || settings.updateLinks;
    const inventory = await this.cache.readFilesystemMoveInventory(intent.source, intent.kind === "move" ? intent.destination : undefined,
      inspectLinks ? BACKLINK_INSPECTION_LIMIT : 0);
    if (inspectLinks && inventory.sources.length > BACKLINK_INSPECTION_LIMIT) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Too many candidate notes for bounded link inspection.",
        { reasonCode: "headless_backlink_inspection_limit" });
    }
    if (intent.kind === "delete" && settings.trashPreference !== "local") {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Select Obsidian's vault trash before planning headless deletion.",
        { reasonCode: "headless_trash_preference_unsupported" });
    }
    const source = "/" + intent.source;
    if (!inventory.paths.includes(source) || !this.cache.allowsHeadlessOperationSource(intent.source)) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "The source is outside the filesystem link inventory.");
    }
    const original = files.state(intent.source, { readBytes: settings.updateLinks && intent.kind === "move" &&
      intent.source.toLowerCase().endsWith(".md") });
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
      size: original.size, settings, rewrites: [], backlinks: [], graphProofs: [] };
    const scoped = new Set(inventory.sources);
    if (intent.kind === "move" && intent.source.toLowerCase().endsWith(".md")) scoped.add(source);
    for (const indexedPath of scoped) {
      if (!inspectLinks || (intent.kind === "delete" && indexedPath === source)) continue;
      await yieldToEventLoop();
      const note = indexedPath.slice(1);
      const state = note === intent.source ? original : files.state(note, { readBytes: true });
      if (!state?.bytes) filesystemConflict("An indexed backlink source disappeared.");
      if (state.size > LARGE_LINK_SOURCE_BYTES) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The operation requires complete backlink coverage.",
          { reasonCode: "headless_link_coverage_incomplete" });
      }
      const content = state.bytes.toString("utf8");
      if (intent.kind === "delete") {
        const count = extractMarkdownLinkReferences(content).filter(ref => before.resolve(indexedPath, ref.linkPath)?.path === source).length;
        if (count) snapshot.backlinks.push({ sourcePath: note, count });
      } else {
        const rewrite = rewriteIncoming(content, indexedPath, source, "/" + destination, before, after, settings);
        const next = rewrite ? applyLinkEdits(content, rewrite.edits) : content;
        const resultPath = indexedPath === source ? "/" + destination : indexedPath;
        snapshot.graphProofs!.push({ path: resultPath.slice(1), digest: graphProof(next, resultPath, after) });
        if (!rewrite) continue;
        if (!Buffer.from(content).equals(state.bytes)) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "A backlink source is not valid UTF-8.");
        }
        snapshot.rewrites.push({ path: note, beforeHash: state.hash, ...rewrite });
      }
      if (snapshot.rewrites.length > BACKLINK_LIMIT || snapshot.backlinks.length > BACKLINK_LIMIT) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Too many notes to rewrite or report as backlinks.",
          { reasonCode: "headless_backlink_limit" });
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
    await this.probeCleanup;
    const { files, journal } = this.bound();
    const internalKey = this.key(intent.kind, key);
    const replay = (existing: HeadlessRow<Snapshot>) => {
      if (nativeDigest(intent) !== nativeDigest(existing.payload.intent)) filesystemConflict("The idempotency key names another request.");
      return this.receipt(existing);
    };
    const existing = journal.transaction(tx => tx.read(internalKey, true));
    if (existing) return replay(existing);
    const payload = await this.capture(intent, files);
    files.probeHardLinks(intent.source, payload.destination, intent.kind === "delete");
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
    const prefix = PREFIX[kind];
    if (typeof ref !== "string" || !ref.startsWith(prefix) || !/^[a-f0-9-]{36}$/u.test(ref.slice(prefix.length))) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Invalid plan reference.",
        { reasonCode: "headless_plan_ref_invalid" });
    }
    const id = ref.slice(prefix.length);
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
    const revision = journal.transaction(tx => {
      tx.ensureVaultAvailable();
      return tx.revision();
    });
    let fresh: Snapshot | undefined;
    try { fresh = await this.capture(row.payload.intent, files); }
    catch (error) {
      if (!(error instanceof McpError && [BaseErrorCode.NOT_FOUND, BaseErrorCode.CONFLICT, BaseErrorCode.VALIDATION_ERROR].includes(error.code))) throw error;
    }
    if (this.bound().fingerprint !== fingerprint) filesystemConflict("The configured vault changed.");
    const eligible = fresh && nativeDigest(fresh) === nativeDigest(row.payload) && this.allBefore(files, row.payload);
    const claimed = journal.transaction(tx => {
      const current = tx.read(row.id)!;
      if (current.phase !== "planned") return { row: current, run: false };
      if (tx.revision() !== revision) filesystemConflict("The vault graph changed during validation. Recheck the same plan.");
      if (!eligible) {
        return { row: tx.settle(current, "conflict", "headless_plan_stale"), run: false };
      }
      return { row: tx.claim(current, this.paths(current.payload)), run: true };
    });
    if (!claimed.run) return this.receipt(claimed.row);
    return this.runPending(files, journal, claimed.row, "apply");
  }

  async status(kind: Intent["kind"], ref: string) {
    const { files, journal } = this.bound();
    const row = this.get(kind, ref, journal);
    if (row.phase === "applying") return this.runPending(files, journal, row, "status");
    return this.withCache(row, files, journal);
  }

  async recover(kind: Intent["kind"], ref: string, key: string, action: RecoveryAction = "resume") {
    const { files, journal } = this.bound();
    const row = this.get(kind, ref, journal, key);
    await files.cleanProbes();
    if (row.phase !== "applying") return this.withCache(row, files, journal);
    this.authorize(kind, "apply", row.payload.intent.source);
    return this.runPending(files, journal, row, action);
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

  private async runPending(files: HeadlessVaultFiles, journal: HeadlessOperationJournal<Snapshot>,
    row: HeadlessRow<Snapshot>, action: "apply" | "status" | RecoveryAction) {
    const token = randomUUID();
    const attempt = journal.transaction(tx =>
      tx.beginAttempt(row.id, token) ? { published: tx.published(row.id) } : undefined);
    if (!attempt) {
      const current = journal.transaction(tx => tx.read(row.id))!;
      return current.phase === "applying" ? this.receipt(current, false, false, "headless_operation_pending")
        : this.withCache(current, files, journal);
    }
    const plan = row.payload;
    let published = attempt.published;
    const noEffect = () => this.noEffect(files, plan, published);
    const settle = (phase: HeadlessRow<Snapshot>["phase"], reason?: string) =>
      journal.transaction(tx => tx.settle(row, phase, reason));
    try {
      let observed = this.tryObserve(files, plan);
      if (observed.complete) return await this.withCache(settle("committed"), files, journal);
      if (action === "abandon") {
        if (observed.safe) filesystemConflict("The sealed operation can still be recovered.", "headless_operation_pending");
        for (const item of plan.rewrites) {
          try { files.cleanStage(item.path === plan.intent.source ? plan.destination : item.path, row.id); }
          catch { /* Manual repair also covers inaccessible staging paths. */ }
        }
        return await this.withCache(settle("abandoned", "headless_manual_repair_required"), files, journal);
      }
      if (!observed.safe || action === "status") {
        if (noEffect()) {
          return this.receipt(settle("conflict", "headless_plan_stale"));
        }
        return this.receipt(row, false, observed.safe,
          observed.safe ? undefined : "headless_manual_repair_required");
      }
      if (action === "resume" && noEffect()) {
        try {
          const fresh = await this.capture(plan.intent, files);
          if (nativeDigest(fresh) !== nativeDigest(plan)) return this.receipt(settle("conflict", "headless_plan_stale"));
        } catch (error) {
          if (!(error instanceof McpError) || error.code === BaseErrorCode.SERVICE_UNAVAILABLE) throw error;
          return this.receipt(settle("conflict", "headless_plan_stale"));
        }
      }
      try {
        await yieldToEventLoop();
        if (files.state(plan.intent.source)) {
          if (plan.intent.kind === "delete") files.createTrashParents(plan.destination);
          files.relocate(plan.intent.source, plan.destination, plan.beforeHash, plan.identity, () => {
            journal.transaction(tx => tx.markPublished(row.id));
            published = true;
          });
        }
        for (const rewrite of plan.rewrites) {
          await yieldToEventLoop();
          const target = rewrite.path === plan.intent.source ? plan.destination : rewrite.path;
          files.cleanStage(target, row.id);
          const state = files.state(target, { readBytes: true });
          if (state?.hash === rewrite.afterHash) continue;
          if (!state?.bytes || state.hash !== rewrite.beforeHash) filesystemConflict("A rewritten file changed.");
          files.replace(target, rewrite.beforeHash, Buffer.from(applyLinkEdits(state.bytes.toString("utf8"), rewrite.edits)), row.id);
        }
      } catch (error) {
        if (noEffect()) {
          const reason = error instanceof McpError && error.details?.reasonCode === "hard_links_unsupported"
            ? "hard_links_unsupported" : "headless_plan_stale";
          return this.receipt(settle("conflict", reason));
        }
      }
      observed = this.tryObserve(files, plan);
      return observed.complete ? await this.withCache(settle("committed"), files, journal)
        : this.receipt(row, false, observed.safe, observed.safe ? undefined : "headless_manual_repair_required");
    } finally {
      journal.transaction(tx => tx.endAttempt(row.id, token));
    }
  }

  private noEffect(files: HeadlessVaultFiles, plan: Snapshot, published: boolean): boolean {
    if (published) return false;
    try {
      const source = files.state(plan.intent.source);
      // Before the durable publication mark, no replacement or removal
      // could have run. Legacy journal rows still require the original inode.
      return !!source && (!!plan.graphProofs || source.identity === plan.identity) &&
        !files.state(plan.destination, { allowMissingParents: plan.intent.kind === "delete" });
    } catch { return false; }
  }

  private tryObserve(files: HeadlessVaultFiles, plan: Snapshot) {
    try { return this.observe(files, plan); }
    catch { return { safe: false, complete: false }; }
  }

  private async withCache(row: HeadlessRow<Snapshot>, files: HeadlessVaultFiles, journal: HeadlessOperationJournal<Snapshot>) {
    if (row.phase !== "committed" && row.phase !== "abandoned") return this.receipt(row);
    if (row.postflightVerified !== undefined) return this.receipt(row);
    const plan = row.payload;
    const complete = row.phase === "committed" && this.tryObserve(files, plan).complete;
    let verified = complete && plan.intent.kind === "delete";
    try {
      await this.cache.refreshFilesystemMovePaths(this.paths(plan), plan.settings.trashFolder);
      if (complete && plan.intent.kind === "move" && plan.settings.updateLinks && plan.graphProofs) {
        const resolver = MarkdownLinkResolver.fromPaths(await this.cache.readFilesystemResolutionTargets());
        let graphMatches = true;
        for (const proof of plan.graphProofs) {
          await yieldToEventLoop();
          const state = files.state(proof.path, { readBytes: true });
          if (!state?.bytes || state.size > LARGE_LINK_SOURCE_BYTES ||
              graphProof(state.bytes.toString("utf8"), "/" + proof.path, resolver) !== proof.digest) {
            graphMatches = false;
            break;
          }
        }
        verified = graphMatches;
      }
      if (row.phase === "committed") verified = journal.transaction(tx => tx.recordPostflight(row.id, verified));
      return { ...this.receipt(row, verified), cache: "refreshed" };
    } catch {
      return { ...this.receipt(row, verified), cache: "unavailable" };
    }
  }

  private receipt(row: HeadlessRow<Snapshot>, verified = row.postflightVerified ?? false, recoverable = false, reason = row.reason) {
    const { intent, destination, beforeHash, size, settings, rewrites, backlinks } = row.payload;
    const digest = nativeDigest(row.payload);
    const pending = row.phase === "applying";
    const needsRepair = reason === "headless_manual_repair_required";
    const affectedPaths = [...new Set(this.paths(row.payload))];
    const common = {
      contractVersion: 1, operationKind: `obsidian.note.${intent.kind}`, operationId: row.id,
      planRef: PREFIX[intent.kind] + row.id, planDigest: digest, affectedPaths,
      phase: row.phase === "planned" ? "planned" : "terminal",
      outcome: row.phase === "planned" ? null : pending ? "outcome_unknown" : row.phase,
      ...(row.postflightVerified !== undefined ? { cache: "recorded", postflightSource: "recorded" } as const : {}),
      ...(reason ? { reasonCode: reason } : {}),
      applyAllowed: row.phase === "planned", recoveryAllowed: pending && recoverable,
      abandonAllowed: pending && needsRepair,
      nextAction: row.phase === "planned" ? "apply" : needsRepair ? "manual_repair" : pending ? recoverable ? "recover" : "status" : "none",
      admittedAt: row.createdAt, updatedAt: row.updatedAt,
    };
    if (intent.kind === "move") {
      return { ...common,
        ...(needsRepair ? { repairProofs: rewrites.map(item => ({
          path: item.path === intent.source ? destination : item.path,
          ...(item.path === intent.source ? { originalPath: item.path } : {}),
          beforeSha256: item.beforeHash, afterSha256: item.afterHash,
          ...(row.phase === "abandoned" && typeof item.beforeText === "string" ? { inverseEdits: inverseEdits(item) } : {}),
        })) } : {}), target: { sourcePath: intent.source, destinationPath: destination },
        beforeProof: { sourceSha256: beforeHash, neighborhoodDigest: digest },
        expectedGraphDigest: nativeDigest(row.payload.graphProofs ?? rewrites.map(rewrite => [rewrite.path, rewrite.afterHash])),
        graph_postflight: verified ? "verified" : "indeterminate",
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
      trash: { preference: settings.trashPreference, destination: "vault_trash_folder", path: destination },
      postflight: { status: verified ? "verified" : "indeterminate",
        reason: row.phase === "rejected" ? "delete_note_has_backlinks" : null },
      limitations: ["indexed_markdown_sources_only", "external_writers_do_not_share_locks"],
    };
  }
}
