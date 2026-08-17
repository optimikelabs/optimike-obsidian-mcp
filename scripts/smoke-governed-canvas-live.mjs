#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const canaryPath = process.env.OBSIDIAN_CANVAS_CANARY_PATH?.trim();
const confirmation = process.env.OBSIDIAN_CANVAS_CANARY_CONFIRM?.trim();
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const upstreamBaseUrl = (
  process.env.OBSIDIAN_BASE_URL?.trim() ?? "http://127.0.0.1:27123"
).replace(/\/+$/u, "");
const writeMode = process.env.MCP_WRITE_MODE?.trim() ?? "readonly";
const CONFIRMATION =
  "I_UNDERSTAND_THIS_DISPOSABLE_CANVAS_WILL_BE_MUTATED_AND_RESTORED";
const mcpGitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
const mcpVersion = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;

if (!canaryPath?.toLowerCase().endsWith(".canvas")) {
  throw new Error(
    "OBSIDIAN_CANVAS_CANARY_PATH must name one existing disposable .canvas file.",
  );
}
if (confirmation !== CONFIRMATION) {
  throw new Error(`Set OBSIDIAN_CANVAS_CANARY_CONFIRM=${CONFIRMATION}.`);
}
if (!apiKey) throw new Error("OBSIDIAN_API_KEY is required.");
if (!new Set(["guarded", "full"]).has(writeMode)) {
  throw new Error(
    "The live Canvas canary requires MCP_WRITE_MODE=guarded or full.",
  );
}

const runId = randomUUID();
const privateRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-governed-canvas-live-"),
);
const journalPath = path.join(privateRoot, "canvas.sqlite");
const backupPath = path.join(privateRoot, "original.canvas");
const metadataPath = path.join(privateRoot, "recovery.json");
const logsParent = path.join(process.cwd(), "logs", "governed-canvas-live");
mkdirSync(logsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(logsParent, "run-"));
console.error(`Canvas canary recovery directory: ${privateRoot}`);

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function directRequest(route, method = "GET", payload) {
  const response = await fetch(`${upstreamBaseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `${method} ${route} failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

const status = () =>
  directRequest("/extensions/obsidian-atomic-write-bridge/status");
const read = () =>
  directRequest(
    "/extensions/obsidian-atomic-write-bridge/canvas/read",
    "POST",
    { contractVersion: 1, path: canaryPath },
  );
const replace = (expectedSha256, nextContent, bindingFingerprint) =>
  directRequest("/extensions/obsidian-atomic-write-bridge/canvas/cas", "POST", {
    contractVersion: 1,
    path: canaryPath,
    bindingFingerprint,
    expectedSha256,
    nextContent,
  });

let dropNextCasResponse = false;
let dropNextCasBeforeUpstream = false;
let dropNextReadResponse = false;
let droppedCasResponses = 0;
let droppedCasBeforeUpstream = 0;
let droppedReadResponses = 0;
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = Buffer.concat(chunks);
    const target = new URL(request.url ?? "/", `${upstreamBaseUrl}/`);
    if (
      dropNextCasBeforeUpstream &&
      target.pathname === "/extensions/obsidian-atomic-write-bridge/canvas/cas"
    ) {
      dropNextCasBeforeUpstream = false;
      droppedCasBeforeUpstream += 1;
      request.socket.destroy();
      return;
    }
    if (
      dropNextReadResponse &&
      target.pathname === "/extensions/obsidian-atomic-write-bridge/canvas/read"
    ) {
      dropNextReadResponse = false;
      droppedReadResponses += 1;
      request.socket.destroy();
      return;
    }
    const headers = { ...request.headers };
    delete headers.host;
    delete headers["content-length"];
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(!new Set(["GET", "HEAD"]).has(request.method ?? "GET")
        ? { body: requestBody }
        : {}),
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    if (
      dropNextCasResponse &&
      target.pathname === "/extensions/obsidian-atomic-write-bridge/canvas/cas"
    ) {
      dropNextCasResponse = false;
      dropNextReadResponse = true;
      droppedCasResponses += 1;
      request.socket.destroy();
      return;
    }
    response.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) response.setHeader("content-type", contentType);
    response.end(upstreamBody);
  } catch (error) {
    if (!response.headersSent) response.statusCode = 502;
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});
await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", resolve);
});
const proxyAddress = proxy.address();
assert.ok(proxyAddress && typeof proxyAddress === "object");
const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "error",
    LOGS_DIR: logsPath,
    MCP_WRITE_MODE: writeMode,
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(
      privateRoot,
      "notes.sqlite",
    ),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(
      privateRoot,
      "bases.sqlite",
    ),
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: journalPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: apiKey,
    OBSIDIAN_BASE_URL: proxyBaseUrl,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    OPERON_MUTATIONS_ENABLED: "false",
  },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
const client = new Client(
  { name: "governed-canvas-live", version: "1.0.0" },
  { capabilities: {} },
);

function parsed(result) {
  return JSON.parse(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
}

let original;
let restored = false;
let bindingFingerprint;
try {
  const bridgeStatus = await status();
  assert.equal(bridgeStatus.plugin.id, "obsidian-atomic-write-bridge");
  assert.equal(bridgeStatus.plugin.version, "0.4.0");
  assert.equal(bridgeStatus.backend.canvasAtomicCas, true);
  assert.equal(bridgeStatus.backend.canvasWriteEnabled, true);
  bindingFingerprint = bridgeStatus.backend.bindingFingerprint;

  original = await read();
  assert.equal(original.sha256, sha256(original.content));
  const originalGraph = JSON.parse(original.content);
  const rootNode = originalGraph.nodes.find(
    (node) => node.id === "canary-root",
  );
  assert.equal(rootNode?.type, "text");
  writeFileSync(backupPath, original.content, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        canaryPath,
        originalSha256: original.sha256,
        bindingFingerprint,
        recovery:
          "Restore original.canvas only to this disposable Canvas after verifying the same binding fingerprint.",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const invalidGraph = JSON.stringify({
    nodes: originalGraph.nodes,
    edges: [
      {
        id: `invalid-${runId}`,
        fromNode: "canary-root",
        toNode: "missing-node",
      },
    ],
  });
  await assert.rejects(
    replace(original.sha256, invalidGraph, bindingFingerprint),
    /400|existing nodes/u,
  );
  assert.equal(
    (await read()).sha256,
    original.sha256,
    "invalid Canvas graphs must be rejected without a write",
  );

  await client.connect(transport);
  const suffix = runId.slice(0, 8);
  const key = `canvas-live:${runId}:apply`;
  const plan = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_plan",
      arguments: {
        path: canaryPath,
        operations: [
          { op: "set_text", id: "canary-root", text: `Applied ${suffix}` },
          {
            op: "add_text_node",
            id: `node-${suffix}`,
            text: "Governed Canvas canary",
            x: 320,
            y: 0,
            width: 240,
            height: 120,
          },
          {
            op: "connect_nodes",
            id: `edge-${suffix}`,
            fromNode: "canary-root",
            toNode: `node-${suffix}`,
          },
        ],
        idempotencyKey: key,
      },
    }),
  );
  assert.equal(plan.phase, "planned");
  assert.equal((await read()).sha256, original.sha256, "plan must not write");

  dropNextCasBeforeUpstream = true;
  const uncertain = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_apply",
      arguments: { planRef: plan.planRef, idempotencyKey: key },
    }),
  );
  assert.equal(uncertain.outcome, "outcome_unknown");
  assert.equal(uncertain.recoveryAllowed, true);
  assert.equal(droppedCasBeforeUpstream, 1);

  const recoverableStatus = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_status",
      arguments: { planRef: plan.planRef },
    }),
  );
  assert.equal(recoverableStatus.outcome, "outcome_unknown");
  assert.equal(recoverableStatus.recoveryAllowed, true);
  const recovered = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_recover",
      arguments: { planRef: plan.planRef, idempotencyKey: key },
    }),
  );
  assert.equal(recovered.outcome, "committed");
  const committedRead = await read();
  const committedGraph = JSON.parse(committedRead.content);
  assert.equal(
    committedGraph.nodes.find((node) => node.id === `node-${suffix}`)?.text,
    "Governed Canvas canary",
  );
  assert.deepEqual(committedGraph.unknownRoot, originalGraph.unknownRoot);

  const recoveryReplay = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_recover",
      arguments: { planRef: plan.planRef, idempotencyKey: key },
    }),
  );
  assert.equal(recoveryReplay.outcome, "committed");
  assert.equal((await read()).sha256, committedRead.sha256);

  const postWriteKey = `canvas-live:${runId}:post-write`;
  const postWritePlan = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_plan",
      arguments: {
        path: canaryPath,
        operations: [
          {
            op: "set_text",
            id: "canary-root",
            text: `Post-write ${suffix}`,
          },
        ],
        idempotencyKey: postWriteKey,
      },
    }),
  );
  dropNextCasResponse = true;
  const postWriteUnknown = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_apply",
      arguments: {
        planRef: postWritePlan.planRef,
        idempotencyKey: postWriteKey,
      },
    }),
  );
  assert.equal(postWriteUnknown.outcome, "outcome_unknown");
  assert.equal(droppedCasResponses, 1);
  assert.equal(droppedReadResponses, 1);
  const postWriteReconciled = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_status",
      arguments: { planRef: postWritePlan.planRef },
    }),
  );
  assert.equal(postWriteReconciled.outcome, "committed");
  const postWriteRead = await read();
  const postWriteGraph = JSON.parse(postWriteRead.content);
  assert.equal(
    postWriteGraph.nodes.find((node) => node.id === "canary-root")?.text,
    `Post-write ${suffix}`,
  );

  const staleKey = `canvas-live:${runId}:stale`;
  const stale = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_plan",
      arguments: {
        path: canaryPath,
        operations: [{ op: "set_text", id: "canary-root", text: "stale" }],
        idempotencyKey: staleKey,
      },
    }),
  );
  const driftContent = `${JSON.stringify(
    { ...postWriteGraph, canaryDrift: runId },
    null,
    2,
  )}\n`;
  const drift = await replace(
    postWriteRead.sha256,
    driftContent,
    bindingFingerprint,
  );
  const conflict = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_apply",
      arguments: { planRef: stale.planRef, idempotencyKey: staleKey },
    }),
  );
  assert.equal(conflict.outcome, "conflict");
  assert.equal((await read()).sha256, drift.afterSha256);
  await replace(drift.afterSha256, postWriteRead.content, bindingFingerprint);

  const beforeRestore = await read();
  await replace(beforeRestore.sha256, original.content, bindingFingerprint);
  const finalRead = await read();
  assert.equal(finalRead.sha256, original.sha256);
  assert.equal(finalRead.content, original.content);
  restored = true;

  const evidencePath = path.join(
    os.tmpdir(),
    `optimike-governed-canvas-p3-${runId}.json`,
  );
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        ok: true,
        runId,
        canaryPath,
        bridgeVersion: bridgeStatus.plugin.version,
        mcpVersion,
        mcpGitSha,
        originalSha256: original.sha256,
        finalSha256: finalRead.sha256,
        invalidGraphRejectedWithoutWrite: true,
        uncertainOutcome: uncertain.outcome,
        recoverableStatusOutcome: recoverableStatus.outcome,
        recoveredOutcome: recovered.outcome,
        recoveryReplayOutcome: recoveryReplay.outcome,
        postWriteUnknownOutcome: postWriteUnknown.outcome,
        postWriteReconciledOutcome: postWriteReconciled.outcome,
        conflictOutcome: conflict.outcome,
        droppedCasResponses,
        droppedCasBeforeUpstream,
        droppedReadResponses,
        restored,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
  console.log(
    `PASS: governed Canvas live canary restored exact SHA-256; evidence: ${evidencePath}`,
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nMCP stderr:\n${stderr}\nRecovery directory retained: ${privateRoot}`,
  );
} finally {
  await client.close().catch(() => undefined);
  proxy.closeAllConnections?.();
  await new Promise((resolve) => proxy.close(resolve));
  if (!restored && original && bindingFingerprint) {
    try {
      const current = await read();
      const currentStatus = await status();
      if (currentStatus.backend.bindingFingerprint !== bindingFingerprint) {
        throw new Error("Backend binding changed; refusing emergency restore.");
      }
      if (current.sha256 !== original.sha256) {
        await replace(current.sha256, original.content, bindingFingerprint);
      }
      const finalRead = await read();
      restored = finalRead.sha256 === original.sha256;
    } catch (cleanupError) {
      console.error(`Emergency Canvas restoration failed: ${cleanupError}`);
    }
  }
  if (restored) {
    rmSync(privateRoot, { recursive: true, force: true });
    rmSync(logsPath, { recursive: true, force: true });
  } else {
    console.error(`Canvas recovery required from ${privateRoot}`);
  }
}
