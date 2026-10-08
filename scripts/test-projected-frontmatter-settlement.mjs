import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {resolveProjectedFrontmatterSettlement as resolve} from "../dist/services/operations/projectedFrontmatterSettlement.js";
import {resolveModifiedTimeSettlement as strict} from "../dist/services/operations/modifiedTimeSettlement.js";
const expected='---\ncréation: 2026-08-01T09:00\nmodification: 2026-08-17T09:59\nunknown: preserve\nbench_unicode: "élysia ✅"\n---\nbody\n';
const observed=expected.replace('modification: 2026-08-17T09:59','modification: 2026-08-17T10:00').replace('bench_unicode: "élysia ✅"','bench_unicode: élysia ✅');
const policy={contractVersion:1,integrations:[{pluginId:"frontmatter-date-manager",propertyName:"modification",settlementObservationDelayMs:0}],utcOffsetMinutes:0};
const window={applyStartedAtEpochMs:Date.parse("2026-08-17T10:00:00Z"),settlementObservedAtEpochMs:Date.parse("2026-08-17T10:00:02Z")};
const projection={kind:"obsidian.text.patch",frontmatterProof:{changedKeys:["bench_unicode"]},normalizationProtectedFrontmatterKeys:["création","modification"],proof:{}};
assert.equal(strict(expected,observed,policy,window),undefined);
const proof=resolve(expected,observed,policy,window,projection);assert.ok(proof);assert.equal(proof.observedSha256,createHash("sha256").update(observed).digest("hex"));assert.deepEqual(proof.authorizedFrontmatterFormatKeys,["bench_unicode"]);
assert.ok(resolve(expected,observed,policy,window,{kind:"obsidian.frontmatter.patch",normalizationProtectedFrontmatterKeys:["création","modification"],proof:{changedKeys:["bench_unicode"]}}));
for(const changed of [observed.replace("élysia ✅","wrong"),observed.replace("unknown: preserve",'unknown: "preserve"'),observed.replace("body","concurrent"),observed.replace("création: 2026-08-01T09:00","création: 2026-08-02T09:00"),observed.replace("bench_unicode: élysia ✅","bench_unicode: 42"),observed.replace("unknown: preserve","unknown: changed"),observed.replace("modification: 2026-08-17T10:00","modification: 2026-08-17T09:59"),observed.replace("bench_unicode: élysia ✅","bench_unicode: élysia ✅\nbench_unicode: other")])assert.equal(resolve(expected,changed,policy,window,projection),undefined);
assert.equal(resolve(expected,observed,policy,window,undefined),undefined);
assert.equal(resolve(expected,observed,policy,window,{kind:"obsidian.note.replace",proof:{changedKeys:["bench_unicode"]}}),undefined);
assert.equal(resolve(expected,observed,policy,window,{kind:"obsidian.text.patch",proof:{}}),undefined);
const typedExpected=expected.replace('bench_unicode: "élysia ✅"','bench_unicode: "42"');const typedObserved=observed.replace("bench_unicode: élysia ✅","bench_unicode: 42");assert.equal(resolve(typedExpected,typedObserved,policy,window,projection),undefined,"YAML scalar type changes must fail");
const removedExpected=expected.replace('bench_unicode: "élysia ✅"\n','');assert.equal(resolve(removedExpected,observed,policy,window,projection),undefined,"deleted authorized keys cannot reappear");
console.log("PASS authorized formatting only: unchanged YAML values, exact outside source, valid date window; other drift/type/duplicate/delete/raw surfaces refused.");

assert.equal(resolve(expected,observed,policy,window,{...projection,normalizationProtectedFrontmatterKeys:undefined}),undefined,"older plans cannot infer normalization permissions");
assert.equal(resolve(expected,observed,policy,window,{...projection,normalizationProtectedFrontmatterKeys:["bench_unicode"]}),undefined,"a dynamically protected key cannot be normalized, even to an equal YAML value");

const collectionExpected=expected.replace('bench_unicode: "élysia ✅"','bench_unicode: {"accent":"élysia","liste":["un","deux"]}');
const collectionObserved=observed.replace("bench_unicode: élysia ✅","bench_unicode:\n  accent: élysia\n  liste:\n    - un\n    - deux");
assert.ok(resolve(collectionExpected,collectionObserved,policy,window,projection),"authorized collection representation may change while its parsed value stays identical");
