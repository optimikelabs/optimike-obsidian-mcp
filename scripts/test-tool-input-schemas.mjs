import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOOL_PROFILE_IDS } from "../dist/mcp-server/toolProfiles.js";
import { measureCanonicalLiveProfileSchemas } from "./measure-tool-profile-schemas.mjs";

function assertOnlyRecursiveRefs(schema, location, root = schema) {
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") {
      assert.match(
        value,
        /^#\/definitions\/recursive_\d+$/u,
        `${location}: only explicit recursive definitions may remain`,
      );
      const name = value.split("/").at(-1);
      assert.ok(root.definitions?.[name], `${location}: ${value} must resolve`);
    }
    assertOnlyRecursiveRefs(value, `${location}.${key}`, root);
  }
}
function checkTools(tools, label) {
  assert.ok(tools.length > 0, `${label}: tools/list must not be empty`);
  for (const tool of tools) {
    assertOnlyRecursiveRefs(
      tool.inputSchema,
      `${label}.${tool.name}.inputSchema`,
    );
    const definitions = tool.inputSchema.definitions ?? {};
    function reaches(start, current, visited = new Set()) {
      if (visited.has(current)) return false;
      visited.add(current);
      const references = JSON.stringify(definitions[current]).matchAll(
        /"\$ref":"#\/definitions\/(recursive_\d+)"/gu,
      );
      for (const [, next] of references) {
        if (next === start || reaches(start, next, visited)) return true;
      }
      return false;
    }
    for (const name of Object.keys(definitions))
      assert.ok(
        reaches(name, name),
        `${label}.${tool.name}: ${name} must be recursive`,
      );
  }
  console.log(`PASS no property $ref: ${label} (${tools.length} tools)`);
}

function checkRecursiveConstraints(tools) {
  const ajv = new Ajv({ strict: false });
  for (const [name, field] of [
    ["obsidian_frontmatter_patch_plan", "operations"],
    ["obsidian_text_patch_plan", "frontmatterOperations"],
  ]) {
    const schema = tools.find((tool) => tool.name === name)?.inputSchema;
    assert.ok(schema, name);
    const value = schema.properties[field].items.anyOf.find(
      (branch) => branch.properties?.op?.const === "set",
    ).properties.value;
    const validate = ajv.compile({ ...value, definitions: schema.definitions });
    assert.equal(
      validate({ nested: [null, true, 3, "text", { deep: ["ok"] }] }),
      true,
      name,
    );
    assert.equal(
      validate({ nested: ["x".repeat(262_145)] }),
      false,
      `${name}: recursive strings must retain maxLength`,
    );
    assert.equal(
      validate({ nested: { deep: Array(257).fill(null) } }),
      false,
      `${name}: recursive arrays must retain maxItems`,
    );
  }
  const schema = tools.find(
    (tool) => tool.name === "bases_config_patch_plan",
  )?.inputSchema;
  assert.ok(schema);
  const filters = schema.properties.operations.items.anyOf.find(
    (branch) => branch.properties?.op?.const === "set_filters",
  ).properties.filters;
  const validate = ajv.compile({ ...filters, definitions: schema.definitions });
  assert.equal(
    validate({ and: [{ or: ['file.hasTag("book")', { not: ["true"] }] }] }),
    true,
  );
  assert.equal(
    validate({ and: [{ or: [42] }] }),
    false,
    "recursive filters stay typed",
  );
  assert.equal(
    validate({ and: [{ or: [] }] }),
    false,
    "recursive filters retain minItems",
  );
  console.log(
    "PASS recursive JSON and Base filters retain nested type and size constraints",
  );
}

// No live application is required: the canonical measurement helper starts an
// authenticated local status fixture, exposing every live-profile registration.
for (const profile of await measureCanonicalLiveProfileSchemas()) {
  checkTools(profile.publicTools, `live-fixture/${profile.profile}`);
  if (["tasks", "operational", "full"].includes(profile.profile)) {
    const pinSchema = profile.publicTools.find(tool => tool.name === "operon_set_pinned")?.inputSchema;
    const batchSchema = profile.publicTools.find(tool => tool.name === "operon_update_tasks")?.inputSchema;
    assert.ok(pinSchema, `${profile.profile}: pin tool is present`);
    assert.ok(batchSchema, `${profile.profile}: batch tool is present`);
    assert.equal(pinSchema.properties.pinned.type, "boolean");
    assert.equal(batchSchema.properties.items.minItems, 2);
    assert.equal(batchSchema.properties.items.maxItems, 64);
    for (const field of ["operonId", "expectedRevision", "patch"])
      assert.ok(batchSchema.properties.items.items.properties[field], `${profile.profile}: batch ${field} is inline`);
  }
  if (profile.profile === "full")
    checkRecursiveConstraints(profile.publicTools);
}

const root = await mkdtemp(path.join(os.tmpdir(), "optimike-input-schemas-"));
const logsParent = path.join(process.cwd(), "logs");
await mkdir(logsParent, { recursive: true });
const logsRoot = await mkdtemp(path.join(logsParent, "input-schemas-"));
try {
  const vault = path.join(root, "vault");
  await mkdir(vault);
  for (const mode of [
    "headless-readonly",
    "headless-guarded",
    "headless-filesystem",
  ]) {
    for (const profile of TOOL_PROFILE_IDS) {
      const state = path.join(root, mode, profile);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js", "--tool-profile", profile],
        cwd: process.cwd(),
        env: {
          ...process.env,
          OBSIDIAN_RUNTIME_MODE: mode,
          OBSIDIAN_VAULT: vault,
          OBSIDIAN_API_KEY: "",
          OBSIDIAN_BASE_URL: "http://127.0.0.1:1",
          OBSIDIAN_CACHE_SOURCE: "filesystem",
          OBSIDIAN_ENABLE_CACHE: "true",
          OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(state, "cache.sqlite"),
          MCP_EXTERNAL_MOVE_JOURNAL_PATH: path.join(state, "external.sqlite"),
          MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(
            state,
            "note.sqlite",
          ),
          MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(
            state,
            "base.sqlite",
          ),
          MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: path.join(state, "canvas.sqlite"),
          LOGS_DIR: path.join(logsRoot, mode, profile),
          MCP_TOOL_PROFILE: profile,
          MCP_TRANSPORT_TYPE: "stdio",
          MCP_WRITE_MODE: "readonly",
          MCP_LOG_LEVEL: "error",
          SEMANTIC_SEARCH_PREWARM: "false",
        },
      });
      const client = new Client({
        name: "input-schema-regression",
        version: "0",
      });
      try {
        await client.connect(transport);
        checkTools((await client.listTools()).tools, `${mode}/${profile}`);
      } finally {
        await client.close();
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(logsRoot, { recursive: true, force: true });
}
