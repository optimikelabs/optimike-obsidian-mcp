#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apply = (process.env.OPERON_MUTATION_SMOKE_APPLY ?? "false").toLowerCase() === "true";
const runId = process.env.OPERON_MUTATION_SMOKE_RUN_ID ?? `smoke-${Date.now()}`;

function parseTool(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block?.text) throw new Error("MCP tool returned no JSON text payload.");
  return JSON.parse(block.text);
}

async function call(client, name, args) {
  return parseTool(await client.callTool({ name, arguments: args }));
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: { ...process.env, MCP_TRANSPORT_TYPE: "stdio" },
  });
  const client = new Client({ name: "operon-mutation-smoke", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const required = [
      "operon_create_task",
      "operon_update_task",
      "operon_transition_task",
      "operon_convert_task",
    ];
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const name of required) {
      if (!names.has(name)) throw new Error(`Missing MCP tool: ${name}`);
    }

    const created = await call(client, "operon_create_task", {
      idempotencyKey: `${runId}-create`,
      dryRun: !apply,
      task: {
        source: "file",
        description: `MCP smoke ${runId}`,
        tags: ["mcp-smoke"],
        fields: { priority: "C", status: "Project.Planned" },
        properties: { north_star: false },
      },
    });
    if (created.status !== (apply ? "applied" : "planned")) {
      throw new Error(`Unexpected create status: ${JSON.stringify(created)}`);
    }
    if (!apply) {
      console.log(JSON.stringify({ ok: true, mode: "dry-run", toolCount: listed.tools.length, created }, null, 2));
      return;
    }

    const operonId = created.after?.operonId;
    if (!operonId || !created.after?.revision) throw new Error("Applied create returned no task identity/revision.");
    const initialRevision = created.after.revision;
    const updated = await call(client, "operon_update_task", {
      operonId,
      expectedRevision: initialRevision,
      idempotencyKey: `${runId}-update`,
      dryRun: false,
      patch: { fields: { priority: "B" }, tags: ["mcp-smoke", "updated"] },
    });
    if (updated.status !== "applied" || updated.after?.priority !== "B") {
      throw new Error(`Update failed: ${JSON.stringify(updated)}`);
    }

    const transitioned = await call(client, "operon_transition_task", {
      operonId,
      expectedRevision: updated.after.revision,
      idempotencyKey: `${runId}-transition`,
      dryRun: false,
      status: "Project.Finished",
    });
    if (transitioned.status !== "applied" || transitioned.after?.checkbox !== "done") {
      throw new Error(`Transition failed: ${JSON.stringify(transitioned)}`);
    }
    const replay = await call(client, "operon_transition_task", {
      operonId,
      expectedRevision: updated.after.revision,
      idempotencyKey: `${runId}-transition`,
      dryRun: false,
      status: "Project.Finished",
    });
    if (!replay.replayed || replay.operationId !== transitioned.operationId) {
      throw new Error(`Idempotency replay failed: ${JSON.stringify(replay)}`);
    }
    const conflict = await call(client, "operon_transition_task", {
      operonId,
      expectedRevision: initialRevision,
      idempotencyKey: `${runId}-conflict`,
      dryRun: false,
      status: "Project.Planned",
    });
    if (conflict.status !== "conflict") {
      throw new Error(`Revision conflict was not detected: ${JSON.stringify(conflict)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      toolCount: listed.tools.length,
      operonId,
      create: created.status,
      update: updated.status,
      transition: transitioned.status,
      replayed: replay.replayed,
      conflict: conflict.status,
    }, null, 2));
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
