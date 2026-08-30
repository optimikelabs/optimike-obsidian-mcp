#!/usr/bin/env node

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runCanaryCommand } from "./smoke-bridge-lifecycle-live.mjs";

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
    terminateOnTimeout: true,
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
  "PASS: a timed-out Local REST disable is terminated and remains restoration-fenced",
);
