#!/usr/bin/env node

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const filePath = process.env.OBSIDIAN_STDIO_BACKPRESSURE_CANARY_PATH?.trim();
if (!filePath) {
  throw new Error(
    "Set OBSIDIAN_STDIO_BACKPRESSURE_CANARY_PATH to one existing disposable or non-sensitive vault-relative Markdown note.",
  );
}

const concurrency = Number(
  process.env.OBSIDIAN_STDIO_BACKPRESSURE_CONCURRENCY ?? "10",
);
if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 64) {
  throw new Error(
    "OBSIDIAN_STDIO_BACKPRESSURE_CONCURRENCY must be an integer from 2 to 64.",
  );
}

const minimumRejections = Number(
  process.env.OBSIDIAN_STDIO_BACKPRESSURE_MIN_REJECTIONS ?? "1",
);
if (
  !Number.isInteger(minimumRejections) ||
  minimumRejections < 1 ||
  minimumRejections >= concurrency
) {
  throw new Error(
    "OBSIDIAN_STDIO_BACKPRESSURE_MIN_REJECTIONS must be an integer from 1 to concurrency - 1.",
  );
}

const timeoutMs = Number(
  process.env.OBSIDIAN_STDIO_BACKPRESSURE_TIMEOUT_MS ?? "60000",
);
if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
  throw new Error(
    "OBSIDIAN_STDIO_BACKPRESSURE_TIMEOUT_MS must be from 5000 to 300000.",
  );
}

async function withTimeout(promise, label, limitMs = timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${limitMs}ms`)),
          limitMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ADMISSION_REASONS = new Set([
  "queue-full",
  "identity-queue-full",
  "timeout",
  "cancelled",
]);
const ADMISSION_MESSAGES = new Map([
  ["queue-full", "The HTTP operation queue is full."],
  [
    "identity-queue-full",
    "This client identity already has the maximum number of queued operations.",
  ],
  ["timeout", "The operation was not admitted before its queue timeout."],
  ["cancelled", "The operation was cancelled before admission."],
]);
const STREAMABLE_HTTP_POST_ERROR_PREFIX =
  "Streamable HTTP error: Error POSTing to endpoint: ";

function admissionReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  const payloadOffset = message.indexOf(STREAMABLE_HTTP_POST_ERROR_PREFIX);
  if (payloadOffset < 0) {
    return undefined;
  }
  try {
    const body = JSON.parse(
      message.slice(payloadOffset + STREAMABLE_HTTP_POST_ERROR_PREFIX.length),
    );
    const reason = body?.error?.data?.admission;
    if (
      typeof reason !== "string" ||
      !ADMISSION_REASONS.has(reason) ||
      body?.error?.code !== "SERVICE_UNAVAILABLE" ||
      body?.error?.message !== ADMISSION_MESSAGES.get(reason) ||
      body?.error?.data?.retryable !== (reason !== "cancelled")
    ) {
      return undefined;
    }
    return reason;
  } catch {
    return undefined;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio-proxy.js", "--tool-profile", "standard"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_TOOL_PROFILE: "standard",
    // The live harness owns the backend lifecycle. Fail closed instead of
    // silently spawning a detached process that it cannot reliably clean up.
    MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
  },
});
const client = new Client({
  name: "optimike-stdio-backpressure-live-canary",
  version: "0",
});

try {
  await withTimeout(client.connect(transport), "stdio proxy connection");
  const toolNames = (
    await withTimeout(client.listTools(), "tool discovery")
  ).tools.map((tool) => tool.name);
  assert.ok(
    toolNames.includes("obsidian_read_note"),
    "standard profile must expose obsidian_read_note",
  );

  const burst = await withTimeout(
    Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        client.callTool({
          name: "obsidian_read_note",
          arguments: { filePath, format: "markdown", includeStat: false },
        }),
      ),
    ),
    "concurrent read burst",
  );
  const succeeded = burst.filter((result) => result.status === "fulfilled");
  const rejected = burst.filter((result) => result.status === "rejected");
  const connectionClosed = rejected.filter((result) =>
    /Connection closed/u.test(String(result.reason)),
  );
  const admissionReasons = rejected.map((result) =>
    admissionReason(result.reason),
  );

  assert.equal(
    connectionClosed.length,
    0,
    "one admission or application error must never close sibling stdio calls",
  );
  assert.ok(succeeded.length > 0, "the burst must complete at least one read");
  assert.ok(
    rejected.length >= minimumRejections,
    `the burst did not exercise backpressure: expected at least ${minimumRejections} rejection(s), observed ${rejected.length}; increase concurrency or verify backend admission limits`,
  );
  assert.equal(
    admissionReasons.every((reason) => reason !== undefined),
    true,
    "every rejection must match the exact HTTP 503 JSON-RPC admission contract",
  );

  await withTimeout(
    client.callTool({
      name: "obsidian_read_note",
      arguments: { filePath, format: "markdown", includeStat: false },
    }),
    "following read",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        concurrency,
        minimumRejections,
        succeeded: succeeded.length,
        rejected: rejected.length,
        admissionReasons,
        connectionClosed: connectionClosed.length,
        followingReadSucceeded: true,
        notePathRedacted: true,
      },
      null,
      2,
    ),
  );
} finally {
  const closeTimeoutMs = Math.min(timeoutMs, 10_000);
  await withTimeout(
    client.close().catch(() => undefined),
    "MCP client close",
    closeTimeoutMs,
  ).catch((error) => console.error(String(error)));
  await withTimeout(
    transport.close().catch(() => undefined),
    "stdio transport close",
    closeTimeoutMs,
  ).catch((error) => console.error(String(error)));
}
