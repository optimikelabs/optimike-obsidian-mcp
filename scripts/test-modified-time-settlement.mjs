import assert from "node:assert/strict";
import { resolveModifiedTimeSettlement } from "../dist/services/operations/modifiedTimeSettlement.js";

const expected = [
  "---",
  "création: 2026-08-01T09:00",
  "modification: 2026-08-17T09:59",
  "statut: actif",
  "---",
  "contenu",
  "",
].join("\n");
const policy = {
  contractVersion: 1,
  integrations: [
    {
      pluginId: "frontmatter-date-manager",
      propertyName: "modification",
    },
  ],
  utcOffsetMinutes: 0,
};
const window = {
  applyStartedAtEpochMs: Date.parse("2026-08-17T10:00:00.000Z"),
  settlementObservedAtEpochMs: Date.parse("2026-08-17T10:00:02.000Z"),
};

const observed = expected.replace(
  "modification: 2026-08-17T09:59",
  "modification: 2026-08-17T10:00",
);
const accepted = resolveModifiedTimeSettlement(
  expected,
  observed,
  policy,
  window,
);
assert.equal(accepted?.propertyName, "modification");
assert.equal(accepted?.pluginId, "frontmatter-date-manager");

for (const rejected of [
  observed.replace("statut: actif", "statut: concurrent"),
  observed.replace("contenu", "édition concurrente"),
  observed.replace(
    "modification: 2026-08-17T10:00",
    "modification: 2026-08-17T09:58",
  ),
  observed.replace("modification: 2026-08-17T10:00", "modification: demain"),
]) {
  assert.equal(
    resolveModifiedTimeSettlement(expected, rejected, policy, window),
    undefined,
  );
}

const duplicateExpected = expected.replace(
  "statut: actif",
  "modification: 2026-08-17T09:58\nstatut: actif",
);
assert.equal(
  resolveModifiedTimeSettlement(
    duplicateExpected,
    duplicateExpected.replace(
      "modification: 2026-08-17T09:59",
      "modification: 2026-08-17T10:00",
    ),
    policy,
    window,
  ),
  undefined,
);

const emptyDuplicateExpected = expected.replace(
  "statut: actif",
  "modification:\nstatut: actif",
);
assert.equal(
  resolveModifiedTimeSettlement(
    emptyDuplicateExpected,
    emptyDuplicateExpected.replace(
      "modification: 2026-08-17T09:59",
      "modification: 2026-08-17T10:00",
    ),
    policy,
    window,
  ),
  undefined,
  "an empty duplicate configured property must also fail closed",
);

assert.equal(
  resolveModifiedTimeSettlement(expected, observed, policy, {
    ...window,
    settlementObservedAtEpochMs: Date.parse("2026-08-17T10:06:00.000Z"),
  }),
  undefined,
  "settlement outside the five-minute apply window must remain unverified",
);

assert.equal(
  resolveModifiedTimeSettlement(expected, observed, policy, {
    ...window,
    applyStartedAtEpochMs: Date.parse("2026-08-17T10:01:00.000Z"),
  }),
  undefined,
  "a timestamp before the actual apply window must remain unverified",
);

const crlfExpected = expected.replaceAll("\n", "\r\n");
const crlfObserved = observed.replaceAll("\n", "\r\n");
assert.equal(
  resolveModifiedTimeSettlement(crlfExpected, crlfObserved, policy, window)
    ?.propertyName,
  "modification",
);

console.log(
  "PASS: modified-time settlement admits one bounded configured timestamp and rejects all unrelated drift.",
);
