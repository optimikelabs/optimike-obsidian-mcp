#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  FRONTMATTER_FIXTURE_PATH,
  FRONTMATTER_INITIAL_CONTENT,
  GovernedFrontmatterAtomicServer,
} from "./fixtures/governed-frontmatter-atomic-server.mjs";

const TOOL_NAMES = [
  "obsidian_frontmatter_patch_apply",
  "obsidian_frontmatter_patch_plan",
  "obsidian_frontmatter_patch_recover",
  "obsidian_frontmatter_patch_status",
];
const SECRET = "sealed-frontmatter-value-MUST-NOT-LEAK";

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return JSON.parse(text || "null");
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(candidate) : [candidate];
  });
}

const parent = path.join(process.cwd(), ".tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "governed-frontmatter-mcp-"));
const vaultPath = path.join(root, "vault");
const logsPath = path.join(root, "logs");
const journalPath = path.join(root, "note-replace.sqlite");
mkdirSync(vaultPath, { recursive: true });
mkdirSync(logsPath, { recursive: true });

const fake = new GovernedFrontmatterAtomicServer();
await fake.listen();
const observed = [];
const stderrStreams = [];

function childEnv(writeMode = "full", runtimeMode = "live") {
  const environment = {
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "debug",
    LOGS_DIR: logsPath,
    MCP_WRITE_MODE: writeMode,
    MCP_GUARDED_MAX_WRITE_CHARS: "100000",
    MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
    MCP_OBSIDIAN_NOTE_REPLACE_EXECUTION_LEASE_MS: "1000",
    OBSIDIAN_RUNTIME_MODE: runtimeMode,
    OBSIDIAN_BASE_URL: fake.baseUrl,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_BLOCKING: "true",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    SMART_SEARCH_MODE: "files",
    OPERON_MUTATIONS_ENABLED: "false",
  };
  if (runtimeMode === "live" || runtimeMode === "hybrid") {
    environment.OBSIDIAN_API_KEY = "fixture-api-key";
  } else {
    environment.OBSIDIAN_VAULT = vaultPath;
  }
  return environment;
}

async function startClient(writeMode = "full", runtimeMode = "live") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: childEnv(writeMode, runtimeMode),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client(
    { name: "governed-frontmatter-integration", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    async close() {
      await client.close().catch(() => undefined);
      stderrStreams.push(stderr);
    },
  };
}

async function call(session, name, args, expectedError = false) {
  const result = await session.client.callTool({ name, arguments: args });
  observed.push(JSON.stringify(result));
  assert.equal(Boolean(result.isError), expectedError, `${name} error status`);
  return { result, payload: parse(result) };
}

function assertNoPrivateData(value, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(
    serialized.includes(SECRET),
    false,
    `${label} leaked sealed value`,
  );
  assert.equal(
    serialized.includes(journalPath),
    false,
    `${label} leaked private journal path`,
  );
}

function expectedNominalContent() {
  return [
    "---",
    "# keep header",
    "création: 2026-08-14",
    `statut: "${SECRET}"`,
    "# keep separator",
    "meta:",
    "  nested: true",
    "rang: 1",
    "",
    "---",
    "Body must stay byte-identical.",
    "",
  ].join("\n");
}

let session;
try {
  const headless = await startClient("readonly", "headless-readonly");
  const headlessTools = await headless.client.listTools();
  assert.deepEqual(
    headlessTools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_frontmatter_patch_")),
    [],
  );
  await headless.close();

  session = await startClient();
  const listed = await session.client.listTools();
  const governed = listed.tools
    .filter((tool) => tool.name.startsWith("obsidian_frontmatter_patch_"))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(
    governed.map((tool) => tool.name),
    TOOL_NAMES,
  );
  const byName = new Map(governed.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("obsidian_frontmatter_patch_plan")?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(
    byName.get("obsidian_frontmatter_patch_status")?.annotations,
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  );
  for (const name of [
    "obsidian_frontmatter_patch_apply",
    "obsidian_frontmatter_patch_recover",
  ]) {
    assert.deepEqual(byName.get(name)?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  }

  const malformedUnicodeKey = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "statut", value: "planned" }],
      idempotencyKey: "\ud800",
    },
    true,
  );
  assert.equal(malformedUnicodeKey.payload.error.code, "VALIDATION_ERROR");
  assert.match(malformedUnicodeKey.payload.error.message, /well-formed Unicode/i);

  const replacementCharacterKey = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "statut", value: "planned" }],
      idempotencyKey: "�",
    },
  );
  assert.equal(replacementCharacterKey.payload.phase, "planned");

  const unknownPlanRef =
    "obsidian-frontmatter-patch:v1:00000000-0000-4000-8000-000000000000";
  for (const [name, args] of [
    ["obsidian_frontmatter_patch_status", { planRef: unknownPlanRef }],
    [
      "obsidian_frontmatter_patch_apply",
      { planRef: unknownPlanRef, idempotencyKey: "unknown-plan" },
    ],
    [
      "obsidian_frontmatter_patch_recover",
      { planRef: unknownPlanRef, idempotencyKey: "unknown-plan" },
    ],
  ]) {
    const missing = await call(session, name, args, true);
    assert.equal(missing.payload.error.code, "NOT_FOUND");
    assert.equal(
      missing.payload.error.details?.reason,
      "note_replace_plan_not_found",
    );
  }

  fake.reset();
  const protectedAttempt = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "création", value: "2099-01-01" }],
      idempotencyKey: "p1-protected",
    },
    true,
  );
  assert.match(
    protectedAttempt.payload.error.message,
    /protected frontmatter/i,
  );
  assert.equal(fake.casRequests, 0);

  fake.reset();
  const driftedContent = FRONTMATTER_INITIAL_CONTENT.replace(
    "statut: actif # replace this entry only",
    "statut: concurrent",
  );
  fake.mutateAfterRead(1, driftedContent);
  const drift = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "statut", value: "planned" }],
      idempotencyKey: "p1-source-drift",
    },
    true,
  );
  assert.match(drift.payload.error.message, /changed after.*compiled/i);
  assert.equal(fake.casRequests, 0);
  fake.reset();
  const afterRejectedDrift = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "statut", value: "planned" }],
      idempotencyKey: "p1-source-drift",
    },
  );
  assert.equal(afterRejectedDrift.payload.phase, "planned");

  fake.reset();
  const localeIndependentPlan = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [
        {
          op: "set",
          key: "unicode_map",
          value: Object.fromEntries([
            ["ä", "umlaut"],
            ["z", "latin"],
          ]),
        },
      ],
      idempotencyKey: "p1-locale-independent-intent",
    },
  );
  const expectedLocaleIndependentDigest = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: 1,
        operationKind: "obsidian.frontmatter.patch",
        operations: [
          {
            key: "unicode_map",
            op: "set",
            value: { z: "latin", ä: "umlaut" },
          },
        ],
        path: FRONTMATTER_FIXTURE_PATH,
      }),
      "utf8",
    )
    .digest("hex");
  assert.equal(
    localeIndependentPlan.payload.projection.intentDigest,
    expectedLocaleIndependentDigest,
    "P1 intent hashing must use code-unit order instead of the process locale",
  );

  fake.reset();
  const namespacePublicKey = "p1-journal-namespace-isolation";
  const formerlyCollidingDirectKey = createHash("sha256")
    .update(`obsidian.frontmatter.patch:v1\0${namespacePublicKey}`, "utf8")
    .digest("hex");
  const directNamespacePlan = await call(session, "obsidian_note_replace_plan", {
    path: FRONTMATTER_FIXTURE_PATH,
    nextContent: FRONTMATTER_INITIAL_CONTENT.replace(
      "owner: mike",
      "owner: direct-p0",
    ),
    idempotencyKey: formerlyCollidingDirectKey,
  });
  const projectedNamespacePlan = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "rang", value: 7 }],
      idempotencyKey: namespacePublicKey,
    },
  );
  assert.equal(directNamespacePlan.payload.phase, "planned");
  assert.equal(projectedNamespacePlan.payload.phase, "planned");
  assert.notEqual(
    directNamespacePlan.payload.operationId,
    projectedNamespacePlan.payload.operationId,
  );
  const reservedNamespaceAttempt = await call(
    session,
    "obsidian_note_replace_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      nextContent: FRONTMATTER_INITIAL_CONTENT.replace(
        "owner: mike",
        "owner: reserved-p0",
      ),
      idempotencyKey: `optimike:projection:v1:${formerlyCollidingDirectKey}`,
    },
    true,
  );
  assert.equal(reservedNamespaceAttempt.payload.error.code, "VALIDATION_ERROR");
  assert.equal(
    reservedNamespaceAttempt.payload.error.details?.reason,
    "reserved_projection_idempotency_namespace",
  );

  fake.reset();
  const nominalOperations = [
    { op: "set", key: "rang", value: 1 },
    { op: "delete", key: "owner" },
    { op: "set", key: "statut", value: SECRET },
  ];
  const nominalPlan = await call(session, "obsidian_frontmatter_patch_plan", {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: nominalOperations,
    idempotencyKey: "p1-nominal",
  });
  assert.equal(nominalPlan.payload.phase, "planned");
  assert.equal(nominalPlan.payload.operationKind, "obsidian.frontmatter.patch");
  assert.equal(nominalPlan.payload.idempotencyKey, "p1-nominal");
  assert.match(nominalPlan.payload.planRef, /^obsidian-frontmatter-patch:v1:/u);
  assert.equal(
    nominalPlan.payload.projection.sourcePreservation,
    "byte-identical-outside-authorized-frontmatter-ranges",
  );
  assert.equal(fake.content, FRONTMATTER_INITIAL_CONTENT);
  assertNoPrivateData(nominalPlan.result, "P1 plan receipt");

  const canonicalReplay = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [...nominalOperations].reverse(),
      idempotencyKey: "p1-nominal",
    },
  );
  assert.equal(
    canonicalReplay.payload.operationId,
    nominalPlan.payload.operationId,
  );
  assert.equal(
    canonicalReplay.payload.planDigest,
    nominalPlan.payload.planDigest,
  );

  const plannedObserverStatus = await call(
    session,
    "obsidian_frontmatter_patch_status",
    { planRef: nominalPlan.payload.planRef },
  );
  assert.equal(plannedObserverStatus.payload.phase, "planned");
  assert.equal(
    Object.hasOwn(plannedObserverStatus.payload, "idempotencyKey"),
    false,
  );

  const rebound = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    {
      path: FRONTMATTER_FIXTURE_PATH,
      operations: [{ op: "set", key: "statut", value: "different" }],
      idempotencyKey: "p1-nominal",
    },
    true,
  );
  assert.match(rebound.payload.error.message, /different frontmatter intent/i);
  assert.equal(rebound.payload.error.code, "CONFLICT");

  const forgedChildPlanRef = nominalPlan.payload.planRef.replace(
    /^obsidian-frontmatter-patch:v1:/u,
    "obsidian-note-replace:v1:",
  );
  for (const [name, args] of [
    ["obsidian_note_replace_status", { planRef: forgedChildPlanRef }],
    [
      "obsidian_note_replace_apply",
      { planRef: forgedChildPlanRef, idempotencyKey: "p1-nominal" },
    ],
    [
      "obsidian_note_replace_recover",
      { planRef: forgedChildPlanRef, idempotencyKey: "p1-nominal" },
    ],
  ]) {
    const blockedChildReplay = await call(session, name, args, true);
    assert.equal(blockedChildReplay.payload.error.code, "NOT_FOUND");
    assert.equal(
      blockedChildReplay.payload.error.details?.reason,
      "note_replace_plan_not_found",
    );
  }
  assert.equal(fake.successfulWrites, 0);
  assert.equal(fake.content, FRONTMATTER_INITIAL_CONTENT);

  const writesBeforeNominal = fake.successfulWrites;
  const casBeforeNominal = fake.casRequests;
  const nominalApply = await call(session, "obsidian_frontmatter_patch_apply", {
    planRef: nominalPlan.payload.planRef,
    idempotencyKey: "p1-nominal",
  });
  assert.equal(nominalApply.payload.outcome, "committed");
  assert.equal(nominalApply.payload.idempotencyKey, "p1-nominal");
  assert.equal(fake.content, expectedNominalContent());
  assert.equal(fake.successfulWrites - writesBeforeNominal, 1);
  assert.equal(fake.casRequests - casBeforeNominal, 1);
  const nominalStatus = await call(
    session,
    "obsidian_frontmatter_patch_status",
    {
      planRef: nominalPlan.payload.planRef,
    },
  );
  assert.equal(nominalStatus.payload.outcome, "committed");
  assert.equal(Object.hasOwn(nominalStatus.payload, "idempotencyKey"), false);
  const blockedCommittedChildStatus = await call(
    session,
    "obsidian_note_replace_status",
    { planRef: forgedChildPlanRef },
    true,
  );
  assert.equal(blockedCommittedChildStatus.payload.error.code, "NOT_FOUND");
  assert.equal(
    nominalStatus.payload.planDigest,
    nominalApply.payload.planDigest,
  );
  const nominalReplay = await call(
    session,
    "obsidian_frontmatter_patch_apply",
    {
      planRef: nominalPlan.payload.planRef,
      idempotencyKey: "p1-nominal",
    },
  );
  assert.equal(nominalReplay.payload.outcome, "committed");
  assert.equal(fake.casRequests - casBeforeNominal, 1);

  fake.reset();
  const stablePlanInput = {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: [{ op: "set", key: "statut", value: "stable-winner" }],
    idempotencyKey: "p1-stable-winner",
  };
  const stablePlan = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    stablePlanInput,
  );
  fake.content = driftedContent;
  const stableReplay = await call(
    session,
    "obsidian_frontmatter_patch_plan",
    stablePlanInput,
  );
  assert.equal(
    stableReplay.payload.operationId,
    stablePlan.payload.operationId,
  );
  const stableConflict = await call(
    session,
    "obsidian_frontmatter_patch_apply",
    {
      planRef: stablePlan.payload.planRef,
      idempotencyKey: "p1-stable-winner",
    },
  );
  assert.equal(stableConflict.payload.outcome, "conflict");
  assert.equal(fake.content, driftedContent);

  fake.reset();
  const concurrentInput = {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: [{ op: "set", key: "statut", value: "concurrent" }],
    idempotencyKey: "p1-concurrent-plan",
  };
  const [concurrentA, concurrentB] = await Promise.all([
    call(session, "obsidian_frontmatter_patch_plan", concurrentInput),
    call(session, "obsidian_frontmatter_patch_plan", concurrentInput),
  ]);
  assert.equal(
    concurrentA.payload.operationId,
    concurrentB.payload.operationId,
  );
  assert.equal(concurrentA.payload.planDigest, concurrentB.payload.planDigest);

  const blocked = fake.blockNextCas();
  const concurrentWritesBefore = fake.successfulWrites;
  const firstApplyPromise = call(session, "obsidian_frontmatter_patch_apply", {
    planRef: concurrentA.payload.planRef,
    idempotencyKey: "p1-concurrent-plan",
  });
  await blocked.entered;
  const secondApply = await call(session, "obsidian_frontmatter_patch_apply", {
    planRef: concurrentA.payload.planRef,
    idempotencyKey: "p1-concurrent-plan",
  });
  assert.equal(secondApply.payload.phase, "applying");
  blocked.release();
  const firstApply = await firstApplyPromise;
  assert.equal(firstApply.payload.outcome, "committed");
  assert.equal(fake.successfulWrites - concurrentWritesBefore, 1);

  fake.reset();
  fake.loseResponseAfterWriteNext = true;
  const lostPlan = await call(session, "obsidian_frontmatter_patch_plan", {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: [{ op: "set", key: "statut", value: "lost-response" }],
    idempotencyKey: "p1-lost-response",
  });
  const lostApply = await call(session, "obsidian_frontmatter_patch_apply", {
    planRef: lostPlan.payload.planRef,
    idempotencyKey: "p1-lost-response",
  });
  assert.equal(lostApply.payload.outcome, "committed");
  const lostStatus = await call(session, "obsidian_frontmatter_patch_status", {
    planRef: lostPlan.payload.planRef,
  });
  assert.equal(lostStatus.payload.outcome, "committed");
  assert.equal(fake.successfulWrites, 1);

  fake.reset();
  fake.failBeforeWriteNext = true;
  const recoveryPlan = await call(session, "obsidian_frontmatter_patch_plan", {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: [{ op: "set", key: "statut", value: "recover-me" }],
    idempotencyKey: "p1-recover",
  });
  const uncertain = await call(session, "obsidian_frontmatter_patch_apply", {
    planRef: recoveryPlan.payload.planRef,
    idempotencyKey: "p1-recover",
  });
  assert.equal(uncertain.payload.outcome, "outcome_unknown");
  assert.equal(uncertain.payload.recoveryAllowed, true);
  await session.close();
  session = await startClient();
  const restartedStatus = await call(
    session,
    "obsidian_frontmatter_patch_status",
    { planRef: recoveryPlan.payload.planRef },
  );
  assert.equal(restartedStatus.payload.outcome, "outcome_unknown");
  const recovered = await call(session, "obsidian_frontmatter_patch_recover", {
    planRef: recoveryPlan.payload.planRef,
    idempotencyKey: "p1-recover",
  });
  assert.equal(recovered.payload.outcome, "committed");
  assert.equal(fake.successfulWrites, 1);

  fake.reset();
  const policyPlan = await call(session, "obsidian_frontmatter_patch_plan", {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: [{ op: "set", key: "statut", value: "policy" }],
    idempotencyKey: "p1-policy",
  });
  await session.close();
  session = await startClient("readonly", "live");
  const policyCasBefore = fake.casRequests;
  const policyBlocked = await call(
    session,
    "obsidian_frontmatter_patch_apply",
    {
      planRef: policyPlan.payload.planRef,
      idempotencyKey: "p1-policy",
    },
    true,
  );
  assert.match(policyBlocked.payload.error.message, /read-only mode/i);
  assert.equal(fake.casRequests, policyCasBefore);
  await session.close();
  session = await startClient();
  const policyCommitted = await call(
    session,
    "obsidian_frontmatter_patch_apply",
    {
      planRef: policyPlan.payload.planRef,
      idempotencyKey: "p1-policy",
    },
  );
  assert.equal(policyCommitted.payload.outcome, "committed");

  for (const response of observed)
    assertNoPrivateData(response, "MCP response");
  for (const stderr of [...stderrStreams, session.stderr()]) {
    assertNoPrivateData(stderr, "MCP stderr");
  }
  for (const file of listFiles(logsPath)) {
    assertNoPrivateData(readFileSync(file, "utf8"), `log ${file}`);
  }

  console.log(
    "PASS: real stdio MCP clients proved the P1 source-preserving projection, exact P0 lifecycle inheritance, idempotent winner semantics, drift rejection, replay, concurrency, lost-response reconciliation, restart recovery, policy revalidation, and redaction.",
  );
} finally {
  if (session) await session.close();
  await fake.close();
  rmSync(root, { recursive: true, force: true });
}
