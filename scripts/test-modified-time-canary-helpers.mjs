import assert from "node:assert/strict";
import {
  assertAtomicNoteCanaryDateIsolation,
  isSafeModifiedTimePropertyName,
  modifiedTimeFrontmatterPropertyValue,
  nextRepresentableTimestampReadyAt,
  supportsModifiedTimeSettlementBridgeVersion,
} from "./modified-time-canary-helpers.mjs";

assert.equal(supportsModifiedTimeSettlementBridgeVersion("0.3.0"), true);
assert.equal(supportsModifiedTimeSettlementBridgeVersion("0.4.0"), true);
assert.equal(supportsModifiedTimeSettlementBridgeVersion("1.0.0"), true);
assert.equal(supportsModifiedTimeSettlementBridgeVersion("0.2.9"), false);
assert.equal(
  supportsModifiedTimeSettlementBridgeVersion("0.3.0-beta.1"),
  false,
);
assert.equal(supportsModifiedTimeSettlementBridgeVersion("invalid"), false);

assert.doesNotThrow(() =>
  assertAtomicNoteCanaryDateIsolation({ settlement: undefined }),
);
assert.throws(
  () =>
    assertAtomicNoteCanaryDateIsolation({
      settlement: {
        modifiedTimeFrontmatter: {
          integrations: [
            {
              pluginId: "frontmatter-date-manager",
              propertyName: "modification",
            },
          ],
        },
      },
    }),
  /requires active modified-time integrations to be disabled before mutation \(frontmatter-date-manager:modification\)/u,
);

assert.equal(isSafeModifiedTimePropertyName("modification"), true);
assert.equal(isSafeModifiedTimePropertyName("last modified"), true);
assert.equal(isSafeModifiedTimePropertyName("modified.at"), true);
assert.equal(isSafeModifiedTimePropertyName("création date"), true);
assert.equal(isSafeModifiedTimePropertyName("version2"), true);
assert.equal(isSafeModifiedTimePropertyName(" modified"), false);
assert.equal(isSafeModifiedTimePropertyName("modified "), false);
assert.equal(isSafeModifiedTimePropertyName("modified:at"), false);
assert.equal(isSafeModifiedTimePropertyName("modified,time"), false);
assert.equal(isSafeModifiedTimePropertyName("#modified"), false);
assert.equal(isSafeModifiedTimePropertyName("modified/key"), false);
assert.equal(isSafeModifiedTimePropertyName("123"), false);
assert.equal(isSafeModifiedTimePropertyName("true"), false);
assert.equal(isSafeModifiedTimePropertyName("modified\nat"), false);
assert.equal(isSafeModifiedTimePropertyName("x".repeat(129)), false);

assert.equal(
  modifiedTimeFrontmatterPropertyValue(
    "---\r\nmodification: 2026-08-17T12:34:20\r\ntitle: Canary\r\n---\r\n\r\nmodification: ordinary body text\r\n",
    "modification",
  ),
  "2026-08-17T12:34:20",
  "a body line that resembles the property must not affect frontmatter scope",
);
assert.throws(
  () =>
    modifiedTimeFrontmatterPropertyValue(
      "---\nmodification: first\nmodification: second\n---\n",
      "modification",
    ),
  /exactly one top-level modification frontmatter property/u,
);
assert.throws(
  () =>
    modifiedTimeFrontmatterPropertyValue(
      "---\ntitle: missing\n---\nmodification: body only\n",
      "modification",
    ),
  /exactly one top-level modification frontmatter property/u,
);

const offsetMinutes = 120;
const minuteValue = "2026-08-17T12:34";
const minuteEpoch = Date.UTC(2026, 7, 17, 10, 34, 0);
assert.equal(
  nextRepresentableTimestampReadyAt(minuteValue, offsetMinutes),
  minuteEpoch + 60_000 + 5_200,
  "minute precision must cross the next minute boundary and freshness margin",
);

const secondValue = "2026-08-17T12:34:20";
const secondEpoch = Date.UTC(2026, 7, 17, 10, 34, 20);
assert.equal(
  nextRepresentableTimestampReadyAt(secondValue, offsetMinutes),
  secondEpoch + 1_000 + 5_200,
  "second precision must cross its next tick and the plugin freshness margin",
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
