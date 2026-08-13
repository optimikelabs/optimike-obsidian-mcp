#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const canaryPath = process.env.OBSIDIAN_ATOMIC_NOTE_CANARY_PATH?.trim();
const confirmation =
  process.env.OBSIDIAN_ATOMIC_NOTE_CANARY_CONFIRM?.trim();
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const writeMode = process.env.MCP_WRITE_MODE?.trim() ?? "readonly";

if (!canaryPath) {
  throw new Error(
    "OBSIDIAN_ATOMIC_NOTE_CANARY_PATH must name one explicit existing disposable Markdown note.",
  );
}
if (!canaryPath.toLowerCase().endsWith(".md")) {
  throw new Error("The canary path must identify an existing .md note.");
}
if (
  confirmation !==
  "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_REPLACED"
) {
  throw new Error(
    "Set OBSIDIAN_ATOMIC_NOTE_CANARY_CONFIRM=I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_REPLACED.",
  );
}
if (!apiKey) {
  throw new Error("OBSIDIAN_API_KEY is required for the live canary.");
}
if (!new Set(["guarded", "full"]).has(writeMode)) {
  throw new Error(
    "The live canary requires MCP_WRITE_MODE=guarded or full; readonly is refused.",
  );
}

const tempParent = path.join(process.cwd(), ".tmp");
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(path.join(tempParent, "atomic-note-mcp-live-"));
const journalPath = path.join(tempRoot, "note-replace.sqlite");
const logsPath = path.join(tempRoot, "logs");
mkdirSync(logsPath, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_WRITE_MODE: writeMode,
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: apiKey,
    SEMANTIC_SEARCH_PREWARM: "false",
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "optimike-atomic-note-live-canary", version: "1.0.0" },
  { capabilities: {} },
);

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const payload = JSON.parse(text || "null");
  if (result.isError) {
    throw new Error(
      payload?.error?.message ?? `MCP tool failed: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }));
}

async function readNote() {
  const result = await call("obsidian_read_note", {
    filePath: canaryPath,
    format: "markdown",
    includeStat: false,
  });
  assert.equal(typeof result.content, "string");
  return result.content;
}

async function planApplyStatus(nextContent, key) {
  const planned = await call("obsidian_note_replace_plan", {
    path: canaryPath,
    nextContent,
    idempotencyKey: key,
  });
  assert.equal(planned.phase, "planned");
  const applied = await call("obsidian_note_replace_apply", {
    planRef: planned.planRef,
    idempotencyKey: key,
  });
  assert.equal(applied.outcome, "committed");
  const status = await call("obsidian_note_replace_status", {
    planRef: planned.planRef,
  });
  assert.equal(status.outcome, "committed");
  assert.equal(status.planDigest, planned.planDigest);
  return { planned, applied, status };
}

let originalContent;
let restored = false;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "obsidian_note_replace_plan",
    "obsidian_note_replace_apply",
    "obsidian_note_replace_status",
    "obsidian_note_replace_recover",
  ]) {
    assert.equal(names.has(name), true, `${name} is not registered`);
  }

  originalContent = await readNote();
  const runId = randomUUID();
  const nominalContent = `${originalContent}${
    originalContent.endsWith("\n") ? "" : "\n"
  }\n<!-- optimike-atomic-note-canary:${runId}:nominal -->\n`;
  const nominal = await planApplyStatus(
    nominalContent,
    `live-canary:${runId}:nominal`,
  );
  assert.equal(await readNote(), nominalContent);

  const replay = await call("obsidian_note_replace_apply", {
    planRef: nominal.planned.planRef,
    idempotencyKey: `live-canary:${runId}:nominal`,
  });
  assert.equal(replay.outcome, "committed");
  assert.equal(await readNote(), nominalContent);

  const staleContent = `${nominalContent}\n<!-- stale:${runId} -->\n`;
  const stalePlan = await call("obsidian_note_replace_plan", {
    path: canaryPath,
    nextContent: staleContent,
    idempotencyKey: `live-canary:${runId}:stale`,
  });
  const winnerContent = `${nominalContent}\n<!-- winner:${runId} -->\n`;
  const winner = await planApplyStatus(
    winnerContent,
    `live-canary:${runId}:winner`,
  );
  assert.equal(await readNote(), winnerContent);

  const stale = await call("obsidian_note_replace_apply", {
    planRef: stalePlan.planRef,
    idempotencyKey: `live-canary:${runId}:stale`,
  });
  assert.equal(stale.outcome, "conflict");
  assert.equal(await readNote(), winnerContent);

  const restore = await planApplyStatus(
    originalContent,
    `live-canary:${runId}:restore`,
  );
  assert.equal(await readNote(), originalContent);
  restored = true;

  console.log(
    JSON.stringify(
      {
        ok: true,
        canaryPath,
        toolsVerified: 4,
        nominalOutcome: nominal.status.outcome,
        replayOutcome: replay.outcome,
        winnerOutcome: winner.status.outcome,
        staleOutcome: stale.outcome,
        restoreOutcome: restore.status.outcome,
        restored,
      },
      null,
      2,
    ),
  );
} finally {
  if (originalContent !== undefined && !restored) {
    try {
      const current = await readNote();
      if (current !== originalContent) {
        const emergencyKey = `live-canary:${randomUUID()}:emergency-restore`;
        await planApplyStatus(originalContent, emergencyKey);
      }
      restored = (await readNote()) === originalContent;
    } catch (restoreError) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            canaryPath,
            restored: false,
            evidenceDirectory: tempRoot,
            recoveryRequired: true,
            error:
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError),
          },
          null,
          2,
        ),
      );
    }
  }
  await client.close().catch(() => undefined);
  if (restored) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`Canary evidence retained at ${tempRoot}`);
  }
}
