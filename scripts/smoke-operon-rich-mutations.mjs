#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runId = process.env.OPERON_MUTATION_SMOKE_RUN_ID ?? `rich-${Date.now()}`;
const targetDateKey = process.env.OPERON_MUTATION_TARGET_DATE ?? "2026-07-20";
const inlineTargetPath = process.env.OPERON_MUTATION_INLINE_TARGET ?? "Pilot.md";

function payload(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block?.text) throw new Error("MCP tool returned no JSON payload.");
  return JSON.parse(block.text);
}

async function call(client, name, args) {
  return payload(await client.callTool({ name, arguments: args }));
}

function expectStatus(result, status, label) {
  if (result.status !== status) throw new Error(`${label}: expected ${status}, got ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_TOOL_PROFILE: "tasks",
    },
  });
  const client = new Client({ name: "operon-rich-mutation-smoke", version: "1" });
  try {
    await client.connect(transport);
    const blocker = expectStatus(await call(client, "operon_create_task", {
      idempotencyKey: `${runId}-blocker-create`,
      dryRun: false,
      task: {
        source: "file",
        description: `Blocker ${runId}`,
        tags: ["mcp-rich"],
        fields: { status: "Project.Planned", priority: "A" },
        properties: { north_star: true },
      },
    }), "applied", "blocker create");
    const blockerId = blocker.after.operonId;

    const child = expectStatus(await call(client, "operon_create_task", {
      idempotencyKey: `${runId}-child-create`,
      dryRun: false,
      task: {
        source: "inline",
        description: `Child ${runId}`,
        tags: ["mcp-rich"],
        targetDateKey,
        fields: {
          status: "Project.Planned",
          priority: "B",
          parentTask: blockerId,
          blockedBy: blockerId,
        },
      },
    }), "applied", "child create");
    const childId = child.after.operonId;

    const blocked = await call(client, "operon_transition_task", {
      operonId: childId,
      expectedRevision: child.after.revision,
      idempotencyKey: `${runId}-child-blocked-transition`,
      dryRun: false,
      status: "Project.Finished",
    });
    expectStatus(blocked, "rejected", "blocked child transition");
    if (blocked.after?.checkbox !== "open") throw new Error("Blocked child changed despite rejection.");

    const freshBlocker = await call(client, "operon_get_task", {
      operonId: blockerId,
      includeProperties: true,
      forceRefresh: true,
    });
    const blockerDone = expectStatus(await call(client, "operon_transition_task", {
      operonId: blockerId,
      expectedRevision: freshBlocker.task.revision,
      idempotencyKey: `${runId}-blocker-finish`,
      dryRun: false,
      status: "Project.Finished",
    }), "applied", "blocker transition");

    const freshChild = await call(client, "operon_get_task", {
      operonId: childId,
      includeProperties: true,
      forceRefresh: true,
    });
    const childDone = expectStatus(await call(client, "operon_transition_task", {
      operonId: childId,
      expectedRevision: freshChild.task.revision,
      idempotencyKey: `${runId}-child-finish`,
      dryRun: false,
      status: "Project.Finished",
    }), "applied", "child transition after blocker");

    const convertedFile = expectStatus(await call(client, "operon_convert_task", {
      operonId: childId,
      expectedRevision: childDone.after.revision,
      idempotencyKey: `${runId}-to-file`,
      dryRun: false,
      target: "file",
    }), "applied", "inline to file conversion");
    if (convertedFile.after?.source !== "file") throw new Error("Inline-to-file conversion did not change source.");

    const convertedInline = expectStatus(await call(client, "operon_convert_task", {
      operonId: childId,
      expectedRevision: convertedFile.after.revision,
      idempotencyKey: `${runId}-to-inline`,
      dryRun: false,
      target: "inline",
      targetPath: inlineTargetPath,
    }), "applied", "file to inline conversion");
    if (convertedInline.after?.source !== "inline" || convertedInline.after?.path !== inlineTargetPath) {
      throw new Error("File-to-inline conversion did not reach the requested target.");
    }

    console.log(JSON.stringify({
      ok: true,
      runId,
      blocker: {
        operonId: blockerId,
        property: blocker.after.properties?.north_star,
        finalStatus: blockerDone.after.status,
      },
      child: {
        operonId: childId,
        parentTask: child.after.parentTask,
        blockedBy: child.after.blockedBy,
        blockedTransition: blocked.status,
        completedTransition: childDone.status,
        convertedToFile: convertedFile.after.path,
        convertedBackToInline: convertedInline.after.path,
      },
    }, null, 2));
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
