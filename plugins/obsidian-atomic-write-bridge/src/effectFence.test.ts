import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EffectFence,
  EffectFenceRefused,
  LEGACY_QUIESCENCE_MS,
  parseEffectFenceToken,
  type EffectFenceRegistry,
} from "./effectFence.js";

const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-9999-aaaaaaaaaaaa";

function fixture(requireFence = false) {
  let now = 1_000;
  let strict = requireFence;
  const registry: EffectFenceRegistry = { epochs: [] };
  const fence = new EffectFence({ requireFence: () => strict, now: () => now, registry });
  return {
    fence,
    registry,
    advance: (ms: number) => { now += ms; },
    setStrict(value: boolean) { strict = value; fence.requireFenceChanged(); },
    token: (attemptId = ATTEMPT, epoch = fence.epoch) => ({ contractVersion: 1 as const, epoch, attemptId }),
  };
}

function refused(run: () => unknown, reason: string) {
  assert.throws(run, (error: unknown) => error instanceof EffectFenceRefused && error.reason === reason);
}

test("revocation before the effect point refuses the attempt forever", () => {
  const f = fixture();
  assert.deepEqual(f.fence.resolve(f.token(), "inspect"), { verdict: "not_reached" });
  assert.deepEqual(f.fence.resolve(f.token(), "revoke"), { verdict: "revoked_before_effect" });
  refused(() => f.fence.enter(f.token()), "fence_revoked");
  assert.deepEqual(f.fence.resolve(f.token(), "revoke"), { verdict: "revoked_before_effect" });
});

test("an attempt that passed the effect point reports progress, then settlement age", () => {
  const f = fixture();
  const settle = f.fence.enter(f.token());
  assert.deepEqual(f.fence.resolve(f.token(), "revoke"), { verdict: "effect_in_progress" });
  f.advance(10);
  settle();
  settle();
  f.advance(250);
  assert.deepEqual(f.fence.resolve(f.token(), "revoke"), { verdict: "effect_settled", settledAgoMs: 250 });
  refused(() => f.fence.enter(f.token()), "fence_replayed");
});

test("a superseded epoch never passes the effect point and is reported as such", () => {
  const f = fixture();
  const stale = f.token();
  f.fence.dispose();
  refused(() => f.fence.enter(stale), "fence_epoch_superseded");
  assert.deepEqual(f.fence.resolve(stale, "inspect"), { verdict: "revoked_before_effect" });
  const next = new EffectFence({ requireFence: () => false, registry: f.registry });
  refused(() => next.enter(stale), "fence_epoch_superseded");
  assert.deepEqual(next.resolve(stale, "revoke"), { verdict: "revoked_before_effect" });
  assert.deepEqual(next.resolve({ epoch: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", attemptId: OTHER }, "revoke"), { verdict: "epoch_unknown" });
});

test("unfenced effects are tracked and refused once the requirement is active", () => {
  const f = fixture();
  const settle = f.fence.enter(undefined);
  f.setStrict(true);
  refused(() => f.fence.enter(undefined), "fence_required");
  f.advance(LEGACY_QUIESCENCE_MS);
  assert.equal(f.fence.legacy().unfencedInFlight, 1);
  assert.equal(f.fence.legacy().quiescent, false);
  settle();
  assert.deepEqual(f.fence.legacy(), { requireFence: true, strictForMs: LEGACY_QUIESCENCE_MS, unfencedInFlight: 0, quiescent: true });
  f.setStrict(false);
  assert.equal(f.fence.legacy().quiescent, false);
  f.setStrict(true);
  assert.equal(f.fence.legacy().strictForMs, 0);
});

test("legacy quiescence waits for in-flight unfenced effects of earlier instances", () => {
  const f = fixture();
  const settle = f.fence.enter(undefined);
  f.fence.dispose();
  const next = new EffectFence({ requireFence: () => true, registry: f.registry, now: () => 5_000_000 });
  assert.equal(next.legacy().unfencedInFlight, 1);
  settle();
  assert.equal(next.legacy().unfencedInFlight, 0);
});

test("tokens are strict and closed", () => {
  const f = fixture();
  assert.deepEqual(parseEffectFenceToken(f.token()), f.token());
  for (const bad of [null, [], {}, { ...f.token(), extra: 1 }, { ...f.token(), contractVersion: 2 }, { ...f.token(), epoch: "x" }, { ...f.token(), attemptId: "X".repeat(36) }]) {
    assert.throws(() => parseEffectFenceToken(bad), /invalid_effect_fence/);
  }
});
