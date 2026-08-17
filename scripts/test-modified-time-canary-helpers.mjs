import assert from "node:assert/strict";
import {
  isSafeModifiedTimePropertyName,
  nextRepresentableTimestampReadyAt,
} from "./modified-time-canary-helpers.mjs";

assert.equal(isSafeModifiedTimePropertyName("modification"), true);
assert.equal(isSafeModifiedTimePropertyName("last modified"), true);
assert.equal(isSafeModifiedTimePropertyName("modified.at"), true);
assert.equal(isSafeModifiedTimePropertyName(" modified"), false);
assert.equal(isSafeModifiedTimePropertyName("modified "), false);
assert.equal(isSafeModifiedTimePropertyName("modified:at"), false);
assert.equal(isSafeModifiedTimePropertyName("modified\nat"), false);
assert.equal(isSafeModifiedTimePropertyName("x".repeat(129)), false);

const offsetMinutes = 120;
const minuteValue = "2026-08-17T12:34";
const minuteEpoch = Date.UTC(2026, 7, 17, 10, 34, 0);
assert.equal(
  nextRepresentableTimestampReadyAt(minuteValue, offsetMinutes),
  minuteEpoch + 60_000,
  "minute precision must wait for the next minute boundary",
);

const secondValue = "2026-08-17T12:34:20";
const secondEpoch = Date.UTC(2026, 7, 17, 10, 34, 20);
assert.equal(
  nextRepresentableTimestampReadyAt(secondValue, offsetMinutes),
  secondEpoch + 5_200,
  "second precision must still cross the supported plugin freshness window",
);

assert.throws(
  () => nextRepresentableTimestampReadyAt("2026-02-30T12:00", 0),
  /real datetime/u,
);
assert.throws(
  () => nextRepresentableTimestampReadyAt(minuteValue, 15 * 60),
  /UTC offset/u,
);

console.log(
  "PASS: modified-time live canary accepts the Bridge property-name contract and waits for minute/second timestamp ticks.",
);
