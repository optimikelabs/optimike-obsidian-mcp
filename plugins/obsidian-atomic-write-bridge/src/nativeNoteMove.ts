import {
  NATIVE_MOVE_MAX_NEIGHBORS,
  nativeDigest,
  nativeGraphDigest,
  nativeMovePaths,
  sealNativeMove,
  type NativeMoveApply,
  type NativeMoveObservation,
  type NativeMovePreflight,
  type NativeSemanticNote,
} from "../../../src/services/nativeNoteMoveContract.js";

export class NativeMoveBeforeEffectConflict extends Error {}
export type NativeMoveClock = { epoch: string; resolved: number };
export interface NativeMoveHost {
  binding(): string;
  enabled(): boolean;
  preference(): boolean | null;
  clock(): NativeMoveClock;
  absent(path: string): Promise<boolean>;
  parentExists(path: string): boolean;
  note(path: string): Promise<NativeSemanticNote>;
  /** Must revalidate the source/destination/preference immediately before renameFile. */
  rename(plan: NativeMovePreflight): Promise<{ afterSha256: string; barrier: NativeMoveClock }>;
}

type Entry = {
  requestDigest: string;
  request: NativeMoveApply;
  observation: NativeMoveObservation;
  plan?: NativeMovePreflight;
  barrier?: NativeMoveClock;
  dispatchedAt?: number;
  lastMatch?: { digest: string; at: number; resolved: number };
  bytes: number;
};

/** Backend acknowledgements are bounded and process-local; the MCP journal is durable. */
export class NativeNoteMoveService {
  private readonly entries = new Map<string, Entry>();
  private executing = false;
  private bytes = 0;
  constructor(private readonly host: NativeMoveHost, private readonly now = Date.now) {}

  async preflight(source: string, destination: string): Promise<NativeMovePreflight> {
    const paths = nativeMovePaths(source, destination);
    if (!this.host.enabled()) throw new Error("native_moves_disabled");
    const updateLinks = this.host.preference();
    if (updateLinks === null) throw new Error("native_preference_unavailable");
    if (!this.host.parentExists(paths.destinationPath) || !(await this.host.absent(paths.destinationPath))) {
      throw new Error("destination_not_free");
    }
    const first = await this.host.note(paths.sourcePath);
    const incoming = [...new Set(first.backlinks.map((item) => item.sourcePath))]
      .filter((path) => path !== paths.sourcePath);
    if (incoming.length > NATIVE_MOVE_MAX_NEIGHBORS) throw new Error("move_neighborhood_limit");
    const notes = [first];
    for (const path of incoming) notes.push(await this.host.note(path));
    return sealNativeMove({ ...paths, bindingFingerprint: this.host.binding(), updateLinks, notes });
  }

  async apply(request: NativeMoveApply): Promise<NativeMoveObservation> {
    nativeMovePaths(request.sourcePath, request.destinationPath);
    if (request.contractVersion !== 1 || !/^[a-f0-9-]{36}$/u.test(request.operationId) ||
        !/^[a-f0-9]{64}$/u.test(request.bindingFingerprint) ||
        !/^[a-f0-9]{64}$/u.test(request.preconditionDigest)) throw new Error("invalid_native_move_request");
    const requestDigest = nativeDigest(request);
    const existing = this.entries.get(request.operationId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("native_operation_identity_conflict");
      return this.status(request.operationId, request.preconditionDigest);
    }
    const observation: NativeMoveObservation = {
      contractVersion: 1, operationId: request.operationId,
      bindingFingerprint: this.host.binding(), preconditionDigest: request.preconditionDigest,
      outcome: "outcome_unknown", reason: "in_flight", graphPostflight: "pending",
      scope: "sealed_neighborhood_only", replayAllowed: false,
    };
    if (this.executing || this.entries.size >= 128 || this.bytes >= 8 * 1024 * 1024) {
      return { ...observation, outcome: "rejected", reason: "native_move_capacity", graphPostflight: "indeterminate" };
    }
    const entry: Entry = { request: { ...request }, requestDigest, observation, bytes: 1024 };
    this.entries.set(request.operationId, entry);
    this.bytes += entry.bytes;
    this.executing = true;
    let mayHaveDispatched = false;
    try {
      if (request.bindingFingerprint !== this.host.binding()) throw new NativeMoveBeforeEffectConflict();
      const plan = await this.preflight(request.sourcePath, request.destinationPath);
      if (plan.preconditionDigest !== request.preconditionDigest) throw new NativeMoveBeforeEffectConflict();
      const cost = Buffer.byteLength(JSON.stringify(plan), "utf8");
      if (this.bytes + cost > 8 * 1024 * 1024) throw new Error("native_move_capacity");
      entry.plan = plan;
      entry.bytes += cost;
      this.bytes += cost;
      if (!this.host.enabled()) throw new Error("native_moves_disabled");
      if (this.host.preference() !== plan.updateLinks) throw new NativeMoveBeforeEffectConflict();
      entry.dispatchedAt = this.now();
      mayHaveDispatched = true;
      const result = await this.host.rename(plan);
      if (!/^[a-f0-9]{64}$/u.test(result.afterSha256)) throw new Error("invalid_native_move_result");
      entry.barrier = result.barrier;
      entry.observation = {
        ...observation, outcome: "committed", reason: "native_rename_returned",
        afterSha256: result.afterSha256,
      };
    } catch (error) {
      const before = !mayHaveDispatched || error instanceof NativeMoveBeforeEffectConflict;
      entry.observation = {
        ...observation,
        outcome: before ? "conflict" : "outcome_unknown",
        reason: before ? "precondition_failed_replan_required" : "native_effect_uncertain",
        graphPostflight: "indeterminate",
      };
    } finally {
      this.executing = false;
    }
    return { ...entry.observation };
  }

  async status(operationId: string, preconditionDigest: string): Promise<NativeMoveObservation> {
    const entry = this.entries.get(operationId);
    if (!entry || entry.request.preconditionDigest !== preconditionDigest) {
      return {
        contractVersion: 1, operationId, preconditionDigest, bindingFingerprint: this.host.binding(),
        outcome: "outcome_unknown", reason: "backend_receipt_unavailable",
        graphPostflight: "indeterminate", scope: "sealed_neighborhood_only", replayAllowed: false,
      };
    }
    if (entry.observation.outcome !== "committed" || !entry.plan || !entry.barrier) return { ...entry.observation };
    const elapsed = this.now() - (entry.dispatchedAt ?? this.now());
    const clock = this.host.clock();
    if (this.host.binding() !== entry.request.bindingFingerprint || clock.epoch !== entry.barrier.epoch) {
      return { ...entry.observation, graphPostflight: "indeterminate", reason: "backend_generation_changed" };
    }
    if (clock.resolved <= entry.barrier.resolved) {
      return { ...entry.observation, graphPostflight: elapsed < 5000 ? "pending" : "indeterminate", reason: "cache_resolution_barrier_not_observed" };
    }
    try {
      if (!(await this.host.absent(entry.request.sourcePath))) throw new Error("source_path_reused");
      const notes: NativeSemanticNote[] = [];
      for (const note of entry.plan.notes) {
        const path = note.path === entry.request.sourcePath ? entry.request.destinationPath : note.path;
        notes.push(await this.host.note(path));
      }
      const target = notes.find((note) => note.path === entry.request.destinationPath)!;
      if (target.sha256 !== entry.observation.afterSha256) throw new Error("destination_content_drift");
      const digest = nativeGraphDigest(notes);
      const afterClock = this.host.clock();
      if (afterClock.epoch !== clock.epoch || afterClock.resolved !== clock.resolved) {
        entry.lastMatch = undefined;
        return { ...entry.observation, graphPostflight: "pending", reason: "graph_changed_during_observation" };
      }
      if (digest !== entry.plan.expectedGraphDigest) {
        entry.lastMatch = undefined;
        return { ...entry.observation, observedGraphDigest: digest,
          graphPostflight: elapsed < 5000 ? "pending" : "failed", reason: "observed_semantic_effects_differ" };
      }
      const previous = entry.lastMatch;
      const quiet = previous?.digest === digest && previous.resolved === clock.resolved && this.now() - previous.at >= 100;
      if (!previous || previous.digest !== digest || previous.resolved !== clock.resolved) {
        entry.lastMatch = { digest, at: this.now(), resolved: clock.resolved };
      }
      return { ...entry.observation, observedGraphDigest: digest,
        graphPostflight: quiet ? "verified" : "pending",
        reason: quiet ? "sealed_neighborhood_verified" : "awaiting_second_stable_observation" };
    } catch {
      return { ...entry.observation, graphPostflight: elapsed < 5000 ? "pending" : "indeterminate", reason: "graph_observation_unavailable_or_drifted" };
    }
  }
}
