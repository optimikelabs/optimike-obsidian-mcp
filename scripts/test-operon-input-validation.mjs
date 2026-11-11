import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod/v3";

process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";
const { OperonService } = await import("../dist/services/operon/service.js");
const { registerOperonTools } = await import(
  "../dist/mcp-server/tools/operonTools/registration.js"
);
const { installMcpToolPublicErrorBoundary } = await import(
  "../dist/mcp-server/toolErrorBoundary.js"
);
const { publicMcpToolErrorPayload } = await import(
  "../dist/utils/internal/errorHandler.js"
);
const { parseToolInput } = await import(
  "../dist/utils/internal/toolInputValidation.js"
);
const { McpError, BaseErrorCode } = await import(
  "../dist/types-global/errors.js"
);
const service = new OperonService();
const payload = (error, params = {}) =>
  publicMcpToolErrorPayload(error, {
    operation: "operon_create_task",
    toolName: "operon_create_task",
    params,
  });
const rejectsInput = async (method, params) => {
  params = { idempotencyKey: "input-validation-159", ...params };
  try {
    await service[method](params);
  } catch (error) {
    return payload(error, params);
  }
  assert.fail(`${method} must reject invalid input before dispatch`);
};
const task = {
  source: "inline",
  description: "Private caller description",
  targetPath: "Projects/Private.md",
};

// Service input parsing maps consistently, redacts record keys and never echoes
// Zod's unknown-key, enum, type or received-value diagnostics.
for (const [record, value] of [
  ["fields", 42],
  ["properties", { nested: "private-value" }],
]) {
  const result = await rejectsInput("createTask", {
    task: { ...task, [record]: { "Private Caller Key": value } },
  });
  assert.equal(result.error.code, "VALIDATION_ERROR");
  assert.equal(result.error.details.reasonCode, "invalid_tool_arguments");
  assert.deepEqual(result.error.details.validationIssues, [
    {
      path: `task.${record}.*`,
      message: "Invalid value for this field.",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Private Caller Key|private-value|Private caller|Private\.md/u,
  );
}
const unknown = await rejectsInput("createTask", {
  task: { ...task, "Private Unknown Key": true },
});
assert.doesNotMatch(JSON.stringify(unknown), /Private Unknown Key/u);
const invalidEnum = await rejectsInput("createTask", {
  task: { ...task, source: "private-source" },
});
assert.doesNotMatch(JSON.stringify(invalidEnum), /private-source/u);
const conversion = await rejectsInput("convertTask", {
  operonId: "abc1234",
  expectedRevision: "r1",
  target: "inline",
});
assert.deepEqual(conversion.error.details.validationIssues, [
  {
    path: "targetPath",
    message: "targetPath is required for file-to-inline conversion.",
  },
]);
const relationship = await rejectsInput("setRelationships", {
  operonId: "abc1234",
  expectedRevision: "r1",
  relationships: { blocking: ["secret1"], blockedBy: ["secret1"] },
});
assert.equal(relationship.error.code, "VALIDATION_ERROR");
assert.doesNotMatch(
  JSON.stringify(relationship),
  /secret1/u,
  "even custom issues can contain received values",
);

// #160 uses the same public parsing boundary for pins and batch updates.
const pin = await rejectsInput("setPinned", {
  operonId: "abc1234", expectedRevision: "r1", pinned: "Private Pin Value",
});
assert.equal(pin.error.code, "VALIDATION_ERROR");
assert.deepEqual(pin.error.details.validationIssues, [
  { path: "pinned", message: "Invalid value for this field." },
]);
assert.doesNotMatch(JSON.stringify(pin), /Private Pin Value/u);
const batchItem = {
  operonId: "abc1234", expectedRevision: "r1", patch: { description: "Private Batch Description" },
};
const duplicateBatch = await rejectsInput("updateTasks", { items: [batchItem, batchItem] });
assert.equal(duplicateBatch.error.code, "VALIDATION_ERROR");
assert.deepEqual(duplicateBatch.error.details.validationIssues, [
  { path: "items", message: "Batch task ids must be unique." },
]);
assert.doesNotMatch(JSON.stringify(duplicateBatch), /abc1234|Private Batch Description/u);
const unmanagedBatch = await rejectsInput("updateTasks", { items: [batchItem, {
  ...batchItem, operonId: "def5678", patch: { properties: { "Private Property": "Private Value" } },
}] });
assert.equal(unmanagedBatch.error.code, "VALIDATION_ERROR");
assert.deepEqual(unmanagedBatch.error.details.validationIssues, [
  { path: "items.*.patch.properties", message: "Batch update accepts managed fields only." },
]);
assert.doesNotMatch(JSON.stringify(unmanagedBatch), /Private Property|Private Value|def5678/u);
const invalidBatchField = await rejectsInput("updateTasks", { items: [batchItem, {
  ...batchItem, operonId: "def5678", patch: { fields: { "Private Field Key": 42 } },
}] });
assert.deepEqual(invalidBatchField.error.details.validationIssues, [
  { path: "items.*.patch.fields.*", message: "Invalid value for this field." },
]);
assert.doesNotMatch(JSON.stringify(invalidBatchField), /Private Field Key|Private Batch Description/u);
console.log("PASS #160: pin and batch input refusals preserve authored messages and redact caller data");

// An untrusted McpError cannot inject a diagnostic array, nor can an upstream
// output ZodError be mistaken for a validated service input failure.
const forged = payload(
  new McpError(BaseErrorCode.VALIDATION_ERROR, "private", {
    reasonCode: "invalid_tool_arguments",
    validationIssues: [{ path: "private-path", message: "private-message" }],
  }),
);
assert.equal(forged.error.details.validationIssues, undefined);
assert.doesNotMatch(JSON.stringify(forged), /private-path|private-message/u);
const rawZod = payload(
  new z.ZodError([
    { code: "custom", path: ["private-path"], message: "private-message" },
  ]),
);
assert.equal(rawZod.error.details.validationIssues, undefined);
assert.doesNotMatch(JSON.stringify(rawZod), /private-path|private-message/u);
// Nested objects, arrays and unknown refinement paths never disclose a free key.
try {
  parseToolInput(
    z.object({ declared: z.array(z.record(z.object({ known: z.string() }))) }),
    { declared: [{ "Secret Record Key": { known: 7 } }] },
    new Set(),
  );
  assert.fail("must fail");
} catch (error) {
  assert.deepEqual(payload(error).error.details.validationIssues, [
    {
      path: "declared.*.*.known",
      message: "Invalid value for this field.",
    },
  ]);
  assert.ok(Object.isFrozen(error.details.validationIssues));
  assert.ok(Object.isFrozen(error.details.validationIssues[0]));
}

// Exercise the real registration, SDK validation and public error boundary.
// Only dispatch is stubbed; no Bridge, user's vault or mutation is touched.
const server = new McpServer({ name: "operon-input-validation", version: "0" });
installMcpToolPublicErrorBoundary(server);
await registerOperonTools(server);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({
  name: "operon-input-validation-test",
  version: "0",
});
const executeMutation = OperonService.prototype.executeMutation;
let dispatches = 0;
OperonService.prototype.executeMutation = async (...args) => {
  dispatches++;
  assert.equal(args[0], "create");
  assert.equal(args[3], true, "dryRun retains its default");
  assert.equal(args[5].task.targetPath, task.targetPath);
  return { ok: true, status: "planned" };
};
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = (await client.listTools()).tools.find(
    (tool) => tool.name === "operon_create_task",
  );
  const properties = listed.inputSchema.properties.task.properties;
  assert.match(
    properties.targetPath.description,
    /Destination Markdown note of an inline task/u,
  );
  assert.match(
    properties.targetPath.description,
    /Not valid with source: "file"/u,
  );
  assert.match(
    properties.targetFolder.description,
    /Legacy engine routing only/u,
  );
  assert.notEqual(
    properties.targetPath.description,
    properties.targetFolder.description,
  );
  assert.match(listed.description, /configured file-task folder/u);
  assert.match(
    listed.description,
    /fields.related takes Operon task ids; note links go in fields.links/u,
  );
  const refused = await client.callTool({
    name: "operon_create_task",
    arguments: {
      idempotencyKey: "refused-159",
      task: { ...task, source: "file" },
    },
  });
  assert.equal(refused.isError, true);
  const result = JSON.parse(refused.content[0].text);
  assert.equal(result.error.code, "VALIDATION_ERROR");
  assert.equal(result.error.details.reasonCode, "invalid_tool_arguments");
  assert.deepEqual(result.error.details.validationIssues, [
    {
      path: "task.targetPath",
      message: "targetPath is supported only for inline tasks.",
    },
  ]);
  const recordRefusal = await client.callTool({
    name: "operon_create_task",
    arguments: {
      idempotencyKey: "record-159",
      task: { ...task, fields: { status: ["private-status"] } },
    },
  });
  const recordPayload = JSON.parse(recordRefusal.content[0].text);
  assert.equal(recordPayload.error.code, "VALIDATION_ERROR");
  assert.equal(
    recordPayload.error.details.validationIssues[0].path,
    "task.fields.*",
  );
  assert.match(
    recordPayload.error.details.validationIssues[0].message,
    /requires one scalar string/u,
  );
  assert.doesNotMatch(JSON.stringify(recordPayload), /private-status/u);
  assert.equal(dispatches, 0, "refusals dispatch no mutation");
  const accepted = await client.callTool({
    name: "operon_create_task",
    arguments: { idempotencyKey: "accepted-159", task },
  });
  assert.notEqual(accepted.isError, true);
  assert.equal(JSON.parse(accepted.content[0].text).status, "planned");
  assert.equal(dispatches, 1);
} finally {
  OperonService.prototype.executeMutation = executeMutation;
  await client.close();
  await server.close();
}
console.log(
  "PASS #159: Operon input refusals name safe fields, preserve author messages and accept inline targetPath through MCP",
);
