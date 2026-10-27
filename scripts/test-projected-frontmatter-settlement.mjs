import assert from "node:assert/strict";
import { resolveModifiedTimeSettlement as resolve } from "../dist/services/operations/modifiedTimeSettlement.js";

const expected = '---\ncréation: 2026-08-01T09:00\nmodification: 2026-08-17T09:59\nstatut: "actif"\n---\nbody\n';
const dateOnly = expected.replace("modification: 2026-08-17T09:59", "modification: 2026-08-17T10:00");
const drift = dateOnly.replace('statut: "actif"', "statut: actif");
const policy = { contractVersion: 1, integrations: [{ pluginId: "frontmatter-date-manager", propertyName: "modification", settlementObservationDelayMs: 0 }], utcOffsetMinutes: 0 };
const window = { applyStartedAtEpochMs: Date.parse("2026-08-17T10:00:00Z"), settlementObservedAtEpochMs: Date.parse("2026-08-17T10:00:02Z") };
assert.ok(resolve(expected, dateOnly, policy, window));
assert.equal(resolve(expected, drift, policy, window), undefined, "targeted key representation drift must never settle");
assert.equal(resolve(expected, dateOnly.replace("body", "changed"), policy, window), undefined);
console.log("PASS: only qualified date lines may differ; targeted representation and body remain exact.");
