import {
  NOTE_DELETE_PRECONDITION_WINDOW_MS,
  noteDeleteDigest,
  sealNoteDelete,
  type NoteDeleteApply,
  type NoteDeleteBacklink,
  type NoteDeleteObservation,
  type NoteDeletePreflight,
  type NoteDeleteTrashOption,
} from "../../../src/services/noteDeleteContract.js";
import { nativeNotePath } from "../../../src/services/nativeNoteMoveContract.js";

export class NoteDeleteBeforeEffectConflict extends Error {}

export type NoteDeleteObservedNote = {
  sha256: string;
  byteLength: number;
  backlinks: NoteDeleteBacklink[];
};

export interface NoteDeleteHost {
  binding(): string;
  enabled(): boolean;
  /** The vault's "Deleted files" preference; `permanent` and `null` (unreadable) are refused. */
  trashOption(): NoteDeleteTrashOption | "permanent" | null;
  /** Exact bytes hash, size and incoming links of the note at `path`; throws when it cannot be read exactly. */
  observe(path: string): Promise<NoteDeleteObservedNote>;
  absent(path: string): Promise<boolean>;
  /** Names of vault-trash entries of the same file name whose bytes hash to `sha256` (empty when the trash is not observable). */
  trashCopies(path: string, sha256: string): Promise<string[]>;
  /**
   * Must re-read the note and compare it with the plan immediately before
   * `FileManager.trashFile`, and confirm the path is gone afterwards.
   */
  trash(plan: NoteDeletePreflight): Promise<void>;
}

type Entry = {
  requestDigest: string;
  request: NoteDeleteApply;
  observation: NoteDeleteObservation;
  plan?: NoteDeletePreflight;
  trashBefore?: Set<string>;
  dispatchedAt?: number;
  settledAt?: number;
  lastAccess: number;
};

const MAX_ENTRIES = 128;
const COMPLETED_TTL_MS = 10 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/u;

/** Backend acknowledgements are bounded and process-local; the MCP journal is durable. */
export class NoteDeleteService {
  private readonly entries = new Map<string, Entry>();
  private executing = false;
  constructor(
    private readonly host: NoteDeleteHost,
    private readonly now = Date.now,
  ) {}

  private reserve(): boolean {
    const now = this.now();
    for (const [id, entry] of [...this.entries.entries()]
      .filter(([, e]) => e.settledAt !== undefined && now - e.settledAt >= NOTE_DELETE_PRECONDITION_WINDOW_MS)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess)) {
      if (now - entry.lastAccess >= COMPLETED_TTL_MS || this.entries.size >= MAX_ENTRIES) this.entries.delete(id);
    }
    return this.entries.size < MAX_ENTRIES;
  }

  private option(): NoteDeleteTrashOption {
    if (!this.host.enabled()) throw new Error("note_delete_disabled");
    const option = this.host.trashOption();
    if (option === "permanent") throw new Error("trash_preference_permanent");
    if (option === null) throw new Error("trash_preference_unavailable");
    return option;
  }

  async preflight(path: string, acknowledgeBacklinks: boolean): Promise<NoteDeletePreflight> {
    nativeNotePath(path);
    const trashOption = this.option();
    const note = await this.host.observe(path);
    return sealNoteDelete({
      bindingFingerprint: this.host.binding(), path, trashOption, acknowledgeBacklinks, ...note,
    });
  }

  /** Re-observes the sealed target and returns it only if the exact sealed digest still holds. */
  private async revalidate(request: NoteDeleteApply): Promise<NoteDeletePreflight> {
    for (const acknowledgeBacklinks of [false, true]) {
      try {
        const fresh = await this.preflight(request.path, acknowledgeBacklinks);
        if (fresh.preconditionDigest === request.preconditionDigest) return fresh;
      } catch (error) {
        // Disabled or unreadable-preference states are not an alternative reading of the plan.
        if (error instanceof Error && ["note_delete_disabled", "trash_preference_permanent", "trash_preference_unavailable"].includes(error.message)) throw error;
      }
    }
    throw new NoteDeleteBeforeEffectConflict();
  }

  async apply(request: NoteDeleteApply): Promise<NoteDeleteObservation> {
    nativeNotePath(request.path);
    if (request.contractVersion !== 1 || !/^[a-f0-9-]{36}$/u.test(request.operationId) ||
        !HASH.test(request.bindingFingerprint) || !HASH.test(request.preconditionDigest)) {
      throw new Error("invalid_delete_request");
    }
    const requestDigest = noteDeleteDigest(request);
    const existing = this.entries.get(request.operationId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("delete_operation_identity_conflict");
      return this.status(request.operationId, request.preconditionDigest);
    }
    // Replaced below once the effective trash option is known; `system` is never assumed.
    const observation: NoteDeleteObservation = {
      contractVersion: 1, operationId: request.operationId,
      bindingFingerprint: request.bindingFingerprint, preconditionDigest: request.preconditionDigest,
      outcome: "outcome_unknown", reason: "in_flight", trashOption: "local",
      trashPostflight: "pending", replayAllowed: false,
    };
    if (this.executing || !this.reserve()) {
      return { ...observation, outcome: "rejected", reason: "note_delete_capacity", trashPostflight: "indeterminate" };
    }
    const entry: Entry = { request: { ...request }, requestDigest, observation, lastAccess: this.now() };
    this.entries.set(request.operationId, entry);
    this.executing = true;
    let mayHaveDispatched = false;
    try {
      if (request.bindingFingerprint !== this.host.binding()) throw new NoteDeleteBeforeEffectConflict();
      const plan = await this.revalidate(request);
      entry.plan = plan;
      observation.trashOption = plan.trashOption;
      entry.trashBefore = new Set(await this.host.trashCopies(plan.path, plan.sha256));
      if (!this.host.enabled()) throw new Error("note_delete_disabled");
      if (this.host.trashOption() !== plan.trashOption) throw new NoteDeleteBeforeEffectConflict();
      entry.dispatchedAt = this.now();
      mayHaveDispatched = true;
      await this.host.trash(plan);
      entry.observation = { ...observation, outcome: "committed", reason: "native_trash_returned" };
    } catch (error) {
      const before = !mayHaveDispatched || error instanceof NoteDeleteBeforeEffectConflict;
      entry.observation = {
        ...observation,
        outcome: before ? "conflict" : "outcome_unknown",
        reason: before ? "precondition_failed_replan_required" : "native_effect_uncertain",
        trashPostflight: "indeterminate",
      };
    } finally {
      if (["committed", "conflict", "rejected"].includes(entry.observation.outcome)) entry.settledAt = this.now();
      this.executing = false;
    }
    return { ...entry.observation };
  }

  async status(operationId: string, preconditionDigest: string): Promise<NoteDeleteObservation> {
    const entry = this.entries.get(operationId);
    if (!entry || entry.request.preconditionDigest !== preconditionDigest) {
      return {
        contractVersion: 1, operationId, preconditionDigest, bindingFingerprint: this.host.binding(),
        outcome: "outcome_unknown", reason: "backend_receipt_unavailable",
        trashOption: "local", trashPostflight: "indeterminate", replayAllowed: false,
      };
    }
    entry.lastAccess = this.now();
    if (entry.observation.outcome !== "committed" || !entry.plan) return { ...entry.observation };
    const plan = entry.plan;
    const elapsed = this.now() - (entry.dispatchedAt ?? this.now());
    if (this.host.binding() !== entry.request.bindingFingerprint) {
      return { ...entry.observation, trashPostflight: "indeterminate", reason: "backend_generation_changed" };
    }
    try {
      if (!(await this.host.absent(plan.path))) {
        return { ...entry.observation, trashPostflight: "failed", reason: "path_reoccupied_or_still_present" };
      }
      const fresh = (await this.host.trashCopies(plan.path, plan.sha256)).filter((name) => !entry.trashBefore?.has(name));
      if (fresh.length > 0) {
        return { ...entry.observation, trashPostflight: "verified", reason: "absent_and_exact_copy_in_trash" };
      }
      // The system trash (or a vault without a readable .trash) cannot be observed from here.
      if (plan.trashOption === "system") {
        return { ...entry.observation, trashPostflight: "path_absent_only", reason: "absent_system_trash_not_observable" };
      }
      return {
        ...entry.observation,
        trashPostflight: elapsed < NOTE_DELETE_PRECONDITION_WINDOW_MS ? "pending" : "indeterminate",
        reason: "trash_copy_not_observed",
      };
    } catch {
      return {
        ...entry.observation,
        trashPostflight: elapsed < NOTE_DELETE_PRECONDITION_WINDOW_MS ? "pending" : "indeterminate",
        reason: "trash_observation_unavailable",
      };
    }
  }
}
