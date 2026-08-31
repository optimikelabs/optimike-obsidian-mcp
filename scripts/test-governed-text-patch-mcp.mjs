#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

// Keep this test focused on the P4 projection. The fake below is the smallest
// useful Atomic Write/Note Replace seam: the production compiler, projection
// runtime, quartet registrations, MCP SDK validation, and public error mapper
// all remain real.
process.env.MCP_WRITE_MODE = "full";
process.env.MCP_PROTECTED_FRONTMATTER_KEYS = "création,modification";
process.env.MCP_GUARDED_MAX_WRITE_CHARS = "100000";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "test-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:27123";
process.env.OBSIDIAN_VERIFY_SSL = "false";
mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
const testRoot = mkdtempSync(path.join(process.cwd(), ".tmp", "text-patch-test-"));
process.env.MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH = path.join(
  testRoot,
  "governed-text-patch.sqlite",
);

const { InMemoryTransport } = await import(
  "@modelcontextprotocol/sdk/inMemory.js"
);
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerGovernedTextPatchTools } = await import(
  "../src/mcp-server/tools/governedTextPatchTools/registration.ts"
).catch(async () =>
  import("../dist/mcp-server/tools/governedTextPatchTools/registration.js")
);
const { GovernedTextPatchRuntime } = await import(
  "../src/services/textPatchProjectionRuntime.ts"
).catch(async () => import("../dist/services/textPatchProjectionRuntime.js"));

const FIXTURE_PATH = "Fixture/Governed Text Patch.md";
const PROTECTED = "création: 2026-08-13";
const INITIAL = `---\n${PROTECTED}\nstatut: actif\n---\nalpha\nneedle\nomega\n`;
const SECRET = "sealed-text-patch-MUST-NOT-LEAK-9d2f";
const PUBLIC_MESSAGES = {
  VALIDATION_ERROR: "The request could not be validated.",
  FORBIDDEN: "This request is not authorized.",
  CONFLICT: "The request conflicts with the current resource state.",
  NOT_FOUND: "The requested resource was not found.",
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function body(label) {
  return `---\n${PROTECTED}\nstatut: actif\n---\n${label}\n`;
}

function childRef(id) {
  return `obsidian-note-replace:v1:${id}`;
}

function parseId(reference) {
  return reference.slice(reference.lastIndexOf(":") + 1);
}

class FakeGovernedNoteReplaceRuntime {
  constructor() {
    this.reset();
  }

  reset(content = INITIAL) {
    this.content = content;
    this.cachedContent = content;
    this.bindingFingerprint = sha256("fake-atomic-write-vault");
    this.plans = new Map();
    this.byKey = new Map();
    this.casRequests = 0;
    this.successfulWrites = 0;
    this.liveReads = 0;
    this.failBeforeWriteNext = false;
    this.loseResponseAfterWriteNext = false;
    this.blocked = undefined;
  }

  async readForProjection(target) {
    assert.equal(target, FIXTURE_PATH);
    this.liveReads += 1;
    if (this.onNextProjectionRead) {
      const hook = this.onNextProjectionRead;
      this.onNextProjectionRead = undefined;
      await hook();
    }
    return {
      path: target,
      content: this.content,
      sha256: sha256(this.content),
      bindingFingerprint: this.bindingFingerprint,
    };
  }

  findPlanByIdempotencyKey(key) {
    const plan = this.byKey.get(key);
    return plan && this.view(plan);
  }

  inspect(reference) {
    const plan = this.plans.get(parseId(reference));
    if (!plan) throw new Error("unknown fake plan");
    return this.view(plan);
  }

  async plan(input) {
    const id = randomUUID();
    const plan = {
      operationId: id,
      idempotencyKey: input.idempotencyKey,
      idempotencyIdentity: input.idempotencyIdentity,
      path: input.path,
      beforeSha256: input.expectedBeforeSha256 ?? sha256(this.content),
      afterSha256: sha256(input.nextContent),
      bindingFingerprint: input.expectedBindingFingerprint ?? this.bindingFingerprint,
      nextContent: input.nextContent,
      projection: input.projection,
      status: "planned",
    };
    this.plans.set(id, plan);
    this.byKey.set(input.idempotencyKey, plan);
    return this.receipt(plan);
  }

  async apply(reference, idempotencyKey) {
    const plan = this.required(reference, idempotencyKey);
    if (plan.status === "committed" || plan.status === "conflict" || plan.status === "rejected") {
      return this.receipt(plan);
    }
    if (plan.status === "applying" || plan.status === "outcome_unknown") {
      return this.receipt(plan);
    }
    plan.status = "applying";
    if (this.failBeforeWriteNext) {
      this.failBeforeWriteNext = false;
      plan.status = "outcome_unknown";
      return this.receipt(plan);
    }
    if (this.blocked) {
      const gate = this.blocked;
      this.blocked = undefined;
      gate.entered();
      await gate.released;
    }
    this.casRequests += 1;
    if (sha256(this.content) !== plan.beforeSha256) {
      plan.status = "conflict";
      return this.receipt(plan);
    }
    this.content = plan.nextContent;
    this.cachedContent = this.content;
    this.successfulWrites += 1;
    plan.status = "committed";
    // The write committed, but the caller loses the response. Status must
    // reconcile the durable receipt without issuing a second CAS.
    if (this.loseResponseAfterWriteNext) {
      this.loseResponseAfterWriteNext = false;
      throw new Error("simulated lost Atomic Write response");
    }
    return this.receipt(plan);
  }

  async status(reference) {
    return this.receipt(this.required(reference));
  }

  async recover(reference, idempotencyKey) {
    const plan = this.required(reference, idempotencyKey);
    if (plan.status === "outcome_unknown") {
      if (sha256(this.content) === plan.beforeSha256) {
        this.casRequests += 1;
        this.content = plan.nextContent;
        this.cachedContent = this.content;
        this.successfulWrites += 1;
        plan.status = "committed";
      } else if (sha256(this.content) === plan.afterSha256) {
        plan.status = "committed";
      } else {
        plan.status = "conflict";
      }
    }
    return this.receipt(plan);
  }

  blockNextCas() {
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const released = new Promise((resolve) => (releaseResolve = resolve));
    this.blocked = {
      entered: () => enteredResolve(),
      released,
      release: () => releaseResolve(),
    };
    return { entered, release: () => this.blocked?.release() ?? releaseResolve() };
  }

  required(reference, expectedKey) {
    const plan = this.plans.get(parseId(reference));
    if (!plan || (expectedKey !== undefined && plan.idempotencyKey !== expectedKey)) {
      throw new Error("unknown or mismatched fake plan");
    }
    return plan;
  }

  view(plan) {
    return {
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      idempotencyIdentity: plan.idempotencyIdentity,
      path: plan.path,
      beforeSha256: plan.beforeSha256,
      afterSha256: plan.afterSha256,
      bindingFingerprint: plan.bindingFingerprint,
      status: plan.status,
      projection: structuredClone(plan.projection),
    };
  }

  receipt(plan) {
    const phase = plan.status === "planned" ? "planned" : plan.status === "applying" ? "applying" : "terminal";
    const recoverable = plan.status === "applying" || plan.status === "outcome_unknown";
    return {
      contractVersion: 1,
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      operationKind: "obsidian.note.replace",
      planRef: childRef(plan.operationId),
      planDigest: sha256(`${plan.operationId}:${plan.afterSha256}`),
      phase,
      outcome: plan.status === "planned" || plan.status === "applying" ? null : plan.status,
      backend: { kind: "fake-atomic-write", bindingFingerprint: plan.bindingFingerprint },
      target: { kind: "vault-markdown-note", logicalRef: plan.path },
      beforeProof: { kind: "sha256", digest: plan.beforeSha256 },
      ...(plan.status === "committed" ? { afterProof: { kind: "sha256", digest: plan.afterSha256 } } : {}),
      postflight: { status: plan.status === "committed" ? "verified" : plan.status === "applying" ? "pending" : phase === "terminal" ? "unverified" : "not_started" },
      admittedAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      recoveryAllowed: recoverable,
      applyAllowed: plan.status === "planned",
    };
  }
}

async function startClient(noteRuntime) {
  const server = new McpServer({ name: "governed-text-patch-test", version: "1.0.0" });
  await registerGovernedTextPatchTools(server, noteRuntime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "governed-text-patch-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: () => client.close().catch(() => undefined) };
}

const observed = [];
function parseResult(result) {
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return JSON.parse(text || "null");
}
async function call(session, name, args, expectedError = false) {
  try {
    const result = await session.client.callTool({ name, arguments: args });
    observed.push(JSON.stringify(result));
    assert.equal(Boolean(result.isError), expectedError, `${name} error status`);
    return { result, payload: parseResult(result) };
  } catch (error) {
    assert.equal(expectedError, true, `${name} unexpected transport error`);
    const text = String(error);
    observed.push(text);
    return { result: error, payload: { transportError: text } };
  }
}
function assertPublicError(payload, code, label) {
  assert.equal(payload.error.code, code, `${label} code`);
  assert.equal(payload.error.message, PUBLIC_MESSAGES[code], `${label} public message`);
  const requestId = payload.requestId ?? payload.error.details?.requestId;
  assert.match(requestId ?? "", UUID, `${label} request id`);
  assert.equal(payload.error.details?.requestId, requestId, `${label} request id details`);
}

const fake = new FakeGovernedNoteReplaceRuntime();
const first = await startClient(fake);
const second = await startClient(fake);
try {
  const listed = await first.client.listTools();
  const tools = listed.tools.filter((tool) => tool.name.startsWith("obsidian_text_patch_")).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(tools.map((tool) => tool.name), [
    "obsidian_text_patch_apply",
    "obsidian_text_patch_plan",
    "obsidian_text_patch_recover",
    "obsidian_text_patch_status",
  ]);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("obsidian_text_patch_plan")?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(byName.get("obsidian_text_patch_status")?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  for (const name of ["obsidian_text_patch_apply", "obsidian_text_patch_recover"]) assert.deepEqual(byName.get(name)?.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

  fake.reset();
  const operations = [
    { op: "prepend_body", text: "prefix\n" },
    { op: "replace_literal", search: "needle", replacement: "target" },
    { op: "append_body", text: "suffix\n" },
  ];
  const plan = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations, idempotencyKey: "nominal" });
  assert.equal(plan.payload.phase, "planned");
  assert.equal(plan.payload.operationKind, "obsidian.text.patch");
  assert.equal(plan.payload.projection.proof.operationCount, 3);
  assert.equal(Object.hasOwn(plan.payload.projection, "intentDigest"), false);
  assert.equal(Object.hasOwn(plan.payload.projection.proof, "patchDigest"), false);
  assert.equal(fake.casRequests, 0);
  assert.equal(JSON.stringify(plan.payload).includes("prefix"), false);
  const replay = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [operations[0], { ...operations[1], occurrence: "unique" }, operations[2]], idempotencyKey: "nominal" });
  assert.equal(replay.payload.operationId, plan.payload.operationId);
  const plannedStatus = await call(first, "obsidian_text_patch_status", { planRef: plan.payload.planRef });
  assert.equal(plannedStatus.payload.phase, "planned");
  assert.equal(Object.hasOwn(plannedStatus.payload, "idempotencyKey"), false);
  assert.equal(JSON.stringify(plannedStatus.payload).includes("prefix\\n"), false);
  const rebound = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "different" }], idempotencyKey: "nominal" }, true);
  assertPublicError(rebound.payload, "CONFLICT", "same key/different intent");
  const wrongKey = await call(first, "obsidian_text_patch_apply", { planRef: plan.payload.planRef, idempotencyKey: "wrong-key" }, true);
  assertPublicError(wrongKey.payload, "CONFLICT", "apply key binding");
  const applied = await call(first, "obsidian_text_patch_apply", { planRef: plan.payload.planRef, idempotencyKey: "nominal" });
  assert.equal(applied.payload.outcome, "committed");
  assert.equal(fake.content, `---\n${PROTECTED}\nstatut: actif\n---\nprefix\nalpha\ntarget\nomega\nsuffix\n`);
  const writes = fake.successfulWrites;
  await call(first, "obsidian_text_patch_apply", { planRef: plan.payload.planRef, idempotencyKey: "nominal" });
  assert.equal(fake.successfulWrites, writes);

  fake.reset(`---\n${PROTECTED}\nstatut: actif\n---\n- [ ] do not touch\nbody\n`);
  for (const [label, args] of [
    ["frontmatter", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "statut: actif", replacement: "statut: nope" }], idempotencyKey: "reject-frontmatter" }],
    ["task", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "- [ ] do not touch", replacement: "done" }], idempotencyKey: "reject-task" }],
    ["path", { path: "../outside.md", operations: [{ op: "append_body", text: "x" }], idempotencyKey: "reject-path" }],
    ["regex", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: { pattern: "body", marker: SECRET }, replacement: "x" }], idempotencyKey: "reject-regex" }],
  ]) {
    const rejected = await call(first, "obsidian_text_patch_plan", args, true);
    if (label === "regex") {
      assert.equal(rejected.payload.transportError.includes(SECRET), false);
    } else {
      assertPublicError(rejected.payload, "VALIDATION_ERROR", label);
    }
  }
  const runtimeForCompilerBoundary = new GovernedTextPatchRuntime(fake);
  await assert.rejects(
    runtimeForCompilerBoundary.plan({
      path: FIXTURE_PATH,
      operations: [{ op: "replace_literal", search: /body/u, replacement: "x" }],
      idempotencyKey: "reject-regex-direct",
    }),
    /Regular expressions are not supported/u,
    "compiler rejects regular expressions before CAS",
  );
  assert.equal(fake.casRequests, 0, "boundary rejects happen before CAS");

  fake.reset();
  const raceRuntime = new GovernedTextPatchRuntime(fake);
  const raceInput = {
    path: FIXTURE_PATH,
    operations: [
      { op: "replace_literal", search: "needle", replacement: "race-winner" },
    ],
    idempotencyKey: "plan-read-race",
  };
  let durableRaceWinner;
  fake.onNextProjectionRead = async () => {
    durableRaceWinner = await raceRuntime.plan(raceInput);
    fake.content = body("third-party-without-target");
  };
  const raceReplay = await raceRuntime.plan(raceInput);
  assert.equal(
    raceReplay.operationId,
    durableRaceWinner.operationId,
    "a compiler failure after a concurrent same-key winner must replay the durable winner",
  );
  assert.equal(fake.plans.size, 1);

  fake.reset();
  const stalePlan = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "stale" }], idempotencyKey: "stale" });
  fake.content = body("third-party\nneedle");
  const stale = await call(first, "obsidian_text_patch_apply", { planRef: stalePlan.payload.planRef, idempotencyKey: "stale" });
  assert.equal(stale.payload.outcome, "conflict");
  assert.equal(fake.successfulWrites, 0);

  fake.reset();
  const clientA = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "client-a" }], idempotencyKey: "client-a" });
  const clientB = await call(second, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "client-b" }], idempotencyKey: "client-b" });
  const gate = fake.blockNextCas();
  const firstApply = call(first, "obsidian_text_patch_apply", { planRef: clientA.payload.planRef, idempotencyKey: "client-a" });
  await gate.entered;
  const loser = await call(second, "obsidian_text_patch_apply", { planRef: clientB.payload.planRef, idempotencyKey: "client-b" });
  gate.release();
  const winner = await firstApply;
  assert.deepEqual(new Set([winner.payload.outcome, loser.payload.outcome]), new Set(["committed", "conflict"]));
  assert.equal(fake.successfulWrites, 1);

  fake.reset();
  const concurrent = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "once" }], idempotencyKey: "concurrent" });
  const concurrentGate = fake.blockNextCas();
  const inFlight = call(first, "obsidian_text_patch_apply", { planRef: concurrent.payload.planRef, idempotencyKey: "concurrent" });
  await concurrentGate.entered;
  const observing = await call(second, "obsidian_text_patch_apply", { planRef: concurrent.payload.planRef, idempotencyKey: "concurrent" });
  assert.equal(observing.payload.phase, "applying");
  concurrentGate.release();
  assert.equal((await inFlight).payload.outcome, "committed");
  assert.equal(fake.successfulWrites, 1);

  fake.reset();
  fake.loseResponseAfterWriteNext = true;
  const lostPlan = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "lost" }], idempotencyKey: "lost" });
  const lost = await call(first, "obsidian_text_patch_apply", { planRef: lostPlan.payload.planRef, idempotencyKey: "lost" }, true);
  const lostStatus = await call(first, "obsidian_text_patch_status", { planRef: lostPlan.payload.planRef });
  assert.equal(lostStatus.payload.outcome, "committed");
  assert.equal(fake.content.includes("lost"), true);

  fake.reset();
  fake.failBeforeWriteNext = true;
  const recoverPlan = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "needle", replacement: "recovered" }], idempotencyKey: "recover" });
  const unknown = await call(first, "obsidian_text_patch_apply", { planRef: recoverPlan.payload.planRef, idempotencyKey: "recover" });
  assert.equal(unknown.payload.outcome, "outcome_unknown");
  assert.equal((await call(first, "obsidian_text_patch_status", { planRef: recoverPlan.payload.planRef })).payload.outcome, "outcome_unknown");
  assert.equal((await call(first, "obsidian_text_patch_recover", { planRef: recoverPlan.payload.planRef, idempotencyKey: "recover" })).payload.outcome, "committed");
  assert.equal(fake.content.includes("recovered"), true);

  fake.reset(`---\n${PROTECTED}\nstatut: actif\n---\nremove-me`);
  const empty = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "remove-me", replacement: "" }], idempotencyKey: "empty-body" });
  await call(first, "obsidian_text_patch_apply", { planRef: empty.payload.planRef, idempotencyKey: "empty-body" });
  assert.equal(fake.content, `---\n${PROTECTED}\nstatut: actif\n---\n`);

  // Seed the shared-cache analogue through a commit, then mutate only the live
  // Atomic Write read. Planning must find live-authority, never stale cached.
  fake.reset(body("seed"));
  const seed = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "seed", replacement: "cached" }], idempotencyKey: "cache-seed" });
  await call(first, "obsidian_text_patch_apply", { planRef: seed.payload.planRef, idempotencyKey: "cache-seed" });
  fake.content = body("live-authority");
  assert.notEqual(fake.cachedContent, fake.content, "fixture cache is deliberately stale");
  const live = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "live-authority", replacement: "read-live" }], idempotencyKey: "live-authority" });
  assert.equal(live.payload.phase, "planned");
  assert.ok(fake.liveReads > 0, "projection planning uses the runtime note read");

  const redacted = await call(first, "obsidian_text_patch_plan", { path: FIXTURE_PATH, operations: [{ op: "replace_literal", search: "absent", replacement: SECRET }], idempotencyKey: "redaction" }, true);
  assertPublicError(redacted.payload, "VALIDATION_ERROR", "redacted parameters");
  for (const result of observed) assert.equal(result.includes(SECRET), false, "sealed text leaked in MCP response");
  console.log("PASS: MCP quartet registration, projection proof, no-write planning, exact replay/conflict fencing, body-only rejection, stale and concurrent CAS, lost-response status, exact recovery, empty-body literal replacement, cache authority, and redaction.");
} finally {
  await second.close();
  await first.close();
  rmSync(testRoot, { recursive: true, force: true });
}
