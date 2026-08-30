#!/usr/bin/env node

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import {
  runCanaryCommand,
  waitForHealthyBaseline,
} from "./smoke-bridge-lifecycle-live.mjs";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills = 0;
  unrefs = 0;

  kill() {
    this.kills += 1;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }

  unref() {
    this.unrefs += 1;
  }
}

const child = new FakeChild();
await assert.rejects(
  runCanaryCommand("fixture", [], "destructive fixture", 10, {
    spawnProcess: () => child,
  }),
  /timed out and was terminated/u,
);
assert.equal(child.kills, 1, "the timed-out mutating CLI must be terminated");
assert.equal(
  child.unrefs,
  0,
  "the canary must not abandon a mutating CLI that can complete later",
);

const defaultChild = new FakeChild();
await assert.rejects(
  runCanaryCommand("fixture", [], "default fixture", 10, {
    spawnProcess: () => defaultChild,
  }),
  /timed out and was terminated/u,
);
assert.equal(
  defaultChild.kills,
  1,
  "build and git subprocesses must share the terminating timeout policy",
);

let routeAttempts = 0;
let fakeNow = 0;
const healthy = await waitForHealthyBaseline("fixture", "redacted", 60_000, {
  waitForRoutesImpl: async () => {
    routeAttempts += 1;
    if (routeAttempts < 3) throw new Error("route still mounting");
    return { "optimike-operon-bridge": { ok: true } };
  },
  now: () => fakeNow,
  sleepImpl: async (delayMs) => {
    fakeNow += delayMs;
  },
});
assert.equal(healthy["optimike-operon-bridge"].ok, true);
assert.equal(
  routeAttempts,
  3,
  "the healthy-baseline gate must retry inner route timeouts",
);

const source = await readFile(
  new URL("./smoke-bridge-lifecycle-live.mjs", import.meta.url),
  "utf8",
);
const armedAt = source.indexOf("localRestRestoreRequired = true;");
const disableAt = source.indexOf(
  "await app.plugins.disablePlugin('obsidian-local-rest-api')",
);
assert.ok(
  armedAt >= 0 && disableAt > armedAt,
  "restore must arm before disable",
);
assert.match(source, /if \(localRestRestoreRequired\)/u);
assert.match(source, /await waitForRoutes\(baseUrl, apiKey\)/u);

console.log(
  "PASS: canary subprocesses terminate, baseline retries, and restoration remains fenced",
);
