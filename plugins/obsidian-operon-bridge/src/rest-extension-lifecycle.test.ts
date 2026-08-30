import assert from "node:assert/strict";
import test from "node:test";
import { RestExtensionLifecycle } from "../../shared/restExtensionLifecycle.js";

function deterministicTimers() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    schedule(callback: () => void, delayMs: number): number {
      const id = nextId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancel(id: number): void {
      timers.delete(id);
    },
    runNext(): number {
      const entry = timers.entries().next().value as
        | [number, { callback: () => void; delayMs: number }]
        | undefined;
      assert.ok(entry, "expected one scheduled lifecycle probe");
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
      return timer.delayMs;
    },
    size(): number {
      return timers.size;
    },
  };
}

test("lifecycle keeps one bounded retry alive beyond the former timeout", () => {
  const timers = deterministicTimers();
  const lifecycle = new RestExtensionLifecycle<object>({
    probe: () => null,
    mount: () => assert.fail("an absent provider must not mount"),
    initialRetryMs: 100,
    maximumRetryMs: 800,
    readyProbeMs: 200,
    schedule: timers.schedule,
    cancel: (timer) => timers.cancel(timer as number),
  });

  lifecycle.start();
  assert.equal(lifecycle.snapshot().state, "unavailable");
  assert.equal(timers.size(), 1);
  const delays = Array.from({ length: 10 }, () => timers.runNext());
  assert.deepEqual(delays.slice(0, 5), [100, 200, 400, 800, 800]);
  assert.equal(delays.at(-1), 800);
  assert.equal(timers.size(), 1, "recursive backoff must own one timer only");
  lifecycle.stop();
  assert.equal(timers.size(), 0);
});

test("lifecycle mounts late, avoids duplicates, and remounts one new provider generation", () => {
  const timers = deterministicTimers();
  const first = {};
  const second = {};
  let provider: object | null = null;
  let mounts = 0;
  let cleanups = 0;
  const lifecycle = new RestExtensionLifecycle<object>({
    probe: () => provider,
    mount: () => {
      mounts += 1;
      return () => {
        cleanups += 1;
      };
    },
    schedule: timers.schedule,
    cancel: (timer) => timers.cancel(timer as number),
  });

  lifecycle.start();
  provider = first;
  timers.runNext();
  assert.equal(mounts, 1);
  assert.equal(lifecycle.snapshot().mountGeneration, 1);
  timers.runNext();
  assert.equal(mounts, 1, "the same provider must not duplicate routes");

  provider = null;
  timers.runNext();
  assert.equal(cleanups, 1);
  assert.equal(lifecycle.snapshot().unloadGeneration, 1);
  provider = second;
  timers.runNext();
  assert.equal(mounts, 2);
  assert.equal(lifecycle.snapshot().mountGeneration, 2);
  assert.equal(timers.size(), 1);

  lifecycle.stop();
  assert.equal(cleanups, 2);
  assert.equal(lifecycle.snapshot().unloadGeneration, 2);
  assert.equal(timers.size(), 0);
});

test("mount failures remain fail-closed and recover without overlapping timers", () => {
  const timers = deterministicTimers();
  const provider = {};
  let attempts = 0;
  const lifecycle = new RestExtensionLifecycle<object>({
    probe: () => provider,
    mount: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("private mount failure");
      return () => undefined;
    },
    schedule: timers.schedule,
    cancel: (timer) => timers.cancel(timer as number),
  });

  lifecycle.start();
  assert.equal(lifecycle.snapshot().state, "degraded");
  assert.equal(timers.size(), 1);
  timers.runNext();
  assert.equal(lifecycle.snapshot().state, "ready");
  assert.equal(lifecycle.snapshot().mountGeneration, 1);
  assert.equal(timers.size(), 1);
  lifecycle.stop();
});
