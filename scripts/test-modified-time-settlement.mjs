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
      settlementObservationDelayMs: 0,
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

const missingPropertyExpected = [
  "---",
  "statut: actif",
  "---",
  "contenu",
  "",
].join("\n");
const insertionCases = [
  {
    pluginId: "frontmatter-date-manager",
    propertyName: "changed_by_fdm",
    timestamp: "2026-08-17T10:00",
    newline: "\n",
  },
  {
    pluginId: "update-time",
    propertyName: "lastChanged",
    timestamp: "2026-08-17T10:00:01",
    newline: "\n",
  },
  {
    pluginId: "update-time-on-edit",
    propertyName: "edited-at",
    timestamp: "2026-08-17T10:00",
    newline: "\r\n",
  },
];

for (const insertionCase of insertionCases) {
  const expectedForCase = missingPropertyExpected.replaceAll(
    "\n",
    insertionCase.newline,
  );
  const insertedLine = `${insertionCase.propertyName}: ${insertionCase.timestamp}`;
  const observedForCase = expectedForCase.replace(
    `statut: actif${insertionCase.newline}`,
    `statut: actif${insertionCase.newline}${insertedLine}${insertionCase.newline}`,
  );
  const dynamicPolicy = {
    contractVersion: 1,
    integrations: [
      {
        pluginId: insertionCase.pluginId,
        propertyName: insertionCase.propertyName,
        settlementObservationDelayMs: 0,
      },
    ],
    utcOffsetMinutes: 0,
  };
  const evidence = resolveModifiedTimeSettlement(
    expectedForCase,
    observedForCase,
    dynamicPolicy,
    window,
  );
  assert.equal(evidence?.pluginId, insertionCase.pluginId);
  assert.equal(evidence?.propertyName, insertionCase.propertyName);
}

const dynamicPolicy = {
  contractVersion: 1,
  integrations: [
    {
      pluginId: "frontmatter-date-manager",
      propertyName: "customModified",
      settlementObservationDelayMs: 0,
    },
  ],
  utcOffsetMinutes: 0,
};
const validInserted = missingPropertyExpected.replace(
  "statut: actif\n",
  "statut: actif\ncustomModified: 2026-08-17T10:00\n",
);
const insertionRejections = [
  validInserted.replace("contenu", "édition concurrente"),
  validInserted.replace("statut: actif", "statut: concurrent"),
  validInserted.replace(
    "customModified: 2026-08-17T10:00",
    "customModified: 2026-08-17T10:00\nautre: dérive",
  ),
  missingPropertyExpected.replace(
    "---\ncontenu",
    "---\ncustomModified: 2026-08-17T10:00\ncontenu",
  ),
  validInserted.replace("customModified:", "wrongModified:"),
  validInserted.replace("2026-08-17T10:00", "2026-08-17T09:59"),
  validInserted.replace("2026-08-17T10:00", "2026-08-17T10:00:03"),
  validInserted.replace("2026-08-17T10:00", "2026-02-30T10:00"),
  validInserted.replace("customModified:", "  customModified:"),
  validInserted.replace(
    "customModified: 2026-08-17T10:00",
    "customModified: 2026-08-17T10:00\ncustomModified: 2026-08-17T10:00",
  ),
  validInserted.replace(
    "customModified: 2026-08-17T10:00",
    "création: 2026-08-17T10:00\ncustomModified: 2026-08-17T10:00",
  ),
  validInserted.replace(
    "customModified: 2026-08-17T10:00",
    "lastViewed: 2026-08-17T10:00\ncustomModified: 2026-08-17T10:00",
  ),
];
for (const rejected of insertionRejections) {
  assert.equal(
    resolveModifiedTimeSettlement(
      missingPropertyExpected,
      rejected,
      dynamicPolicy,
      window,
    ),
    undefined,
  );
}

console.log(
  "PASS: modified-time settlement admits one bounded configured timestamp replacement or insertion and rejects all unrelated drift.",
);
