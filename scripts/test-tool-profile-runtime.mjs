import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installToolProfileRegistrationGate } from "../dist/mcp-server/toolProfileRuntime.js";

async function createVault() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "optimike-profile-runtime-"),
  );
  await mkdir(path.join(root, ".obsidian", "optimike-mcp"), {
    recursive: true,
  });
  await writeFile(path.join(root, "Root.md"), "# profile runtime\n", "utf8");
  return root;
}

function envFor(vault, extra = {}) {
  return {
    ...process.env,
    OBSIDIAN_RUNTIME_MODE: "headless-readonly",
    OBSIDIAN_VAULT: vault,
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(
      vault,
      ".obsidian",
      "optimike-mcp",
      "shared-cache.sqlite",
    ),
    OBSIDIAN_ENABLE_CACHE: "true",
    SEMANTIC_SEARCH_PREWARM: "false",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "error",
    MCP_WRITE_MODE: "readonly",
    ...extra,
  };
}

async function openClient({ vault, args = [], env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", ...args],
    cwd: process.cwd(),
    env: envFor(vault, env),
  });
  const client = new Client({
    name: "tool-profile-runtime-test",
    version: "0",
  });
  await client.connect(transport);
  return { client, transport };
}

async function listedNames(client) {
  const result = await client.listTools();
  return result.tools
    .map((tool) => tool.name)
    .sort((a, b) => a.localeCompare(b));
}

function registerSyntheticTool(server, name) {
  return server.tool(
    name,
    `synthetic ${name}`,
    {},
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => ({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
  );
}

// The registration gate is installed before production tools register. A
// governed quartet therefore arrives one member at a time. Partial lifecycles
// must stay hidden rather than throwing or exposing an incomplete contract.
{
  const server = new McpServer(
    { name: "profile-registration-order-test", version: "0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  installToolProfileRegistrationGate(server, "standard");

  const direct = registerSyntheticTool(server, "obsidian_manage_frontmatter");
  assert.equal(direct.enabled, true);

  const governedNames = [
    "obsidian_frontmatter_patch_plan",
    "obsidian_frontmatter_patch_apply",
    "obsidian_frontmatter_patch_status",
    "obsidian_frontmatter_patch_recover",
  ];
  const governedHandles = [];
  for (const [index, name] of governedNames.entries()) {
    governedHandles.push(registerSyntheticTool(server, name));
    if (index < governedNames.length - 1) {
      assert.equal(
        direct.enabled,
        true,
        "direct fallback must remain available while governed registration is partial",
      );
      assert.ok(
        governedHandles.every((handle) => handle.enabled === false),
        "partial governed lifecycle must remain fully hidden",
      );
    }
  }
  assert.equal(
    direct.enabled,
    false,
    "direct fallback must be hidden once the complete governed family exists",
  );
  assert.ok(
    governedHandles.every((handle) => handle.enabled === true),
    "complete governed lifecycle must become visible atomically",
  );
}

const vault = await createVault();
try {
  {
    const { client } = await openClient({ vault });
    try {
      const names = await listedNames(client);
      assert.equal(names.length, 9, "3.0 default must be standard");
      assert.ok(names.includes("smart_semantic_search"));
      assert.ok(!names.includes("smart_search"));
      assert.ok(!names.includes("smart-search"));
      assert.ok(!names.includes("external_read"));
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  {
    const { client } = await openClient({
      vault,
      args: ["--tool-profile", "standard"],
      env: { MCP_TOOL_PROFILE: "full" },
    });
    try {
      const names = await listedNames(client);
      assert.equal(names.length, 9, "CLI standard must override env full");
      assert.ok(names.includes("smart_semantic_search"));
      assert.ok(!names.includes("smart_search"));
      assert.ok(!names.includes("smart-search"));
      assert.ok(!names.includes("external_read"));
      assert.ok(!names.includes("obsidian_runtime_maintenance"));

      let rejected = false;
      try {
        const hidden = await client.callTool({
          name: "external_read",
          arguments: { rootId: "missing", relativePath: "missing.txt" },
        });
        // P0 deliberately keeps the public message value-free. The stable
        // contract here is the failed tool result, not its former prose.
        rejected = hidden.isError === true;
      } catch {
        rejected = true;
      }
      assert.ok(rejected, "a hidden direct-server tool call must be rejected");
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  {
    const { client } = await openClient({
      vault,
      args: ["--tool-profile", "full"],
    });
    try {
      const names = await listedNames(client);
      assert.equal(
        names.length,
        48,
        "explicit full must retain the complete runtime surface",
      );
      assert.ok(names.includes("smart_semantic_search"));
      assert.ok(!names.includes("smart_search"));
      assert.ok(!names.includes("smart-search"));
      assert.ok(names.includes("external_read"));

      const removedAlias = await client.callTool({
        name: "smart_search",
        arguments: { query: "removed alias" },
      });
      assert.equal(removedAlias.isError, true);
      assert.doesNotMatch(
        removedAlias.content.map((item) => item.text ?? "").join("\n"),
        /removed alias/iu,
        "a removed semantic alias must fail without reflecting its request",
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  {
    const previous = process.env.MCP_TOOL_PROFILE;
    process.env.MCP_TOOL_PROFILE = "full";
    const { applyToolProfileCliOverride } =
      await import("../dist/config/toolProfileCli.js");
    applyToolProfileCliOverride(["--tool-profile=tasks"]);
    assert.equal(process.env.MCP_TOOL_PROFILE, "tasks");
    assert.throws(
      () => applyToolProfileCliOverride(["--tool-profile", "nope"]),
      /Unknown MCP tool profile/,
    );
    assert.throws(
      () => applyToolProfileCliOverride(["--tool-profile"]),
      /requires one of/,
    );
    if (previous === undefined) delete process.env.MCP_TOOL_PROFILE;
    else process.env.MCP_TOOL_PROFILE = previous;
  }

  console.log(
    "PASS: direct servers default to standard, explicit full remains available, governed registration is atomic, and removed semantic aliases stay absent",
  );
} finally {
  await rm(vault, { recursive: true, force: true });
}
