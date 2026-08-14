import assert from "node:assert/strict";

const STABLE_TERMINAL = new Set([
  "committed",
  "conflict",
  "rejected",
  "failed",
  "expired",
  "compensated",
]);

function clone(value) {
  return structuredClone(value);
}

function tokenKey(token) {
  return `${token.owner}:${token.epoch}`;
}

/**
 * Pure executable model for the authority rules shared by governed
 * single-resource operations. It models durable authority, not transport or
 * implementation details.
 */
export class GovernedSingleResourceModel {
  constructor() {
    this.status = "planned";
    this.owner = undefined;
    this.epoch = 0;
    this.physical = "before";
    this.effectCount = 0;
    this.sentAttempts = new Set();
    this.completedEffects = new Set();
    this.history = [];
  }

  snapshot() {
    return {
      status: this.status,
      owner: this.owner ? clone(this.owner) : undefined,
      epoch: this.epoch,
      physical: this.physical,
      effectCount: this.effectCount,
      sentAttempts: [...this.sentAttempts],
      completedEffects: [...this.completedEffects],
      history: clone(this.history),
    };
  }

  claim(owner, expected = ["planned", "outcome_unknown"]) {
    assert.equal(
      expected.includes(this.status),
      true,
      `cannot claim ${this.status}`,
    );
    this.epoch += 1;
    const token = { owner, epoch: this.epoch };
    this.owner = token;
    this.status = "applying";
    this.history.push({ event: "claim", token: clone(token) });
    return clone(token);
  }

  backendSend(token) {
    this.#requireCurrent(token);
    const key = tokenKey(token);
    assert.equal(
      this.sentAttempts.has(key),
      false,
      "one attempt cannot send the backend request twice",
    );
    this.sentAttempts.add(key);
    this.history.push({ event: "backendSend", token: clone(token) });
  }

  expire(token) {
    this.#requireCurrent(token);
    this.status = "outcome_unknown";
    this.owner = undefined;
    this.history.push({ event: "expire", token: clone(token) });
  }

  /**
   * An already-sent backend call may still produce the physical effect after
   * its durable authority expires. Fencing prevents a stale terminal write; it
   * cannot recall an external request already in flight.
   */
  backendEffect(token) {
    const key = tokenKey(token);
    assert.equal(
      this.sentAttempts.has(key),
      true,
      "a backend effect requires a previously sent request",
    );
    assert.equal(
      this.completedEffects.has(key),
      false,
      "one attempt cannot complete the effect twice",
    );
    this.completedEffects.add(key);
    this.effectCount += 1;
    this.physical = "after";
    this.history.push({ event: "backendEffect", token: clone(token) });
  }

  thirdPartyEdit() {
    this.physical = "third";
    this.history.push({ event: "thirdPartyEdit" });
  }

  terminalize(token, outcome, proof) {
    this.#requireCurrent(token);
    assert.equal(this.status, "applying");
    assert.equal(STABLE_TERMINAL.has(outcome), true);

    if (outcome === "committed") {
      assert.equal(proof, "sealed-after");
      assert.equal(this.physical, "after");
    } else {
      assert.equal(
        proof,
        "effect-excluded",
        `${outcome} requires proof excluding the intended effect`,
      );
      assert.equal(this.physical, "before");
      assert.equal(
        this.sentAttempts.has(tokenKey(token)),
        false,
        `${outcome} cannot exclude an already-sent backend request`,
      );
    }

    this.status = outcome;
    this.owner = undefined;
    this.history.push({
      event: "terminalize",
      token: clone(token),
      outcome,
      proof,
    });
  }

  /**
   * Status is an observer call. The reconciler acts under protocol authority:
   * it may prove the sealed after state, but cannot borrow executor authority
   * to invent a negative terminal result.
   */
  reconcile() {
    if (STABLE_TERMINAL.has(this.status)) return this.status;
    if (this.physical === "after") {
      this.status = "committed";
      this.owner = undefined;
      this.history.push({ event: "reconcile", proof: "sealed-after" });
      return this.status;
    }
    if (this.status === "outcome_unknown" || this.physical === "third") {
      this.status = "outcome_unknown";
      this.owner = undefined;
      this.history.push({ event: "reconcile", proof: "insufficient" });
      return this.status;
    }
    this.history.push({ event: "reconcile", proof: "none" });
    return this.status;
  }

  observerCannotTerminalize(outcome) {
    assert.throws(
      () =>
        this.terminalize(
          { owner: "observer", epoch: -1 },
          outcome,
          "effect-excluded",
        ),
      /stale or unauthorized attempt/,
    );
  }

  #requireCurrent(token) {
    assert.ok(this.owner, "no executor owns the operation");
    assert.deepEqual(
      token,
      this.owner,
      "stale or unauthorized attempt cannot transition durable state",
    );
  }
}

/**
 * Pure model for P1 admission. The atomic map stands for the unique P0 journal
 * key. Source and binding checks happen only when no durable winner exists.
 */
export class FrontmatterAdmissionModel {
  constructor() {
    this.plans = new Map();
    this.nextId = 1;
  }

  prepare({ key, intentDigest, compiledSource, compiledBinding, afterDigest }) {
    return {
      key,
      intentDigest,
      compiledSource,
      compiledBinding,
      afterDigest,
    };
  }

  commit(candidate, live) {
    const existing = this.plans.get(candidate.key);
    if (existing) {
      assert.equal(
        existing.intentDigest,
        candidate.intentDigest,
        "same idempotency key cannot bind a different intent",
      );
      return { kind: "winner", plan: clone(existing), inserted: false };
    }

    assert.equal(
      live.source,
      candidate.compiledSource,
      "source drift prevents durable admission",
    );
    assert.equal(
      live.binding,
      candidate.compiledBinding,
      "backend drift prevents durable admission",
    );

    const plan = {
      id: `plan-${this.nextId++}`,
      key: candidate.key,
      intentDigest: candidate.intentDigest,
      beforeDigest: candidate.compiledSource,
      binding: candidate.compiledBinding,
      afterDigest: candidate.afterDigest,
    };
    this.plans.set(candidate.key, plan);
    return { kind: "winner", plan: clone(plan), inserted: true };
  }

  get(key) {
    const plan = this.plans.get(key);
    return plan ? clone(plan) : undefined;
  }
}
