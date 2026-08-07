#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
// This script validates the local REST contract without contacting Obsidian.
// Keep the imported service in a deterministic headless profile so CI does not
// require a live API key merely to inspect its prototype.
process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = root;
const context = {
  requestId: "local-rest-api-compat-test",
  timestamp: new Date(0).toISOString(),
  operation: "testLocalRestApiCompat",
};

const { patchActiveFile, patchFile } = await import(
  "../dist/services/obsidianRestAPI/methods/patchMethods.js"
);
const { ObsidianRestApiService } = await import(
  "../dist/services/obsidianRestAPI/service.js"
);
const { ObsidianUpdateNoteInputSchema } = await import(
  "../dist/mcp-server/tools/obsidianUpdateNoteTool/logic.js"
);
const { ObsidianSearchReplaceInputSchema } = await import(
  "../dist/mcp-server/tools/obsidianSearchReplaceTool/logic.js"
);

const legacyPatchHeaders = [
  "Operation",
  "Target",
  "Target-Type",
  "Target-Delimiter",
  "Target-Scope",
  "Trim-Target-Whitespace",
  "Create-Target-If-Missing",
  "Reject-If-Content-Preexists",
  "If-Match",
  "Markdown-Patch-Version",
];

function captureRequests() {
  const calls = [];
  return {
    calls,
    request: async (requestConfig, _context, operationName) => {
      calls.push({ requestConfig, operationName });
    },
  };
}

function assertModernPatch(call, expected) {
  assert.equal(call.requestConfig.method, "PATCH");
  assert.equal(
    call.requestConfig.headers?.["Content-Type"],
    "application/json",
  );
  for (const header of legacyPatchHeaders) {
    assert.equal(
      header in (call.requestConfig.headers ?? {}),
      false,
      `PATCH request must not contain legacy header ${header}`,
    );
  }
  assert.equal(
    typeof call.requestConfig.data,
    "object",
    "PATCH instruction must be passed as a JSON object, not a serialized legacy body",
  );
  assert.deepEqual(call.requestConfig.data, expected);
}

{
  const captured = captureRequests();
  const value = {
    enabled: true,
    retries: 3,
    labels: ["mcp", "rest"],
    nested: { owner: "Mike" },
  };

  await patchFile(
    captured.request,
    "Dossier riche/Note ÉLYSIA.md",
    value,
    {
      operation: "replace",
      targetType: "frontmatter",
      target: "settings",
      createTargetIfMissing: true,
    },
    context,
  );

  assert.equal(captured.calls.length, 1);
  assert.equal(
    captured.calls[0].requestConfig.url,
    "/vault/Dossier%20riche/Note%20%C3%89LYSIA.md",
  );
  assert.equal(captured.calls[0].operationName, "patchFile");
  assertModernPatch(captured.calls[0], {
    targetType: "frontmatter",
    target: "settings",
    operation: "replace",
    createTargetIfMissing: true,
    value,
  });
}

for (const [key, value] of [
  ["text_value", "ready"],
  ["number_value", 42],
  ["boolean_value", false],
  ["null_value", null],
  ["array_value", ["one", 2, true]],
  ["object_value", { nested: { ok: true } }],
]) {
  const captured = captureRequests();
  await patchFile(
    captured.request,
    "Typed frontmatter.md",
    value,
    {
      operation: "replace",
      targetType: "frontmatter",
      target: key,
    },
    context,
  );
  assertModernPatch(captured.calls[0], {
    targetType: "frontmatter",
    target: key,
    operation: "replace",
    value,
  });
}

{
  const captured = captureRequests();
  await patchFile(
    captured.request,
    "Journal.md",
    "\n- item",
    {
      operation: "append",
      targetType: "heading",
      target: ["Journal::2026", "Log"],
      scope: "content",
      within: -1,
      ifMatch: "document-version",
      rejectIfContentPreexists: true,
    },
    context,
  );

  assertModernPatch(captured.calls[0], {
    targetType: "heading",
    target: ["Journal::2026", "Log"],
    operation: "append",
    scope: "content",
    within: -1,
    ifMatch: "document-version",
    rejectIfContentPreexists: true,
    content: "\n- item",
  });
}

{
  const captured = captureRequests();
  await patchFile(
    captured.request,
    "Metadata.md",
    "workflow_state",
    {
      operation: "replace",
      targetType: "frontmatter",
      target: "status",
      scope: "marker",
    },
    context,
  );
  assertModernPatch(captured.calls[0], {
    targetType: "frontmatter",
    target: "status",
    operation: "replace",
    scope: "marker",
    content: "workflow_state",
  });
  assert.equal("value" in captured.calls[0].requestConfig.data, false);
}

{
  const captured = captureRequests();
  await patchActiveFile(
    captured.request,
    undefined,
    {
      operation: "delete",
      targetType: "block",
      target: "obsolete-block",
      scope: "markerAndContent",
    },
    context,
  );

  assert.equal(captured.calls[0].requestConfig.url, "/active/");
  assert.equal(captured.calls[0].operationName, "patchActiveFile");
  assertModernPatch(captured.calls[0], {
    targetType: "block",
    target: "obsolete-block",
    operation: "delete",
    scope: "markerAndContent",
  });
  assert.equal("content" in captured.calls[0].requestConfig.data, false);
  assert.equal("value" in captured.calls[0].requestConfig.data, false);
  assert.equal("destination" in captured.calls[0].requestConfig.data, false);
}

await assert.rejects(
  () =>
    patchFile(
      async () => undefined,
      "Invalid.md",
      undefined,
      {
        operation: "replace",
        targetType: "heading",
        target: ["Missing carrier"],
      },
      context,
    ),
  /payload|carrier|content|value/i,
  "A non-delete PATCH without a carrier must fail locally",
);

await assert.rejects(
  () =>
    patchFile(
      async () => undefined,
      "Invalid.md",
      "unexpected payload",
      {
        operation: "delete",
        targetType: "heading",
        target: ["Delete target"],
      },
      context,
    ),
  /delete|payload|carrier/i,
  "A delete PATCH carrying a payload must fail locally",
);

for (const [name, schema, input] of [
  [
    "obsidian_update_note",
    ObsidianUpdateNoteInputSchema,
    {
      targetType: "periodicNote",
      targetIdentifier: "daily",
      modificationType: "wholeFile",
      wholeFileMode: "overwrite",
      content: "# Daily",
    },
  ],
  [
    "obsidian_search_replace",
    ObsidianSearchReplaceInputSchema,
    {
      targetType: "periodicNote",
      targetIdentifier: "daily",
      replacements: [{ search: "before", replace: "after" }],
    },
  ],
]) {
  assert.equal(
    schema.safeParse(input).success,
    false,
    `${name} must reject the removed periodicNote target`,
  );
}

for (const method of [
  "getPeriodicNote",
  "updatePeriodicNote",
  "appendPeriodicNote",
  "deletePeriodicNote",
  "patchPeriodicNote",
]) {
  assert.equal(
    typeof ObsidianRestApiService.prototype[method],
    "undefined",
    `Local REST core service must not expose removed ${method}`,
  );
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files;
}

const restCore = path.join(root, "src", "services", "obsidianRestAPI");
for (const file of await sourceFiles(restCore)) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(
    source,
    /\/periodic\//,
    `${path.relative(root, file)} reintroduces a removed core /periodic route`,
  );
}

const vendoredSpec = JSON.parse(
  await readFile(
    path.join(root, "docs", "obsidian-api", "obsidian_rest_api_spec.json"),
    "utf8",
  ),
);
assert.ok(
  vendoredSpec.components?.schemas?.PatchInstruction,
  "Vendored Local REST API spec must expose PatchInstruction",
);
assert.equal(
  Object.keys(vendoredSpec.paths).some((apiPath) =>
    apiPath.startsWith("/periodic/"),
  ),
  false,
  "Vendored Local REST API 5.0.2 spec must not expose core periodic routes",
);
assert.equal(
  vendoredSpec.paths["/vault/{filename}"].patch.requestBody.content[
    "application/json"
  ].schema.$ref,
  "#/components/schemas/PatchInstruction",
);

console.log(
  "PASS: Local REST API 5.x JSON PATCH contract and core periodic-route removal",
);
