import { randomUUID } from "node:crypto";

/**
 * Effect fence: the only authority that can say whether one governed write
 * attempt may still reach its effect point inside Obsidian.
 *
 * The MCP journal records `{ epoch, attemptId }` before dispatch. Every effect
 * route calls `enter()` synchronously in the same tick that starts the effect
 * (inside `vault.process`, immediately before an exclusive create, a native
 * rename or the date manager command). A revocation handled on the same
 * JavaScript thread is therefore either before that point (the attempt is
 * refused forever) or after it (the verdict says the effect started).
 *
 * State is in memory on purpose: a token is only valid for the epoch issued by
 * the fence that is active in this realm. An unload closes the fence, a new
 * load issues a new epoch and an application restart kills every pending
 * handler, so no older token can pass an effect point again.
 *
 * Keep this module free of Obsidian imports and of TypeScript-only runtime
 * syntax: MCP tests load it with Node type stripping.
 */
export const EFFECT_FENCE_CONTRACT_VERSION = 1;
/** Longest wait after which a handler of an older, unfenced Bridge build in the
 * same realm cannot still be running (requests are bounded far below this). */
export const LEGACY_QUIESCENCE_MS = 10 * 60 * 1000;
export const EFFECT_FENCE_MAX_ATTEMPTS_PER_REQUEST = 64;
const MAX_ATTEMPTS_PER_EPOCH = 20_000;
const MAX_RETAINED_EPOCHS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REGISTRY_KEY = Symbol.for("optimike.atomic-write-bridge.effect-fence.v1");

export type EffectFenceToken = {
  contractVersion: 1;
  epoch: string;
  attemptId: string;
};

export type EffectFenceRefusalReason =
  | "fence_required"
  | "fence_epoch_superseded"
  | "fence_revoked"
  | "fence_replayed";

export class EffectFenceRefused extends Error {
  readonly reason: EffectFenceRefusalReason;
  constructor(reason: EffectFenceRefusalReason) {
    super("The write attempt was refused by the effect fence before its effect.");
    this.reason = reason;
  }
}

export type EffectFenceVerdict =
  /** Inspection only: the attempt has not reached its effect point and still could. */
  | { verdict: "not_reached" }
  /** The attempt never passed its effect point and never will. */
  | { verdict: "revoked_before_effect" }
  /** The effect started and has not settled yet. */
  | { verdict: "effect_in_progress" }
  /** The effect started and settled; it may have changed the vault. */
  | { verdict: "effect_settled"; settledAgoMs: number }
  /** The epoch no longer exists in this realm: no handler can start it again. */
  | { verdict: "epoch_unknown" };

export type LegacyQuiescence = {
  requireFence: boolean;
  strictForMs: number | null;
  unfencedInFlight: number;
  quiescent: boolean;
};

type Attempt = { state: "consumed" | "settled" | "revoked"; at: number };

type EpochState = {
  epoch: string;
  closed: boolean;
  attempts: Map<string, Attempt>;
  fencedInFlight: number;
  unfencedInFlight: number;
};

export type EffectFenceRegistry = { epochs: EpochState[] };

/** One registry per renderer realm, shared by successive plugin instances. */
export function realmEffectFenceRegistry(): EffectFenceRegistry {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[REGISTRY_KEY] as EffectFenceRegistry | undefined;
  if (existing && Array.isArray(existing.epochs)) return existing;
  const created: EffectFenceRegistry = { epochs: [] };
  Object.defineProperty(host, REGISTRY_KEY, {
    value: created,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return created;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function parseEffectFenceToken(value: unknown): EffectFenceToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_effect_fence");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join("\0");
  if (
    keys !== ["attemptId", "contractVersion", "epoch"].join("\0") ||
    record.contractVersion !== EFFECT_FENCE_CONTRACT_VERSION ||
    !uuid(record.epoch) ||
    !uuid(record.attemptId)
  ) {
    throw new Error("invalid_effect_fence");
  }
  return {
    contractVersion: 1,
    epoch: record.epoch,
    attemptId: record.attemptId,
  };
}

export type EffectFenceOptions = {
  requireFence: () => boolean;
  now?: () => number;
  registry?: EffectFenceRegistry;
};

export class EffectFence {
  private readonly requireFence: () => boolean;
  private readonly now: () => number;
  private readonly registry: EffectFenceRegistry;
  private current: EpochState;
  private strictSince: number | undefined;
  private disposed = false;

  constructor(options: EffectFenceOptions) {
    this.requireFence = options.requireFence;
    this.now = options.now ?? Date.now;
    this.registry = options.registry ?? realmEffectFenceRegistry();
    this.current = this.open();
    this.strictSince = this.requireFence() ? this.now() : undefined;
  }

  get epoch(): string {
    return this.current.epoch;
  }

  /** Must be called whenever the Bridge setting changes. Turning the
   * requirement off restarts the quiescence wait on the next activation. */
  requireFenceChanged(): void {
    if (!this.requireFence()) this.strictSince = undefined;
    else this.strictSince ??= this.now();
  }

  capability() {
    const legacy = this.legacy();
    return {
      contractVersion: EFFECT_FENCE_CONTRACT_VERSION,
      supported: true as const,
      epoch: this.current.epoch,
      requireFence: legacy.requireFence,
      legacyQuiescent: legacy.quiescent,
    };
  }

  /**
   * Synchronous admission at the effect point. Returns the settle callback,
   * to call exactly when the effect has completed or failed. Throws
   * EffectFenceRefused when the attempt must not produce any effect.
   */
  enter(token: EffectFenceToken | undefined): () => void {
    const state = this.current;
    if (!token) {
      if (this.disposed || this.requireFence()) {
        throw new EffectFenceRefused("fence_required");
      }
      state.unfencedInFlight += 1;
      return this.once(() => {
        state.unfencedInFlight -= 1;
        this.prune();
      });
    }
    if (this.disposed || state.closed || token.epoch !== state.epoch) {
      throw new EffectFenceRefused("fence_epoch_superseded");
    }
    const existing = state.attempts.get(token.attemptId);
    if (existing?.state === "revoked") {
      throw new EffectFenceRefused("fence_revoked");
    }
    if (existing) throw new EffectFenceRefused("fence_replayed");
    const attempt: Attempt = { state: "consumed", at: this.now() };
    state.attempts.set(token.attemptId, attempt);
    state.fencedInFlight += 1;
    if (state.attempts.size >= MAX_ATTEMPTS_PER_EPOCH) this.rotate();
    return this.once(() => {
      attempt.state = "settled";
      attempt.at = this.now();
      state.fencedInFlight -= 1;
      this.prune();
    });
  }

  /**
   * Inspect or revoke one attempt. Revocation is irreversible: an attempt
   * that has not reached its effect point can never reach it afterwards.
   */
  resolve(
    token: Pick<EffectFenceToken, "epoch" | "attemptId">,
    mode: "inspect" | "revoke",
  ): EffectFenceVerdict {
    const state = this.registry.epochs.find((item) => item.epoch === token.epoch);
    if (!state) return { verdict: "epoch_unknown" };
    const attempt = state.attempts.get(token.attemptId);
    if (!attempt) {
      if (mode === "inspect") {
        return state.closed || state !== this.current || this.disposed
          ? { verdict: "revoked_before_effect" }
          : { verdict: "not_reached" };
      }
      state.attempts.set(token.attemptId, { state: "revoked", at: this.now() });
      return { verdict: "revoked_before_effect" };
    }
    if (attempt.state === "revoked") return { verdict: "revoked_before_effect" };
    if (attempt.state === "consumed") return { verdict: "effect_in_progress" };
    return {
      verdict: "effect_settled",
      settledAgoMs: Math.max(0, this.now() - attempt.at),
    };
  }

  /**
   * Realm-wide proof for attempts that carried no token: true only when the
   * requirement has been continuously active long enough and no unfenced
   * effect admitted by any plugin instance of this realm is still running.
   */
  legacy(): LegacyQuiescence {
    const requireFence = !this.disposed && this.requireFence();
    const strictForMs =
      requireFence && this.strictSince !== undefined
        ? Math.max(0, this.now() - this.strictSince)
        : null;
    const unfencedInFlight = this.registry.epochs.reduce(
      (total, state) => total + state.unfencedInFlight,
      0,
    );
    return {
      requireFence,
      strictForMs,
      unfencedInFlight,
      quiescent:
        requireFence &&
        strictForMs !== null &&
        strictForMs >= LEGACY_QUIESCENCE_MS &&
        unfencedInFlight === 0,
    };
  }

  /** Plugin unload: pending handlers of this instance can no longer pass an effect point. */
  dispose(): void {
    this.disposed = true;
    this.current.closed = true;
    this.prune();
  }

  private open(): EpochState {
    const state: EpochState = {
      epoch: randomUUID(),
      closed: false,
      attempts: new Map(),
      fencedInFlight: 0,
      unfencedInFlight: 0,
    };
    this.registry.epochs.push(state);
    this.prune();
    return state;
  }

  private rotate(): void {
    this.current.closed = true;
    this.current = this.open();
  }

  /** Forget only closed epochs without running effects; their tokens stay
   * refused because no active fence accepts their epoch. */
  private prune(): void {
    const epochs = this.registry.epochs;
    while (epochs.length > MAX_RETAINED_EPOCHS) {
      const index = epochs.findIndex(
        (state) =>
          state.closed &&
          state.fencedInFlight === 0 &&
          state.unfencedInFlight === 0,
      );
      if (index < 0) return;
      epochs.splice(index, 1);
    }
  }

  private once(callback: () => void): () => void {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      callback();
    };
  }
}
