import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { publicBatchItemErrorPayload } = await import(
  "../dist/mcp-server/server.js"
);
const { BaseErrorCode, McpError } = await import(
  "../dist/types-global/errors.js"
);

const callerPathMarker = "P0-BATCH-CALLER-PATH-7df7";
const backendMessageMarker = "P0-BATCH-BACKEND-MESSAGE-192c";

const cases = [
  {
    toolName: "obsidian_batch_frontmatter",
    operation: "obsidian_batch_frontmatter:item",
    params: {
      filePath: `${callerPathMarker}.md`,
      set: { confidential: callerPathMarker },
    },
  },
  {
    toolName: "obsidian_admin_filesystem",
    operation: "obsidian_admin_filesystem:item",
    params: {
      sourcePath: `${callerPathMarker}.md`,
      targetPath: `Archive/${callerPathMarker}.md`,
      expectedHash: callerPathMarker,
    },
  },
  {
    toolName: "bases_upsert_rows",
    operation: "bases_upsert_rows:item",
    params: {
      file: `${callerPathMarker}.md`,
      set: { confidential: callerPathMarker },
    },
  },
];

for (const [itemIndex, testCase] of cases.entries()) {
  const item = publicBatchItemErrorPayload(
    new McpError(
      BaseErrorCode.CONFLICT,
      `backend refused ${backendMessageMarker}`,
      {
        backendMessage: backendMessageMarker,
        payload: testCase.params,
      },
    ),
    { ...testCase, itemIndex },
  );
  const serialized = JSON.stringify(item);

  assert.equal(item.itemIndex, itemIndex);
  assert.equal(item.ok, false);
  assert.equal(item.error.code, BaseErrorCode.CONFLICT);
  assert.equal(
    item.error.message,
    "The request conflicts with the current resource state.",
  );
  assert.match(
    item.error.details.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.deepEqual(Object.keys(item.error.details), ["requestId"]);
  assert.equal("file" in item, false);
  assert.equal("filePath" in item, false);
  assert.equal("sourcePath" in item, false);
  assert.doesNotMatch(serialized, new RegExp(callerPathMarker, "u"));
  assert.doesNotMatch(serialized, new RegExp(backendMessageMarker, "u"));
}

const source = readFileSync(
  path.join(process.cwd(), "src/mcp-server/server.ts"),
  "utf8",
);
for (const { toolName, operation } of cases) {
  const toolOffset = source.indexOf(`\"${toolName}\"`);
  assert.ok(toolOffset >= 0, `${toolName} must remain registered`);
  const nextToolOffset = source.indexOf("server.tool(", toolOffset + 1);
  const toolSource = source.slice(
    toolOffset,
    nextToolOffset >= 0 ? nextToolOffset : undefined,
  );
  assert.match(toolSource, /publicBatchItemErrorPayload\(error/u);
  assert.match(toolSource, new RegExp(`operation: \"${operation}\"`, "u"));
  assert.match(toolSource, /itemIndex,/u);
  assert.doesNotMatch(toolSource, /error instanceof Error \? error\.message/u);
}

console.log("Batch item error privacy contract passed.");
