#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceOperationAdapter } from "../dist/services/operations/obsidianNoteReplaceOperationAdapter.js";
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { BaseErrorCode, McpError } from "../dist/types-global/errors.js";

const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
process.env.OBSIDIAN_API_KEY ||= "governed-canvas-test-only";
process.env.MCP_WRITE_MODE ||= "guarded";
process.env.MCP_GUARDED_MAX_BATCH_OPERATIONS ||= "200";
const { CANVAS_ATOMIC_PROFILE, GovernedCanvasRuntime } = await import(
  "../dist/services/canvasProjectionRuntime.js"
);
const root = mkdtempSync(path.join(os.tmpdir(), "optimike-canvas-p3-"));
const bindingFingerprint = "c".repeat(64);
let content = `${JSON.stringify(
  {
    nodes: [
      {
        id: "a",
        type: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        text: "Before",
        privateField: { keep: true },
      },
    ],
    edges: [],
    privateRoot: "keep",
  },
  null,
  2,
)}\n`;
let failNextReplaceBeforeWrite = false;

const backend = {
  async status() {
    return {
      ok: true,
      contractVersion: 1,
      plugin: { id: "obsidian-atomic-write-bridge", version: "0.4.0" },
      backend: {
        kind: "obsidian-vault-process",
        bindingFingerprint,
        atomicCas: true,
        writeEnabled: true,
      },
      limits: { markdownOnly: true },
    };
  },
  async read(payload) {
    return {
      ok: true,
      contractVersion: 1,
      path: payload.path,
      content,
      sha256: digest(content),
      size: Buffer.byteLength(content, "utf8"),
      bindingFingerprint,
    };
  },
  async replace(payload) {
    if (
      payload.bindingFingerprint !== bindingFingerprint ||
      payload.expectedSha256 !== digest(content)
    ) {
      throw new McpError(BaseErrorCode.CONFLICT, "sealed Canvas CAS conflict");
    }
    if (failNextReplaceBeforeWrite) {
      failNextReplaceBeforeWrite = false;
      throw new Error("synthetic transport interruption before Canvas CAS");
    }
    const beforeSha256 = digest(content);
    content = payload.nextContent;
    return {
      ok: true,
      contractVersion: 1,
      path: payload.path,
      beforeSha256,
      afterSha256: digest(content),
      size: Buffer.byteLength(content, "utf8"),
      bindingFingerprint,
    };
  },
};

const journal = new ObsidianNoteReplaceJournal(
  path.join(root, "journal.sqlite"),
);
const adapter = new ObsidianNoteReplaceOperationAdapter(
  backend,
  journal,
  CANVAS_ATOMIC_PROFILE,
);
const runtime = new GovernedCanvasRuntime(backend, journal, adapter, 10_000);

try {
  await assert.rejects(
    runtime.plan({
      path: "Canary/Flow.canvas",
      operations: [{ op: "set_text", id: "a", text: "invalid key" }],
      idempotencyKey: `canvas-${String.fromCharCode(0xd800)}`,
    }),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.VALIDATION_ERROR &&
      /well-formed Unicode/u.test(error.message),
  );

  const intent = {
    path: "Canary/Flow.canvas",
    operations: [
      { op: "set_text", id: "a", text: "After" },
      {
        op: "add_text_node",
        id: "b",
        text: "Second",
        x: 300,
        y: 0,
        width: 200,
        height: 100,
      },
      { op: "connect_nodes", id: "ab", fromNode: "a", toNode: "b" },
    ],
    idempotencyKey: "canvas-p3-contract-1",
  };
  const planned = await runtime.plan(intent);
  assert.equal(planned.phase, "planned");
  assert.equal(planned.operationKind, "obsidian.canvas.patch");
  assert.equal(planned.backend.kind, "obsidian-vault-process-canvas");
  assert.equal(planned.idempotencyKey, "canvas-p3-contract-1");
  assert.equal(
    planned.projection.sourcePreservation,
    "unknown-json-values-preserved-outside-authorized-canvas-entities",
  );
  assert.equal(
    JSON.parse(content).nodes.length,
    1,
    "plan must not mutate Canvas",
  );

  const replay = await runtime.plan(intent);
  assert.equal(replay.planRef, planned.planRef);

  const committed = await runtime.apply(planned.planRef, intent.idempotencyKey);
  assert.equal(committed.outcome, "committed");
  const graph = JSON.parse(content);
  assert.equal(graph.nodes.find((node) => node.id === "a").text, "After");
  assert.deepEqual(graph.nodes.find((node) => node.id === "a").privateField, {
    keep: true,
  });
  assert.equal(graph.privateRoot, "keep");
  assert.deepEqual(
    graph.edges.map((edge) => edge.id),
    ["ab"],
  );

  const status = await runtime.status(planned.planRef);
  assert.equal(status.outcome, "committed");
  assert.equal(status.idempotencyKey, undefined);

  await assert.rejects(
    runtime.apply(planned.planRef, "wrong-key"),
    (error) =>
      error instanceof McpError && error.code === BaseErrorCode.CONFLICT,
  );

  const stale = await runtime.plan({
    path: "Canary/Flow.canvas",
    operations: [{ op: "set_text", id: "a", text: "Stale" }],
    idempotencyKey: "canvas-p3-stale",
  });
  content = `${content.slice(0, -2)},\n  "thirdParty": true\n}\n`;
  const conflicted = await runtime.apply(stale.planRef, "canvas-p3-stale");
  assert.equal(conflicted.outcome, "conflict");
  assert.equal(JSON.parse(content).thirdParty, true);

  const graphWithIncidentEdges = (edgeCount) =>
    `${JSON.stringify(
      {
        nodes: [
          {
            id: "root",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: "Root",
          },
          ...Array.from({ length: edgeCount }, (_, index) => ({
            id: `leaf-${index}`,
            type: "text",
            x: 300,
            y: index * 120,
            width: 200,
            height: 100,
            text: `Leaf ${index}`,
          })),
        ],
        edges: Array.from({ length: edgeCount }, (_, index) => ({
          id: `edge-${index}`,
          fromNode: "root",
          toNode: `leaf-${index}`,
        })),
      },
      null,
      2,
    )}\n`;

  content = graphWithIncidentEdges(129);
  const wideProjection = await runtime.plan({
    path: "Canary/Wide.canvas",
    operations: [{ op: "delete_node", id: "root" }],
    idempotencyKey: "canvas-p3-wide-proof",
  });
  assert.equal(wideProjection.phase, "planned");
  assert.equal(wideProjection.projection.proof.removedIncidentEdgeCount, 129);

  content = graphWithIncidentEdges(200);
  const rejectedKey = "canvas-p3-too-many-effects";
  await assert.rejects(
    runtime.plan({
      path: "Canary/TooWide.canvas",
      operations: [{ op: "delete_node", id: "root" }],
      idempotencyKey: rejectedKey,
    }),
    (error) =>
      error instanceof McpError && error.code === BaseErrorCode.FORBIDDEN,
  );
  const rejectedDurableKey = `optimike:canvas-projection:v1:${digest(
    `obsidian.canvas.patch:v1\0${rejectedKey}`,
  )}`;
  assert.equal(
    journal.getByIdempotencyKey(rejectedDurableKey),
    undefined,
    "inadmissible projected effects must be rejected before journaling",
  );

  const oversizedContent = "x".repeat(5 * 1024 * 1024 + 1);
  content = oversizedContent;
  const oversizedKey = "canvas-p3-oversized-source";
  await assert.rejects(
    runtime.plan({
      path: "Canary/Oversized.canvas",
      operations: [{ op: "set_text", id: "a", text: "Never compiled" }],
      idempotencyKey: oversizedKey,
    }),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.VALIDATION_ERROR &&
      error.details?.reason === "canvas_source_too_large",
  );
  const oversizedDurableKey = `optimike:canvas-projection:v1:${digest(
    `obsidian.canvas.patch:v1\0${oversizedKey}`,
  )}`;
  assert.equal(
    journal.getByIdempotencyKey(oversizedDurableKey),
    undefined,
    "oversized sources must be rejected before compilation and journaling",
  );

  content = `${JSON.stringify({
    nodes: [
      {
        id: "recover",
        type: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        text: "Before recovery",
      },
    ],
    edges: [],
  })}\n`;
  const recoveryKey = "canvas-p3-public-recovery";
  const recoveryPlan = await runtime.plan({
    path: "Canary/Recover.canvas",
    operations: [
      { op: "set_text", id: "recover", text: "Recovered exactly once" },
    ],
    idempotencyKey: recoveryKey,
  });
  failNextReplaceBeforeWrite = true;
  const unknown = await runtime.apply(recoveryPlan.planRef, recoveryKey);
  assert.equal(unknown.outcome, "outcome_unknown");
  assert.equal(unknown.recoveryAllowed, true);
  const recoverableStatus = await runtime.status(recoveryPlan.planRef);
  assert.equal(recoverableStatus.outcome, "outcome_unknown");
  assert.equal(recoverableStatus.recoveryAllowed, true);
  const recovered = await runtime.recover(recoveryPlan.planRef, recoveryKey);
  assert.equal(recovered.outcome, "committed");
  assert.equal(JSON.parse(content).nodes[0].text, "Recovered exactly once");
  const recoveredSha256 = digest(content);
  const recoveredReplay = await runtime.recover(
    recoveryPlan.planRef,
    recoveryKey,
  );
  assert.equal(recoveredReplay.outcome, "committed");
  assert.equal(digest(content), recoveredSha256);
} finally {
  runtime.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Canvas plan/apply/status seals graph intent over the shared durable runtime",
);
