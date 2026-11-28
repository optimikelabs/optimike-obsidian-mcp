import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { link, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { load } from "js-yaml";
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { requestContextService } from "../../utils/index.js";
import { VaultFileService } from "../vaultFileService.js";
import { nativeNotePath } from "../nativeNoteMoveContract.js";
import { createPolicyDigest, type NoteCreateApply, type NoteCreatePolicy } from "../noteCreateContract.js";
import type { AtomicWriteReadRequest, AtomicWriteCasRequest, AtomicWriteReadResponse, AtomicWriteStatusResponse } from "../obsidianRestAPI/types.js";
import { frontmatterEnvelope } from "../obsidianFrontmatterFormat.js";
import { HEADLESS_VAULT_LOCK_BUSY, isHeadlessVaultLockBusy, operationDigest } from "./contract.js";
import { ATOMIC_EXCHANGE_UNAVAILABLE, atomicExchangeUnavailable, nativeFilesystemExchange } from "./filesystemAtomicExchange.js";
import { materializeFilesystemDates, normalizeDateKey, readFilesystemDatePolicy, renderFilesystemDates, sealFilesystemDates } from "./filesystemDatePolicy.js";
import type { AtomicWriteBackend } from "./obsidianNoteReplaceOperationAdapter.js";
import type { NoteCreateBackend } from "./noteCreateOperationAdapter.js";
import { ObsidianNoteReplaceConcurrencyError, type ObsidianNoteReplacePlan, type ObsidianNoteReplaceJournal } from "./obsidianNoteReplaceJournal.js";

export const FILESYSTEM_AUTHORITY = "headless-filesystem" as const;
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const occupied = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "EEXIST";
const isExchangeUnavailable = (error: unknown) => error instanceof McpError && error.details?.reasonCode === ATOMIC_EXCHANGE_UNAVAILABLE;
const exchangeProbeName = /^\.mcp-exchange-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[ab]\.tmp$/u;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// NTFS may preserve a replaced entry's creation time (file name tunneling).
const identity = (s: BigIntStats) => process.platform === "win32" ?
  `${s.dev}:${s.ino}` : `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const emptyCreatePolicy: NoteCreatePolicy = { version: 1, utcOffsetMinutes: 0, fields: [] };
const frontmatter = (content: string): Record<string, unknown> =>
  (load(frontmatterEnvelope(content)?.yaml ?? "") ?? {}) as Record<string, unknown>;

type DiskSnapshot = { bytes: Buffer; size: number; sha256: string; stat: BigIntStats };
const modifiedAt = (stat: BigIntStats) => new Date(Number(stat.mtimeMs)).toISOString();
const evidence = ({ bytes, sha256, stat }: DiskSnapshot) => ({ sha256, bytesBase64: bytes.toString("base64"), modifiedAt: modifiedAt(stat) });

async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function renameWithPrecondition(source: string, target: string, recheck: () => Promise<void>) {
  for (let attempt = 0; ; attempt += 1) {
    await recheck();
    try { await rename(source, target); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 30 || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await delay(100);
    }
  }
}

function conflict(message: string) {
  return new McpError(BaseErrorCode.CONFLICT, message);
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function vaultIdentity(root: string) {
  return operationDigest({ backend: FILESYSTEM_AUTHORITY,
    root: process.platform === "win32" ? root.toLowerCase() : root,
    identity: identity(statSync(root, { bigint: true })) });
}

export function defaultFilesystemJournal(vaultRoot: string) {
  const root = realpathSync.native(vaultRoot);
  const name = vaultIdentity(root) + ".sqlite";
  const fallback = path.join(config.headlessGovernedStateDirectory, name);
  return filesystemJournalPath(root, path.join(path.dirname(config.obsidianSharedCacheDbPath), name), fallback);
}

/** Resolve existing ancestors before creating state so a configured junction
 * or symlink cannot place the journal (including before images) in the vault. */
export function filesystemJournalPath(vaultRoot: string, candidate: string, fallback?: string): string {
  const root = realpathSync(vaultRoot);
  const resolve = (target: string): string => {
    try { return realpathSync(target); } catch (error) {
      // A dangling symlink is also a configured redirection.
      if (!absent(error) || path.dirname(target) === target) throw error;
      try { lstatSync(target); } catch (missing) {
        if (absent(missing)) return path.join(resolve(path.dirname(target)), path.basename(target));
        throw missing;
      }
      throw new Error("A headless journal path contains an unresolved link.");
    }
  };
  const resolved = resolve(path.resolve(candidate));
  if (!within(root, resolved)) return resolved;
  if (fallback) return filesystemJournalPath(vaultRoot, fallback);
  throw new Error("The headless governed journal must be outside the vault.");
}

/** Advisory locks for cooperating local processes. Kernel SQLite locks are
 * released on process death, without deleting a lock file or expiring a live
 * owner. Shards bound the on-disk footprint; collisions only serialize writes. */
class PathLocks {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  async run<T>(key: string, write: () => Promise<T>): Promise<T> {
    const db = new DatabaseSync(path.join(this.directory, hash(key).slice(0, 2) + ".sqlite"));
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        try { db.exec("BEGIN IMMEDIATE"); break; } catch (error) {
          if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5) throw error;
          if (Date.now() >= deadline) throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE,
            "The headless vault lock is busy. No write was started. Retry with a new plan after the lock is released.",
            { reasonCode: HEADLESS_VAULT_LOCK_BUSY, retryable: true });
          await delay(25);
        }
      }
      return await write();
    } finally {
      // No SQL data changes are required to acquire or release the lock.
      db.close();
    }
  }
}

export class FilesystemNoteBackend implements AtomicWriteBackend, NoteCreateBackend {
  private readonly root: string;
  private readonly bindingFingerprint: string;
  private readonly writer: VaultFileService;
  private readonly locks: PathLocks;
  private readonly removedDirectory: string;
  private readonly context = requestContextService.createRequestContext({ operation: "HeadlessGovernedNote" });

  constructor(vaultRoot: string, journalPath: string, private readonly journal: ObsidianNoteReplaceJournal,
    private readonly now = Date.now, private readonly afterPublish?: () => void,
    private readonly getExchange = nativeFilesystemExchange,
    private readonly getProbeExchange = nativeFilesystemExchange) {
    this.root = realpathSync.native(vaultRoot);
    this.bindingFingerprint = vaultIdentity(this.root);
    this.writer = new VaultFileService(this.root);
    this.locks = new PathLocks(filesystemJournalPath(this.root,
      path.join(config.headlessGovernedStateDirectory, this.bindingFingerprint + ".locks")));
    this.removedDirectory = filesystemJournalPath(this.root, journalPath + ".removed");
  }

  private assertVault() {
    if (vaultIdentity(this.root) !== this.bindingFingerprint) throw conflict("The headless vault identity changed.");
  }

  private async physical(relative: string, allowAbsent = false, exactSpelling = false, allowShared = false) {
    this.assertVault();
    const parts = relative.split("/");
    let target = this.root;
    for (const [index, segment] of parts.entries()) {
      const parent = target;
      target = path.join(parent, segment);
      const last = index === parts.length - 1;
      let entry;
      try { entry = await lstat(target); } catch (error) {
        if (last && allowAbsent && absent(error)) return target;
        throw error;
      }
      if (entry.isSymbolicLink() || (last ? !entry.isFile() || (!allowShared && entry.nlink !== 1) : !entry.isDirectory())) {
        throw new McpError(BaseErrorCode.FORBIDDEN, "Governed filesystem paths require ordinary files and directories.");
      }
      // On Windows, realpath can return an alias or another spelling of an
      // ancestor. The directory entry itself determines the date-rule path.
      if (exactSpelling && !(await readdir(parent)).includes(segment)) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Use the existing vault path with its exact spelling.",
          { reasonCode: "headless_note_path_spelling" });
      }
    }
    return target;
  }

  private target(relative: string, allowAbsent = false, allowShared = false) {
    try { nativeNotePath(relative); } catch {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "A visible vault-relative Markdown path is required.");
    }
    this.writer.resolveVaultPath(relative, this.context);
    return this.physical(relative, allowAbsent, true, allowShared);
  }

  private async policy() {
    const policy = await readFilesystemDatePolicy(async (relative, optional) => {
      try {
        const target = await this.physical(relative);
        if ((await lstat(target)).size > 1024 * 1024) throw new Error("Oversized date configuration.");
        return await readFile(target, "utf8");
      } catch (error) { if (optional && absent(error)) return undefined; throw error; }
    });
    return { ...policy, digest: operationDigest({ datePolicy: policy.digest,
      protectedKeys: config.mcpProtectedFrontmatterKeys.map(normalizeDateKey).sort() }) };
  }

  async status(): Promise<AtomicWriteStatusResponse> {
    const policy = await this.policy();
    return {
      ok: true, contractVersion: 1, plugin: { id: FILESYSTEM_AUTHORITY, version: "1.0.0" },
      backend: { kind: FILESYSTEM_AUTHORITY, bindingFingerprint: this.bindingFingerprint, atomicCas: true, writeEnabled: config.mcpWriteMode !== "readonly",
        headlessReplacement: this.getExchange() ? "exchange" : config.headlessAllowTransientAbsence ? "transient-absence" : "unavailable" },
      limits: { markdownOnly: true },
      noteCreate: { supported: true, exclusiveCreate: true, enabled: config.mcpWriteMode !== "readonly", bindingFingerprint: this.bindingFingerprint },
      frontmatterFormat: { contractVersion: 1, supported: true },
      protection: { contractVersion: 1, frontmatterDateProperties: { integrations: [{
        pluginId: "frontmatter-date-manager",
        createdPropertyName: policy.fdm.headerCreated,
        modifiedPropertyName: policy.fdm.headerUpdated,
        ...(policy.fdm.enableLastViewed ? { viewedPropertyName: policy.fdm.headerLastViewed ?? "viewed" } : {}),
      }] } },
    };
  }

  async inspectFrontmatterFormat(yaml: string) {
    try {
      const value = load(yaml);
      if (value != null && (typeof value !== "object" || Array.isArray(value))) throw new Error();
    } catch {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The frontmatter must be a valid YAML mapping.", { reasonCode: "invalid_frontmatter" });
    }
    return { ok: true, contractVersion: 1, bindingFingerprint: this.bindingFingerprint, canonicalYaml: yaml, warnings: [] };
  }

  private async diskSnapshot(relative: string) {
    return this.rawSnapshot(await this.target(relative));
  }

  private async rawSnapshot(filename: string): Promise<DiskSnapshot> {
    const entry = await lstat(filename, { bigint: true });
    if (!entry.isFile()) throw conflict("The publication witness is no longer a regular file.");
    const handle = await open(filename, "r");
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || identity(stat) !== identity(entry) || stat.size > 5 * 1024 * 1024) throw conflict("The note is too large or changed identity.");
      const bytes = await handle.readFile();
      if (bytes.length > 5 * 1024 * 1024) throw conflict("The note grew beyond the verification limit.");
      return { bytes, size: bytes.length, sha256: hash(bytes), stat };
    } finally { await handle.close(); }
  }

  private observe(filename: string) {
    return this.rawSnapshot(filename).catch(error => { if (absent(error)) return undefined; throw error; });
  }

  private async snapshot(relative: string) {
    const { bytes, ...proof } = await this.diskSnapshot(relative);
    return { ...proof, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  }

  async read({ path: relative }: AtomicWriteReadRequest): Promise<AtomicWriteReadResponse> {
    const { content, size, sha256 } = await this.snapshot(relative);
    return { ok: true, contractVersion: 1, path: relative, bindingFingerprint: this.bindingFingerprint,
      content, size, sha256 };
  }

  async seal(relative: string, proposed: string, source: AtomicWriteReadResponse) {
    const policy = await this.policy();
    const snapshot = await this.snapshot(relative);
    if (snapshot.sha256 !== source.sha256) throw conflict("The note changed during plan preparation.");
    const before = frontmatter(source.content), after = frontmatter(proposed);
    for (const key of policy.keys.map(normalizeDateKey)) {
      const entries = (fm: Record<string, unknown>) => Object.entries(fm).filter(([name]) => normalizeDateKey(name) === key);
      const old = entries(before);
      if (old.length > 1 || !isDeepStrictEqual(old, entries(after))) {
        throw new McpError(BaseErrorCode.FORBIDDEN, "The date manager owns the configured timestamp properties.");
      }
    }
    const content = sealFilesystemDates(policy, relative, proposed, this.now(),
      { content: source.content, birthtimeMs: Number(snapshot.stat.birthtimeMs) });
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw conflict("The sealed note is too large.");
    await this.probeReplacement(relative);
    return { content, policyDigest: policy.digest };
  }

  private pathLock(relative: string) {
    return relative.normalize("NFC").toLowerCase();
  }

  private async withWriteLock<T>(plan: ObsidianNoteReplacePlan, write: () => Promise<T>): Promise<T> {
    try { return await this.locks.run(this.pathLock(plan.path), write); }
    catch (error) {
      if (isHeadlessVaultLockBusy(error)) {
        try { this.journal.settleFilesystemLockBusy(plan); }
        catch (race) { if (!(race instanceof ObsidianNoteReplaceConcurrencyError)) throw race; }
      }
      throw error;
    }
  }

  async matchesEffect(plan: ObsidianNoteReplacePlan) {
    return this.locks.run(this.pathLock(plan.path), () => this.verifyPublication(plan));
  }

  private async verifyPublicationAndSettleRestore(plan: ObsidianNoteReplacePlan) {
    if (!await this.verifyPublication(plan)) return false;
    if (plan.filesystem?.displacedSourceOperationId && this.journal.get(plan.operationId)?.status !== "committed") {
      this.journal.commitAfterVerifiedProof(plan.operationId, ["applying", "outcome_unknown"]);
    }
    return true;
  }

  async restoreInterruptedReplacements() {
    await this.cleanupExchangeProbes();
    for (const operationId of this.journal.interruptedFilesystemReplacements()) {
      const plan = this.journal.get(operationId);
      if (!plan || plan.bindingFingerprint !== this.bindingFingerprint) continue;
      // A currently unavailable path can be reconciled when status is next called.
      await this.locks.run(this.pathLock(plan.path), async () => {
        if (await this.verifyPublication(plan) && this.journal.get(operationId)?.status !== "committed") {
          this.journal.commitAfterVerifiedProof(plan.operationId, ["applying", "outcome_unknown"]);
        }
      }).catch(() => {});
    }
  }

  private async verifyPublication(plan: ObsidianNoteReplacePlan) {
    if (plan.bindingFingerprint !== this.bindingFingerprint) return false;
    const current = this.journal.get(plan.operationId);
    if (current?.status === "committed") return true;
    const staged = current?.filesystem;
    if (!staged?.stagedIdentity || !staged.stagedSha256) return false;
    if (staged.divergentObservation !== undefined) {
      if (staged.localStage && !staged.witnessesCleaned) await this.cleanupDivergence(current!);
      return false;
    }
    if (current?.status !== "applying" && current?.status !== "outcome_unknown") return false;
    if (staged.localStage) return this.reconcileLocalStage(current);
    const observed = await this.diskSnapshot(plan.path).catch(error => { if (absent(error)) return undefined; throw error; });
    const sameIdentity = observed !== undefined && identity(observed.stat) === staged.stagedIdentity;
    if (sameIdentity && observed.sha256 === staged.stagedSha256) return true;
    // A differing inode by itself could mean the process died before rename.
    // Only a successful publish or its surviving inode can authorize a revert.
    if (staged.publicationConfirmed || sameIdentity) {
      this.journal.recordFilesystemDivergence(plan.operationId,
        observed ? { sha256: observed.sha256, bytesBase64: observed.bytes.toString("base64") } : null);
    }
    return false;
  }

  private witnesses(target: string, operationId: string) {
    const prefix = path.join(path.dirname(target), `.mcp-write-${operationId}`);
    return { temp: prefix + ".tmp", backup: prefix + ".bak" };
  }

  private probeLock(directory: string) {
    return "\0exchange-probe:" + this.pathLock(path.relative(this.root, directory));
  }

  private async cleanupExchangeProbes() {
    const directories = [this.root];
    for (const dir of directories) {
      if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) continue;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) directories.push(path.join(dir, entry.name));
      }
      const probes = entries.filter(entry => entry.isFile() && exchangeProbeName.test(entry.name));
      if (!probes.length) continue;
      await this.locks.run(this.probeLock(dir), async () => {
        if (path.relative(dir, realpathSync.native(dir))) return;
        for (const entry of probes) {
          const filename = path.join(dir, entry.name);
          const file = await lstat(filename).catch(() => undefined);
          if (file?.isFile() && file.size === 0 && file.nlink === 1) await rm(filename, { force: true }).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  private async probeReplacement(relative: string) {
    const exchange = this.getExchange() && this.getProbeExchange();
    if (!exchange) {
      if (!config.headlessAllowTransientAbsence) throw atomicExchangeUnavailable();
      return;
    }
    const dir = path.dirname(await this.target(relative));
    await this.locks.run(this.probeLock(dir), async () => {
      const prefix = path.join(dir, `.mcp-exchange-${randomUUID()}`);
      const probes: string[] = [];
      let probeFailed = false;
      try {
        for (const suffix of ["-a.tmp", "-b.tmp"]) {
          const filename = prefix + suffix;
          const handle = await open(filename, "wx", 0o600);
          probes.push(filename);
          await handle.close();
        }
        try { exchange(probes[0]!, probes[1]!); }
        catch (error) {
          if (!isExchangeUnavailable(error) || !config.headlessAllowTransientAbsence) throw error;
        }
      } catch (error) {
        probeFailed = true;
        throw error;
      } finally {
        const cleanup = await Promise.allSettled(probes.map(filename => rm(filename, { force: true })));
        const failure = cleanup.find(result => result.status === "rejected");
        if (failure && !probeFailed) throw failure.reason;
      }
    });
  }

  private async readWitnesses(target: string, plan: ObsidianNoteReplacePlan) {
    const { temp, backup } = this.witnesses(target, plan.operationId);
    const proof = plan.filesystem!;
    const temporary = await this.observe(temp);
    if (proof.localStageMode === "exchange" && temporary && identity(temporary.stat) !== proof.stagedIdentity) {
      return { temp, displacedPath: temp, stage: undefined, displaced: temporary };
    }
    return { temp, displacedPath: proof.localStageMode === "exchange" ? temp : backup,
      stage: temporary, displaced: proof.localStageMode === "exchange" ? undefined : await this.observe(backup) };
  }

  private async cleanupDivergence(plan: ObsidianNoteReplacePlan) {
    const proof = plan.filesystem!;
    const target = await this.target(plan.path, true, true);
    const { temp, displacedPath, stage, displaced } = await this.readWitnesses(target, plan);
    if (stage && (identity(stage.stat) !== proof.stagedIdentity ||
        (stage.sha256 !== proof.stagedSha256 && stage.sha256 !== proof.displacedObservation?.sha256))) return;
    if (displaced && displaced.sha256 !== proof.displacedObservation?.sha256) return;
    if (stage) await rm(temp, { force: true });
    if (displaced) await rm(displacedPath, { force: true });
    await syncDirectory(path.dirname(target));
    this.journal.confirmFilesystemWitnessCleanup(plan.operationId);
  }

  private async reconcileLocalStage(plan: ObsidianNoteReplacePlan) {
    const proof = plan.filesystem!;
    const target = await this.target(plan.path, true, true);
    const witnesses = await this.readWitnesses(target, plan);
    const { temp, displacedPath, stage } = witnesses;
    if (proof.exchangeRollback) return this.reconcileExchangeRollback(plan, target, temp);
    if (stage && identity(stage.stat) !== proof.stagedIdentity) throw conflict("The stage witness changed identity.");
    let displaced = witnesses.displaced;
    let observed = await this.observe(target);
    const stagedAtTarget = observed !== undefined && identity(observed.stat) === proof.stagedIdentity;
    const cleanup = async () => {
      if (stage) await rm(temp, { force: true });
      if (displaced) await rm(displacedPath, { force: true });
      await syncDirectory(path.dirname(target));
    };
    const recordDivergence = async () => {
      if (displaced) displaced = await this.observe(displacedPath) ?? displaced;
      const canRestore = displaced && displaced.sha256 !== plan.beforeSha256 && observed &&
        identity(observed.stat) === proof.stagedIdentity && observed.sha256 === proof.stagedSha256;
      this.journal.recordFilesystemDivergence(plan.operationId, observed ? evidence(observed) : null,
        displaced ? evidence(displaced) : undefined, proof.localStageMode === "exchange"
          ? canRestore ? "restore-displaced" : "conflict" : undefined);
      await this.cleanupDivergence(this.journal.get(plan.operationId)!);
      return false;
    };
    if (stagedAtTarget) {
      const links = observed!.stat.nlink;
      const ownsLinks = links === (stage ? 2n : 1n);
      const backupMatches = displaced ? displaced.sha256 === plan.beforeSha256 :
        proof.backupVerified || plan.projection?.kind === "obsidian.note.create";
      if (proof.localStageMode === "exchange" && displaced && !backupMatches && ownsLinks && observed!.sha256 === proof.stagedSha256) {
        return this.rollbackExchange(plan, target, temp, displaced);
      }
      if (!ownsLinks || observed!.sha256 !== proof.stagedSha256 || !backupMatches) return recordDivergence();
      if (displaced && !proof.backupVerified) this.journal.verifyFilesystemBackup(plan.operationId);
      if (displaced) {
        const latest = await this.observe(displacedPath);
        if (latest?.sha256 !== plan.beforeSha256) {
          if (latest && proof.localStageMode === "exchange") return this.rollbackExchange(plan, target, temp, latest);
          return recordDivergence();
        }
      }
      await cleanup();
      // Re-read after detaching our aliases. A later write invalidates this proof.
      observed = await this.observe(target);
      if (observed && observed.sha256 === proof.stagedSha256 && identity(observed.stat) === proof.stagedIdentity && observed.stat.nlink === 1n) return true;
      return recordDivergence();
    }
    if (proof.publicationConfirmed) return recordDivergence();
    if (displaced) {
      if (proof.localStageMode === "exchange") return recordDivergence();
      if (!observed) {
        try { await link(displacedPath, target); } catch (error) { if (!occupied(error)) throw error; }
        observed = await this.observe(target);
      }
      if (!observed || identity(observed.stat) !== identity(displaced.stat)) return recordDivergence();
    }
    await cleanup();
    this.journal.settleUnpublishedFilesystem(plan.operationId, "conflict");
    return false;
  }

  private async rollbackExchange(plan: ObsidianNoteReplacePlan, target: string, temp: string, displaced: DiskSnapshot) {
    this.journal.recordFilesystemExchangeRollback(plan.operationId, { ...evidence(displaced), identity: identity(displaced.stat) });
    return this.reconcileExchangeRollback(this.journal.get(plan.operationId)!, target, temp);
  }

  private async reconcileExchangeRollback(plan: ObsidianNoteReplacePlan, target: string, temp: string) {
    const proof = plan.filesystem!;
    let saved = proof.exchangeRollback!;
    const ownStage = (file?: DiskSnapshot) => file?.stat.nlink === 1n &&
      identity(file.stat) === proof.stagedIdentity && file.sha256 === proof.stagedSha256;
    const original = (file?: DiskSnapshot) => file !== undefined && identity(file.stat) === saved.identity;
    let backup = await this.observe(temp);
    let current = await this.observe(target);
    const exchange = this.getExchange();
    if (backup && original(backup) && backup.stat.nlink === 1n && ownStage(current) && exchange) {
      if (backup.sha256 !== saved.sha256) {
        saved = { ...evidence(backup), identity: saved.identity };
        this.journal.recordFilesystemExchangeRollback(plan.operationId, saved);
      }
      // Check the bytes, then recheck the two inode identities immediately
      // before the syscall. Postflight still has to account for the last race.
      if (ownStage(await this.observe(target))) {
        try {
          const atTemp = lstatSync(temp, { bigint: true });
          const atTarget = lstatSync(target, { bigint: true });
          if (atTemp.isFile() && atTemp.nlink === 1n && identity(atTemp) === saved.identity &&
              atTarget.isFile() && atTarget.nlink === 1n && identity(atTarget) === proof.stagedIdentity) {
            exchange(target, temp);
          }
        } catch { /* Observe both paths before classifying an interrupted exchange. */ }
      }
      backup = await this.observe(temp);
      current = await this.observe(target);
    }
    if (original(current) && current?.sha256 === saved.sha256 && (!backup || ownStage(backup))) {
      if (backup) await rm(temp);
      await syncDirectory(path.dirname(target));
      backup = undefined;
      current = await this.observe(target);
      if (original(current) && current?.sha256 === saved.sha256) {
        this.journal.settleUnpublishedFilesystem(plan.operationId, "conflict", "headless_exchange_rolled_back");
        return false;
      }
    }
    // The returned witness can contain a third writer's bytes. Only offer
    // restoration if those bytes were displaced by the second exchange and
    // its restored target is intact, or the first stage still occupies the target.
    const restoreDisplaced = backup && !ownStage(backup) && current && (
      (original(backup) && ownStage(current)) ||
      (!original(backup) && original(current) && current.sha256 === saved.sha256));
    const displaced = backup && !ownStage(backup) ? evidence(backup) : { sha256: saved.sha256, bytesBase64: saved.bytesBase64 };
    this.journal.recordFilesystemDivergence(plan.operationId, current ? evidence(current) : null, displaced,
      restoreDisplaced ? "restore-displaced" : "conflict");
    await this.cleanupDivergence(this.journal.get(plan.operationId)!);
    return false;
  }

  async sealRevert(relative: string, source: string | undefined, expectedHash: string, restoreDisplaced: boolean) {
    const current = await this.snapshot(relative).catch(error => {
      if (absent(error)) throw new McpError(BaseErrorCode.CONFLICT, "The note no longer exists.", {
        reasonCode: "headless_revert_target_missing",
      });
      throw error;
    });
    if (current.sha256 !== expectedHash) throw conflict("The note no longer matches the original operation's after proof.");
    const policy = await this.policy();
    if (source !== undefined) await this.probeReplacement(relative);
    if (source === undefined) {
      const directory = filesystemJournalPath(this.root, this.removedDirectory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory, { bigint: true })).dev !== current.stat.dev) {
        throw new McpError(BaseErrorCode.FORBIDDEN, "Reverting creation requires journal storage on the same filesystem as the vault.");
      }
    }
    let content = source ?? "";
    if (source !== undefined && !restoreDisplaced) {
      const original = frontmatter(source);
      const dates = frontmatter(current.content);
      // A prior write may have initialized creation. Keep that date when
      // restoring the original user-authored content.
      const created = policy.fdm.headerCreated;
      if (!Object.keys(original).some(key => normalizeDateKey(key) === normalizeDateKey(created))) {
        const key = Object.keys(dates).find(key => normalizeDateKey(key) === normalizeDateKey(created));
        if (key && policy.managed(relative)) {
          const fm = frontmatterEnvelope(current.content);
          const originalLine = fm?.yaml.split(/\r?\n/u).find(line => line.startsWith(key + ": "));
          const value = originalLine?.slice(key.length + 2).replace(/^['"]|['"]$/gu, "");
          if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/u.test(value)) {
            throw conflict("The managed creation date cannot be restored losslessly.");
          }
          if (!frontmatterEnvelope(content)) {
            const eol = content.includes("\r\n") ? "\r\n" : "\n";
            const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
            content = `${bom}---${eol}---${eol}${content.slice(bom.length)}`;
          }
          content = renderFilesystemDates(content, [{ op: "set", key, value }]);
        }
      }
      content = sealFilesystemDates(policy, relative, content, this.now(),
        { content: current.content, birthtimeMs: Number(current.stat.birthtimeMs) });
    }
    return { policyDigest: policy.digest, before: current.content, beforeModifiedAt: modifiedAt(current.stat),
      beforeObservedAt: new Date(this.now()).toISOString(), content,
      afterSha256: source === undefined ? operationDigest({ absent: relative, binding: this.bindingFingerprint }) : hash(content),
      bindingFingerprint: this.bindingFingerprint };
  }

  private removedPath(plan: ObsidianNoteReplacePlan) {
    return path.join(this.removedDirectory, plan.operationId + ".md");
  }

  async revertPublished(plan: ObsidianNoteReplacePlan) {
    if (plan.projection?.proof.restoreAbsence !== true) {
      return this.locks.run(this.pathLock(plan.path), () => this.verifyPublicationAndSettleRestore(plan));
    }
    if (plan.bindingFingerprint !== this.bindingFingerprint || (await this.inspect(plan.path)).exists) return false;
    const staged = this.journal.get(plan.operationId)?.filesystem?.stagedIdentity;
    const removed = this.removedPath(plan);
    const observed = await lstat(removed, { bigint: true }).catch(error => { if (absent(error)) return undefined; throw error; });
    return Boolean(observed?.isFile() && identity(observed) === staged &&
      hash(await readFile(removed)) === plan.beforeSha256);
  }

  async clearRevertWitness(plan: ObsidianNoteReplacePlan) {
    if (plan.projection?.proof.restoreAbsence !== true) return;
    // The journal still owns the before image after removal. Retain the
    // staged original only until the verified terminal receipt is durable.
    const removed = this.removedPath(plan);
    const entry = await lstat(removed, { bigint: true }).catch(error => { if (absent(error)) return undefined; throw error; });
    if (entry && identity(entry) === plan.filesystem?.stagedIdentity) await rm(removed);
  }

  async applyRevert(plan: ObsidianNoteReplacePlan) {
    if (plan.projection?.proof.restoreAbsence !== true) return this.publish(plan, plan.beforeSha256);
    return this.withWriteLock(plan, async () => {
      const target = await this.target(plan.path, true);
      const observed = await this.snapshot(plan.path).catch(error => {
        if (absent(error)) throw conflict("The sealed note no longer exists.");
        throw error;
      });
      if (plan.bindingFingerprint !== this.bindingFingerprint || observed.sha256 !== plan.beforeSha256 ||
          (await this.policy()).digest !== plan.filesystem?.policyDigest) {
        throw conflict("The note or date policy changed before the revert.");
      }
      const directory = filesystemJournalPath(this.root, this.removedDirectory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory, { bigint: true })).dev !== observed.stat.dev) {
        throw new McpError(BaseErrorCode.FORBIDDEN, "Reverting creation requires journal storage on the same filesystem as the vault.");
      }
      this.journal.recordFilesystemStage(plan.operationId, plan.executionOwner!.attemptId, identity(observed.stat), plan.afterSha256);
      await renameWithPrecondition(target, this.removedPath(plan), async () => {
        const latest = await this.snapshot(plan.path);
        if (latest.sha256 !== plan.beforeSha256 || identity(latest.stat) !== identity(observed.stat)) {
          throw conflict("The note changed just before the revert.");
        }
      });
      if (process.platform !== "win32") {
        for (const dir of [path.dirname(target), directory]) {
          const handle = await open(dir, "r");
          try { await handle.sync(); } finally { await handle.close(); }
        }
      }
      this.afterPublish?.();
      if (!await this.revertPublished(plan)) throw new Error("The headless postflight could not verify removal.");
    });
  }

  private async publish(plan: ObsidianNoteReplacePlan, expectedHash?: string) {
    const relative = plan.path;
    return this.withWriteLock(plan, async () => {
      const target = await this.target(relative, true);
      if (!plan.filesystem || plan.bindingFingerprint !== this.bindingFingerprint ||
          hash(plan.nextContent) !== plan.afterSha256) throw conflict("The headless filesystem seal is invalid.");
      const displacedSource = plan.filesystem.displacedSourceOperationId;
      if (displacedSource && this.journal.get(displacedSource)?.status !== "outcome_unknown") {
        throw conflict("The displaced edit is no longer eligible for restoration.");
      }
      const policy = await this.policy();
      if (policy.digest !== plan.filesystem.policyDigest) throw conflict("The date policy changed after planning.");
      const content = plan.projection?.proof.restoreDisplaced === true ? plan.nextContent :
        materializeFilesystemDates(policy, relative, plan.nextContent, this.now(), plan.filesystem.beforeContent);
      const sha256 = hash(content);
      if (sha256 === expectedHash) throw conflict("The sealed write would leave the note unchanged.");
      const before = await this.observe(target);
      if (before?.sha256 !== expectedHash) throw conflict("The note changed since planning.");
      if (!before) await this.writer.assertNewFileName(relative, target);
      const exchange = before ? this.getExchange() : undefined;
      if (before && !exchange && !config.headlessAllowTransientAbsence) {
        this.journal.settleUnpublishedFilesystem(plan.operationId, "failed", ATOMIC_EXCHANGE_UNAVAILABLE);
        throw atomicExchangeUnavailable();
      }
      const { temp, backup } = this.witnesses(target, plan.operationId);
      const attempt = plan.executionOwner!.attemptId;
      const file = await open(temp, "wx", before ? Number(before.stat.mode & 0o777n) : 0o600);
      let journaled = false;
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
        const staged = await file.stat({ bigint: true });
        if (staged.ino === 0n) throw conflict("The filesystem cannot prove the identity of staged bytes.");
        await file.close();
        await syncDirectory(path.dirname(target));
        if ((await this.policy()).digest !== policy.digest) throw conflict("The date policy changed after planning.");
        this.journal.recordFilesystemStage(plan.operationId, attempt, identity(staged), sha256, content,
          exchange ? "exchange" : "legacy");
        journaled = true;
      } finally {
        await file.close();
        if (!journaled) await rm(temp, { force: true });
      }
      const recheck = async () => {
        if ((await this.diskSnapshot(relative).catch(error => { if (absent(error)) return undefined; throw error; }))?.sha256 !== expectedHash) {
          throw conflict("The note changed before publication.");
        }
      };
      let exchanged = false;
      if (exchange) {
        try {
          await recheck();
          exchange(target, temp);
          exchanged = true;
        } catch (error) {
          const unavailable = isExchangeUnavailable(error);
          if (!unavailable || !config.headlessAllowTransientAbsence) {
            await rm(temp, { force: true });
            this.journal.settleUnpublishedFilesystem(plan.operationId,
              error instanceof McpError && error.code === BaseErrorCode.CONFLICT ? "conflict" : "failed",
              unavailable ? ATOMIC_EXCHANGE_UNAVAILABLE : undefined);
            throw error;
          }
          // A failed exchange leaves both names intact. Switch the journaled
          // witness layout before using the explicitly permitted fallback.
          const stage = await this.rawSnapshot(temp);
          this.journal.recordFilesystemStage(plan.operationId, attempt, identity(stage.stat), sha256, content, "legacy");
        }
      }
      if (before && !exchanged) {
        try {
          await renameWithPrecondition(target, backup, recheck);
        } catch (error) {
          await rm(temp, { force: true });
          this.journal.settleUnpublishedFilesystem(plan.operationId,
            error instanceof McpError && error.code === BaseErrorCode.CONFLICT ? "conflict" : "failed");
          throw error;
        }
        if ((await this.rawSnapshot(backup)).sha256 !== expectedHash) {
          await this.verifyPublication(plan);
          throw conflict("The displaced note changed before publication.");
        }
      }
      if (!exchanged) {
        try { await link(temp, target); } catch (error) {
          if (!occupied(error)) throw error;
          await this.verifyPublication(plan);
          throw conflict("Another writer recreated the note before publication.");
        }
        await rm(temp);
      }
      this.journal.confirmFilesystemPublication(plan.operationId, attempt);
      await syncDirectory(path.dirname(target));
      this.afterPublish?.();
      if (!await this.verifyPublicationAndSettleRestore(plan)) throw new Error("The headless postflight could not verify the published file.");
      return { sha256, size: Buffer.byteLength(content, "utf8") };
    });
  }

  async replace(request: AtomicWriteCasRequest, plan?: ObsidianNoteReplacePlan) {
    if (!plan || request.path !== plan.path || request.expectedSha256 !== plan.beforeSha256) {
      throw conflict("A sealed headless operation is required.");
    }
    const published = await this.publish(plan, request.expectedSha256);
    return { ok: true as const, contractVersion: 1 as const, path: plan.path, bindingFingerprint: plan.bindingFingerprint,
      beforeSha256: plan.beforeSha256, afterSha256: published.sha256, size: published.size };
  }

  async preflight(relative: string) {
    const target = await this.target(relative, true);
    try { await lstat(target); } catch (error) {
      if (!absent(error)) throw error;
      await this.writer.assertNewFileName(relative, target);
      return { contractVersion: 1, path: relative, bindingFingerprint: this.bindingFingerprint,
        absent: true, enabled: true, policy: emptyCreatePolicy, policyDigest: createPolicyDigest(emptyCreatePolicy) };
    }
    throw conflict("The create target already exists.");
  }

  async sealCreate(relative: string, content: string) {
    const policy = await this.policy();
    const keys = Object.keys(load(frontmatterEnvelope(content)?.yaml ?? "") ?? {}).map(normalizeDateKey);
    if (policy.keys.some(key => keys.includes(normalizeDateKey(key)))) {
      throw new McpError(BaseErrorCode.FORBIDDEN, "The date manager owns the configured timestamp properties.");
    }
    const sealed = sealFilesystemDates(policy, relative, content, this.now());
    const properties = frontmatter(sealed);
    const fields = [
      { propertyName: policy.fdm.headerCreated, role: "created" },
      { propertyName: policy.fdm.headerUpdated, role: "modified" },
    ].filter(field => Object.hasOwn(properties, field.propertyName));
    return { content: sealed, policyDigest: policy.digest, fields };
  }

  async create(request: NoteCreateApply, plan?: ObsidianNoteReplacePlan) {
    if (!plan || request.operationId !== plan.operationId) throw conflict("A sealed headless create is required.");
    let outcome = "created";
    try { await this.publish(plan); } catch (error) {
      if (!(error instanceof McpError) || error.code !== BaseErrorCode.CONFLICT) throw error;
      outcome = "conflict";
    }
    return { contractVersion: 1, operationId: request.operationId, path: request.path,
      bindingFingerprint: request.bindingFingerprint, policyDigest: request.policyDigest,
      contentSha256: request.contentSha256, outcome, reason: outcome };
  }

  async inspect(relative: string) {
    const base = { contractVersion: 1, path: relative, bindingFingerprint: this.bindingFingerprint };
    try {
      const read = await this.snapshot(relative);
      return { ...base, exists: true, content: read.content, sha256: read.sha256 };
    } catch (error) { if (absent(error)) return { ...base, exists: false }; throw error; }
  }
}
