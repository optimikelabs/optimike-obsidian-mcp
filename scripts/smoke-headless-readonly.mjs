#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./test-support/isolated-state.mjs";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "60000");
const modeArg =
  process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] ??
  "headless-readonly";
if (
  ![
    "headless-readonly",
    "hybrid",
    "hybrid-live",
    "headless-guarded",
    "headless-filesystem",
  ].includes(modeArg)
) {
  throw new Error(`Unsupported smoke mode: ${modeArg}`);
}
const runtimeMode = modeArg === "hybrid-live" ? "hybrid" : modeArg;

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertTextIncludes(result, needle, label) {
  const text = result.content?.map((item) => item.text ?? "").join("\n") ?? "";
  if (!text.includes(needle)) {
    throw new Error(
      `${label} did not include ${JSON.stringify(needle)}: ${text}`,
    );
  }
  return text;
}

function jsonOf(result, label) {
  const text = result.content?.map((item) => item.text ?? "").join("\n") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text}`);
  }
}

async function createTempVault() {
  const vaultRoot = await mkdtemp(
    path.join(os.tmpdir(), "optimike-headless-vault-"),
  );
  await mkdir(path.join(vaultRoot, "Projects"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Canvases"), { recursive: true });
  await mkdir(path.join(vaultRoot, "tmp", "reports"), { recursive: true });
  await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  const dateDirectory = path.join(vaultRoot, ".obsidian", "plugins", "frontmatter-date-manager");
  await mkdir(dateDirectory, { recursive: true });
  await writeFile(path.join(vaultRoot, ".obsidian", "community-plugins.json"), '["frontmatter-date-manager"]');
  await writeFile(path.join(dateDirectory, "data.json"), JSON.stringify({
    enableAutoUpdate: true, enableCreateTime: true, headerCreated: "created_at",
    headerUpdated: "updated_at", dateFormat: "yyyy-MM-dd'T'HH:mm:ss", filterRules: "",
  }));
  await writeFile(
    path.join(vaultRoot, "Projects", "Headless.md"),
    [
      "---",
      "type: smoke",
      "tags:",
      "  - headless",
      "---",
      "",
      "Headless runtime smoke note.",
      "Related note: [[Root]].",
      "> [!info]",
      "> Format validation callout.",
      "![[Canvases/Flow.canvas]]",
      "- [ ] Verify task extraction #headless",
      "- [x] Keep live mode as rollback",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, "Root.md"),
    [
      "---",
      "type: root",
      "---",
      "",
      "Root smoke note with searchable keyword alphasmoke.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, "tmp", "reports", "Excluded.md"),
    [
      "---",
      "type: excluded",
      "---",
      "",
      "This operational scratch note contains excluded keyword betasmoke.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, "Smoke.base"),
    [
      "properties:",
      "  file.name:",
      "    displayName: Name",
      "  type:",
      "    displayName: Type",
      "  formula.priority_label:",
      "    displayName: Priority",
      "formulas:",
      '  priority_label: \'if(priority, "P" + priority.toString(), "")\'',
      "filters:",
      "  and:",
      "    - 'file.ext == \"md\"'",
      "views:",
      "  - type: table",
      "    name: Active",
      "    order:",
      "      - file.name",
      "      - type",
      "      - formula.priority_label",
      "    sort:",
      "      - property: file.name",
      "        direction: ASC",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, "Canvases", "Flow.canvas"),
    JSON.stringify(
      {
        nodes: [
          {
            id: "aaaaaaaaaaaaaaaa",
            type: "text",
            x: 0,
            y: 0,
            width: 320,
            height: 180,
            text: "Start",
          },
          {
            id: "bbbbbbbbbbbbbbbb",
            type: "text",
            x: 420,
            y: 0,
            width: 320,
            height: 180,
            text: "End",
          },
        ],
        edges: [
          {
            id: "cccccccccccccccc",
            fromNode: "aaaaaaaaaaaaaaaa",
            toNode: "bbbbbbbbbbbbbbbb",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return vaultRoot;
}

async function main() {
  const vaultRoot = await createTempVault();
  const cachePath = path.join(
    vaultRoot,
    ".obsidian",
    "optimike-mcp",
    "shared-cache.sqlite",
  );
  let fakeRestServer;
  let fakeRestUrl;
  if (modeArg === "hybrid-live") {
    const { createServer } = await import("node:http");
    fakeRestServer = createServer(async (request, response) => {
      if (request.url === "/") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            service: "Obsidian Local REST API",
            authenticated: true,
            versions: { obsidian: "smoke", self: "smoke" },
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/vault/") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ files: ["Projects/", "Root.md"] }));
        return;
      }
      if (request.method === "GET" && request.url === "/vault/Projects/") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ files: ["Headless.md"] }));
        return;
      }
      if (request.url?.startsWith("/vault/")) {
        const relativePath = decodeURIComponent(
          request.url.replace(/^\/vault\//u, ""),
        );
        const absolutePath = path.join(vaultRoot, relativePath);
        try {
          const fileStat = await stat(absolutePath);
          response.setHeader(
            "x-obsidian-mtime",
            String(fileStat.mtimeMs / 1000),
          );
          response.setHeader(
            "x-obsidian-ctime",
            String(fileStat.ctimeMs / 1000),
          );
          if (request.method === "HEAD") {
            response.setHeader("content-length", String(fileStat.size));
            response.statusCode = 200;
            response.end();
            return;
          }
          if (request.method === "GET") {
            const content = await readFile(absolutePath, "utf8");
            const accept = request.headers.accept ?? "";
            if (String(accept).includes("application/vnd.olrapi.note+json")) {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  content,
                  frontmatter: {},
                  path: relativePath,
                  stat: {
                    ctime: Math.round(fileStat.ctimeMs),
                    mtime: Math.round(fileStat.mtimeMs),
                    size: fileStat.size,
                  },
                  tags: [],
                }),
              );
            } else {
              response.setHeader("content-type", "text/markdown");
              response.end(content);
            }
            return;
          }
        } catch {
          response.statusCode = 404;
          response.end("not found");
          return;
        }
      }
      if (
        request.method === "POST" &&
        request.url?.startsWith("/search/simple/")
      ) {
        const url = new URL(request.url, fakeRestUrl);
        const query = url.searchParams.get("query") ?? "";
        const files = ["Root.md", "Projects/Headless.md"];
        const matches = [];
        for (const file of files) {
          const content = await readFile(path.join(vaultRoot, file), "utf8");
          if (content.includes(query)) {
            matches.push({
              filename: file,
              matches: [{ context: content.slice(0, 200) }],
            });
          }
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(matches));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    await new Promise((resolve) =>
      fakeRestServer.listen(0, "127.0.0.1", resolve),
    );
    const address = fakeRestServer.address();
    fakeRestUrl = `http://127.0.0.1:${address.port}`;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: runtimeMode,
      OBSIDIAN_VAULT: vaultRoot,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
      OBSIDIAN_VAULT_EXCLUDE_PATTERNS: "tmp/**,**/tmp/**",
      OBSIDIAN_ENABLE_CACHE: "true",
      MCP_WRITE_MODE:
        modeArg === "headless-guarded" || modeArg === "headless-filesystem"
          ? "guarded"
          : "readonly",
      OBSIDIAN_API_KEY: modeArg === "hybrid-live" ? "smoke-key" : "",
      OBSIDIAN_BASE_URL: fakeRestUrl ?? "http://127.0.0.1:9",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      // This broad runtime smoke validates every registered capability. The
      // 3.0 default-standard contract is covered by dedicated profile tests.
      MCP_TOOL_PROFILE: "full",
      MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
      TZ: "UTC",
      OPTIMIKE_VAULT_TIMEZONE: "UTC",
      MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE: "true",
    },
  });
  const client = new Client({
    name: "optimike-headless-readonly-smoke",
    version: "0",
  });

  try {
    await withTimeout(client.connect(transport), "connect");

    // Give the background filesystem cache build a short window. The tool calls
    // below also fail loudly if cache readiness does not arrive.
    await new Promise((resolve) => setTimeout(resolve, 750));

    const tools = await withTimeout(client.listTools(), "listTools");
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const unannotatedTools = tools.tools.filter((tool) => {
      const annotations = tool.annotations;
      return (
        !annotations ||
        typeof annotations.readOnlyHint !== "boolean" ||
        typeof annotations.destructiveHint !== "boolean" ||
        typeof annotations.idempotentHint !== "boolean" ||
        typeof annotations.openWorldHint !== "boolean"
      );
    });
    if (unannotatedTools.length > 0) {
      throw new Error(
        `MCP tools missing complete safety annotations: ${unannotatedTools
          .map((tool) => tool.name)
          .join(", ")}`,
      );
    }
    const overwriteCapableTools = new Set([
      "bases_create",
      "bases_upsert_config",
      "bases_upsert_rows",
      "obsidian_admin_filesystem",
      "obsidian_delete_note",
      "obsidian_manage_canvas",
      "obsidian_manage_frontmatter",
      "obsidian_manage_tags",
      "obsidian_move_note",
      "obsidian_search_replace",
      "obsidian_update_note",
    ]);
    const unsafeOverwriteAnnotations = tools.tools.filter(
      (tool) =>
        overwriteCapableTools.has(tool.name) &&
        tool.annotations?.destructiveHint !== true,
    );
    if (unsafeOverwriteAnnotations.length > 0) {
      throw new Error(
        `Overwrite-capable MCP tools not marked destructive: ${unsafeOverwriteAnnotations
          .map((tool) => tool.name)
          .join(", ")}`,
      );
    }
    const semanticSearchNames = new Set(["smart_semantic_search"]);
    const closedWorldSemanticSearchTools = tools.tools.filter(
      (tool) =>
        semanticSearchNames.has(tool.name) &&
        tool.annotations?.openWorldHint !== true,
    );
    if (closedWorldSemanticSearchTools.length > 0) {
      throw new Error(
        `Semantic search tools not marked open-world: ${closedWorldSemanticSearchTools
          .map((tool) => tool.name)
          .join(", ")}`,
      );
    }
    for (const removedAlias of ["smart_search", "smart-search"]) {
      if (toolsByName.has(removedAlias)) {
        throw new Error(`${removedAlias} must be physically absent in 3.0.`);
      }
    }

    const routingDescriptionContracts = [
      ["obsidian_update_note", "obsidian_note_replace_plan"],
      ["obsidian_search_replace", "obsidian_text_patch_plan"],
      ["obsidian_manage_frontmatter", "obsidian_frontmatter_patch_plan"],
      ["bases_upsert_config", "bases_formula_patch_plan"],
      ["list_all_tasks", "operon_list_tasks"],
      ["query_tasks", "operon_query_tasks"],
    ];
    for (const [directName, preferredName] of routingDescriptionContracts) {
      const direct = toolsByName.get(directName);
      const preferred = toolsByName.get(preferredName);
      if (direct && preferred && !direct.description?.includes(preferredName)) {
        throw new Error(
          `${directName} overlaps ${preferredName} but its exposed description does not route callers to the governed/canonical tool.`,
        );
      }
    }

    const taskDescriptionContracts = [
      [
        "list_all_tasks",
        [
          "vault-relative",
          "defaults to the vault root",
          "traversal components (`..`)",
          "operon_list_tasks",
        ],
      ],
      [
        "query_tasks",
        [
          "newline-separated query line",
          "combined with AND logic",
          "`not done`",
          "`tag include #foo/bar`",
          "vault-relative",
          "operon_query_tasks",
        ],
      ],
    ];
    for (const [toolName, requiredFragments] of taskDescriptionContracts) {
      const description = toolsByName.get(toolName)?.description ?? "";
      for (const fragment of requiredFragments) {
        if (!description.includes(fragment)) {
          throw new Error(
            `${toolName} description lost its client-visible contract fragment: ${fragment}`,
          );
        }
      }
    }

    const resources = await withTimeout(
      client.listResources(),
      "listResources",
    );
    const routingResource = resources.resources.find(
      (resource) => resource.uri === "optimike://guides/tool-routing",
    );
    if (!routingResource || routingResource.mimeType !== "text/markdown") {
      throw new Error(
        "Missing canonical optimike://guides/tool-routing MCP resource.",
      );
    }
    const routingGuide = await withTimeout(
      client.readResource({ uri: routingResource.uri }),
      "readRoutingResource",
    );
    const routingText = routingGuide.contents
      .map((content) => ("text" in content ? content.text : ""))
      .join("\n");
    for (const requiredText of [
      "smart_semantic_search",
      "operon_query_tasks",
      "obsidian_note_replace_plan",
      "obsidian_frontmatter_patch_plan",
      "bases_formula_patch_plan",
      "There is intentionally no generic public `operation_*` surface.",
    ]) {
      if (!routingText.includes(requiredText)) {
        throw new Error(
          `Tool-routing resource is missing required contract text: ${requiredText}`,
        );
      }
    }
    const expected = [
      "obsidian_list_notes",
      "obsidian_read_note",
      "obsidian_global_search",
      "list_all_tasks",
      "query_tasks",
      "obsidian_runtime_status",
      "obsidian_runtime_maintenance",
      "obsidian_validate_format",
    ];
    if (
      ["headless-readonly", "headless-guarded", "headless-filesystem"].includes(
        modeArg,
      )
    ) {
      expected.push("bases_list", "bases_get_schema", "bases_query");
    }
    for (const name of expected) {
      if (!toolNames.includes(name)) {
        throw new Error(`Missing expected headless-readonly tool: ${name}`);
      }
    }
    const liveOnly = [
      "obsidian_update_note",
      "obsidian_delete_note",
      "obsidian_search_replace",
      "obsidian_manage_frontmatter",
      "obsidian_manage_tags",
      "bases_create",
      "bases_upsert_config",
      "bases_upsert_rows",
    ];
    for (const name of liveOnly) {
      if (
        modeArg === "hybrid-live" ||
        (modeArg === "headless-filesystem" &&
          [
            "obsidian_delete_note",
            "obsidian_move_note",
            "obsidian_admin_filesystem",
            "obsidian_manage_canvas",
            "bases_create",
            "bases_upsert_config",
          ].includes(name))
      ) {
        if (!toolNames.includes(name)) {
          throw new Error(`Expected write tool in ${modeArg}: ${name}`);
        }
      } else if (toolNames.includes(name)) {
        throw new Error(
          `Live/write tool should not be registered in ${modeArg}: ${name}`,
        );
      }
    }
    const filesystemOnly = [
      "obsidian_move_note",
      "obsidian_admin_filesystem",
      "obsidian_manage_canvas",
    ];
    for (const name of filesystemOnly) {
      if (modeArg === "headless-filesystem") {
        if (!toolNames.includes(name)) {
          throw new Error(`Expected filesystem tool in ${modeArg}: ${name}`);
        }
      } else if (toolNames.includes(name)) {
        throw new Error(
          `Filesystem-only tool should not be registered in ${modeArg}: ${name}`,
        );
      }
    }

    const status = await withTimeout(
      client.callTool({ name: "obsidian_runtime_status", arguments: {} }),
      "runtime status",
    );
    assertTextIncludes(status, runtimeMode, "runtime status");

    const list = await withTimeout(
      client.callTool({
        name: "obsidian_list_notes",
        arguments: { dirPath: "/", responseMode: "compact" },
      }),
      "list notes",
    );
    assertTextIncludes(list, "Projects/Headless.md", "list notes");

    const read = await withTimeout(
      client.callTool({
        name: "obsidian_read_note",
        arguments: { filePath: "Projects/Headless.md", format: "markdown" },
      }),
      "read note",
    );
    assertTextIncludes(read, "Headless runtime smoke note", "read note");

    const markdownValidation = await withTimeout(
      client.callTool({
        name: "obsidian_validate_format",
        arguments: {
          kind: "markdown",
          filePath: "Projects/Headless.md",
        },
      }),
      "markdown format validation",
    );
    assertTextIncludes(markdownValidation, '"ok": true', "markdown validation");
    assertTextIncludes(markdownValidation, "wikilinks", "markdown validation");

    const nameValidation = await withTimeout(
      client.callTool({
        name: "obsidian_validate_format",
        arguments: { kind: "note_name", filePath: "Projets/Réunion: suite #2.md" },
      }),
      "note name validation",
    );
    assertTextIncludes(nameValidation, '"ok": false', "note name validation");
    assertTextIncludes(nameValidation, "note_name_forbidden_character", "note name validation");
    assertTextIncludes(nameValidation, "Projets/Réunion — suite 2.md", "note name validation");
    const goodName = await withTimeout(
      client.callTool({
        name: "obsidian_validate_format",
        arguments: { kind: "note_name", filePath: "Projets/Réunion — suite (2).md" },
      }),
      "note name validation (valid)",
    );
    assertTextIncludes(goodName, '"ok": true', "note name validation (valid)");

    const canvasValidation = await withTimeout(
      client.callTool({
        name: "obsidian_validate_format",
        arguments: {
          kind: "canvas",
          filePath: "Canvases/Flow.canvas",
        },
      }),
      "canvas format validation",
    );
    assertTextIncludes(canvasValidation, '"ok": true', "canvas validation");
    assertTextIncludes(canvasValidation, "edges", "canvas validation");

    const search = await withTimeout(
      client.callTool({
        name: "obsidian_global_search",
        arguments: {
          query: "alphasmoke",
          page: 1,
          pageSize: 10,
          maxMatchesPerFile: 3,
          responseMode: "compact",
        },
      }),
      "global search",
    );
    assertTextIncludes(search, "Root.md", "global search");

    const excludedSearch = await withTimeout(
      client.callTool({
        name: "obsidian_global_search",
        arguments: {
          query: "betasmoke",
          page: 1,
          pageSize: 10,
          maxMatchesPerFile: 3,
          responseMode: "compact",
        },
      }),
      "excluded global search",
    );
    if (
      assertTextIncludes(
        excludedSearch,
        "totalFiles",
        "excluded global search",
      ).includes("Excluded.md")
    ) {
      throw new Error(
        "Vault exclusion policy failed: tmp/Excluded.md was indexed",
      );
    }

    const tasks = await withTimeout(
      client.callTool({
        name: "list_all_tasks",
        arguments: {
          path: "/",
          responseFormat: "json",
          responseMode: "compact",
        },
      }),
      "list tasks",
    );
    assertTextIncludes(tasks, "Verify task extraction", "list tasks");

    const queryTasks = await withTimeout(
      client.callTool({
        name: "query_tasks",
        arguments: {
          path: "/",
          query: "not done",
          responseFormat: "json",
          responseMode: "compact",
        },
      }),
      "query tasks",
    );
    assertTextIncludes(queryTasks, "Verify task extraction", "query tasks");

    if (
      ["headless-readonly", "headless-guarded", "headless-filesystem"].includes(
        modeArg,
      )
    ) {
      const bases = await withTimeout(
        client.callTool({ name: "bases_list", arguments: {} }),
        "bases list",
      );
      assertTextIncludes(bases, "local-fallback", "bases list");
      assertTextIncludes(bases, "Smoke.base", "bases list");

      const schema = await withTimeout(
        client.callTool({
          name: "bases_get_schema",
          arguments: { base_id: "Smoke.base" },
        }),
        "bases schema",
      );
      assertTextIncludes(schema, "local-fallback", "bases schema");
      assertTextIncludes(schema, "file.name", "bases schema");

      const query = await withTimeout(
        client.callTool({
          name: "bases_query",
          arguments: {
            base_id: "Smoke.base",
            filter: { type: "root" },
            sort: [{ prop: "file.name", dir: "asc" }],
            limit: 10,
            page: 1,
          },
        }),
        "bases query",
      );
      assertTextIncludes(query, "local-fallback", "bases query");
      assertTextIncludes(query, "Root.md", "bases query");

      const baseValidation = await withTimeout(
        client.callTool({
          name: "obsidian_validate_format",
          arguments: {
            kind: "base",
            filePath: "Smoke.base",
          },
        }),
        "base format validation",
      );
      assertTextIncludes(baseValidation, '"ok": true', "base validation");
      assertTextIncludes(
        baseValidation,
        "formulaReferences",
        "base validation",
      );
    }

    if (modeArg === "headless-guarded" || modeArg === "headless-filesystem") {
      assert.ok(!toolNames.includes("obsidian_batch_frontmatter"));
      const textPatch = async (key, filePath = "Projects/Headless.md") => {
        return client.callTool({ name: "obsidian_text_patch_plan", arguments: {
          path: filePath, idempotencyKey: key,
          operations: [{ op: "append_body", text: "\nGuarded append smoke.\n" }],
        } });
      };
      const planned = jsonOf(await withTimeout(textPatch("smoke-append"), "guarded append plan"), "guarded append plan");
      const applied = jsonOf(await withTimeout(client.callTool({ name: "obsidian_text_patch_apply", arguments: {
        planRef: planned.planRef, idempotencyKey: "smoke-append",
      } }), "guarded append apply"), "guarded append apply");
      assert.equal(applied.outcome, "committed");
      assert.match(await readFile(path.join(vaultRoot, "Projects", "Headless.md"), "utf8"), /Guarded append smoke/u);

      if (modeArg === "headless-filesystem") {
        const createFixture = async (relative, content) => {
          const created = jsonOf(await client.callTool({ name: "obsidian_note_create_plan", arguments: {
            path: relative, content, idempotencyKey: relative,
          } }), "create helper");
          const result = jsonOf(await client.callTool({ name: "obsidian_note_create_apply", arguments: {
            planRef: created.planRef, idempotencyKey: relative,
          } }), "create helper apply");
          assert.equal(result.outcome, "committed");
          return createHash("sha1").update(await readFile(path.join(vaultRoot, relative))).digest("hex");
        };
        const moveHash = await createFixture("Projects/MoveMe.md", "Move me.\n");
        const moveResult = await withTimeout(
          client.callTool({
            name: "obsidian_move_note",
            arguments: {
              sourcePath: "Projects/MoveMe.md",
              targetPath: "Projects/Moved.md",
              expectedHash: moveHash,
            },
          }),
          "filesystem move",
        );
        assertTextIncludes(moveResult, "Projects/Moved.md", "filesystem move");

        const adminDryRun = await withTimeout(
          client.callTool({
            name: "obsidian_admin_filesystem",
            arguments: {
              operation: "archive",
              dryRun: true,
              archiveDir: "Archive",
              items: [{ sourcePath: "Projects/Moved.md" }],
            },
          }),
          "filesystem admin archive dry run",
        );
        assertTextIncludes(
          adminDryRun,
          "Archive/Moved.md",
          "filesystem admin archive dry run",
        );

        const canvasCreateDryRun = await withTimeout(
          client.callTool({
            name: "obsidian_manage_canvas",
            arguments: {
              operation: "create",
              filePath: "Canvases/Generated.canvas",
              dryRun: true,
              nodes: [
                {
                  id: "1111111111111111",
                  type: "text",
                  x: 0,
                  y: 0,
                  width: 300,
                  height: 160,
                  text: "Draft",
                },
              ],
            },
          }),
          "filesystem canvas create dry run",
        );
        assertTextIncludes(
          canvasCreateDryRun,
          '"dryRun": true',
          "filesystem canvas create dry run",
        );

        const canvasCreate = await withTimeout(
          client.callTool({
            name: "obsidian_manage_canvas",
            arguments: {
              operation: "create",
              filePath: "Canvases/Generated.canvas",
              dryRun: false,
              nodes: [
                {
                  id: "1111111111111111",
                  type: "text",
                  x: 0,
                  y: 0,
                  width: 300,
                  height: 160,
                  text: "Start",
                },
                {
                  id: "2222222222222222",
                  type: "text",
                  x: 420,
                  y: 0,
                  width: 300,
                  height: 160,
                  text: "Next",
                },
              ],
            },
          }),
          "filesystem canvas create",
        );
        assertTextIncludes(
          canvasCreate,
          "Canvases/Generated.canvas",
          "filesystem canvas create",
        );

        const canvasConnect = await withTimeout(
          client.callTool({
            name: "obsidian_manage_canvas",
            arguments: {
              operation: "connect_nodes",
              filePath: "Canvases/Generated.canvas",
              dryRun: false,
              fromNode: "1111111111111111",
              toNode: "2222222222222222",
              label: "next",
            },
          }),
          "filesystem canvas connect",
        );
        assertTextIncludes(
          canvasConnect,
          "filesystem-guarded",
          "filesystem canvas connect",
        );

        const canvasToolValidation = await withTimeout(
          client.callTool({
            name: "obsidian_manage_canvas",
            arguments: {
              operation: "validate",
              filePath: "Canvases/Generated.canvas",
            },
          }),
          "filesystem canvas validate",
        );
        assertTextIncludes(
          canvasToolValidation,
          '"ok": true',
          "filesystem canvas validate",
        );

        const canvasIds = ["concurrent-a", "concurrent-b"];
        const canvasEditPath = "Canvases/Generated.canvas";
        const canvasEdits = await withTimeout(
          Promise.all(canvasIds.map((nodeId) => client.callTool({
            name: "obsidian_manage_canvas",
            arguments: {
              operation: "add_text_node",
              filePath: canvasEditPath,
              dryRun: false,
              nodeId,
              text: nodeId,
            },
          }))),
          "concurrent filesystem canvas edits",
        );
        const canvasEditState = JSON.parse(
          await readFile(path.join(vaultRoot, canvasEditPath), "utf8"),
        );
        const savedEditIds = canvasEditState.nodes.map(({ id }) => id)
          .filter((id) => canvasIds.includes(id)).sort();
        const appliedEditIds = canvasIds.filter((_, index) => !canvasEdits[index].isError);
        const refusedEdits = canvasEdits.filter((result) => result.isError);

        const canvasCreatePath = "Canvases/Concurrent.canvas";
        const canvasCreates = await withTimeout(
          Promise.all(canvasIds.map((id) => client.callTool({
            name: "obsidian_manage_canvas",
            arguments: {
              operation: "create",
              filePath: canvasCreatePath,
              dryRun: false,
              overwrite: false,
              nodes: [{ id, type: "text", x: 0, y: 0, width: 200, height: 100, text: id }],
            },
          }))),
          "concurrent filesystem canvas creates",
        );
        const appliedCreateIds = canvasIds.filter((_, index) => !canvasCreates[index].isError);
        const refusedCreates = canvasCreates.filter((result) => result.isError);
        const canvasCreateState = JSON.parse(
          await readFile(path.join(vaultRoot, canvasCreatePath), "utf8"),
        );

        const baseCreate = await withTimeout(
          client.callTool({
            name: "bases_create",
            arguments: {
              path: "GuardedSmoke.base",
              spec: {
                properties: {
                  "file.name": { displayName: "Name" },
                  headless_guarded_smoke: { displayName: "Smoke" },
                },
                views: [{ type: "table", name: "Smoke" }],
              },
            },
          }),
          "guarded bases create",
        );
        assertTextIncludes(
          baseCreate,
          "filesystem-guarded",
          "guarded bases create",
        );

        const basePath = path.join(vaultRoot, "GuardedSmoke.base");
        const originalBase = await readFile(basePath, "utf8");
        const duplicateBase = await withTimeout(
          client.callTool({
            name: "bases_create",
            arguments: {
              path: "GuardedSmoke.base",
              overwrite: false,
              spec: { views: [{ type: "table", name: "Replacement" }] },
            },
          }),
          "guarded bases create without overwrite",
        );
        assert.deepEqual(
          {
            successfulCanvasEditCountIsPositive: appliedEditIds.length > 0,
            savedCanvasEdits: savedEditIds,
            canvasEditConflictCodes: refusedEdits.map(
              (result) => jsonOf(result, "canvas edit conflict").error?.code,
            ),
            onlyOneCanvasCreateSucceeded: appliedCreateIds.length === 1,
            canvasCreateConflictCodes: refusedCreates.map(
              (result) => jsonOf(result, "canvas create conflict").error?.code,
            ),
            savedCanvasCreate: canvasCreateState.nodes.map(({ id }) => id),
            duplicateBaseConflictCode: duplicateBase.isError
              ? jsonOf(duplicateBase, "base create conflict").error?.code
              : undefined,
            duplicateCreatePreservedBase: (await readFile(basePath, "utf8")) === originalBase,
          },
          {
            successfulCanvasEditCountIsPositive: true,
            savedCanvasEdits: appliedEditIds,
            canvasEditConflictCodes: refusedEdits.map(() => "CONFLICT"),
            onlyOneCanvasCreateSucceeded: true,
            canvasCreateConflictCodes: ["CONFLICT"],
            savedCanvasCreate: appliedCreateIds,
            duplicateBaseConflictCode: "CONFLICT",
            duplicateCreatePreservedBase: true,
          },
          "headless Canvas and Base handlers must preserve successful writes and reject conflicting creates",
        );

        const baseConfig = await withTimeout(
          client.callTool({
            name: "bases_upsert_config",
            arguments: {
              base_id: "GuardedSmoke.base",
              json: {
                properties: {
                  "file.name": { displayName: "Name" },
                  headless_guarded_smoke: { displayName: "Smoke Updated" },
                },
                views: [{ type: "table", name: "Smoke Updated" }],
              },
            },
          }),
          "guarded bases config",
        );
        assertTextIncludes(
          baseConfig,
          "filesystem-guarded",
          "guarded bases config",
        );

        const deleteHash = await createFixture("Projects/DeleteMe.md", "Delete me.\n");
        const deleteResult = await withTimeout(
          client.callTool({
            name: "obsidian_delete_note",
            arguments: {
              filePath: "Projects/DeleteMe.md",
              expectedHash: deleteHash,
            },
          }),
          "guarded delete",
        );
        assertTextIncludes(deleteResult, "deletedHash", "guarded delete");
      }

      const stale = jsonOf(await textPatch("stale-smoke"), "stale plan");
      const target = path.join(vaultRoot, "Projects", "Headless.md");
      const concurrent = (await readFile(target, "utf8")) + "\nExternal edit.\n";
      await writeFile(target, concurrent);
      const conflict = jsonOf(await client.callTool({ name: "obsidian_text_patch_apply", arguments: {
        planRef: stale.planRef, idempotencyKey: "stale-smoke",
      } }), "stale apply");
      assert.equal(conflict.outcome, "conflict");
      assert.equal(await readFile(target, "utf8"), concurrent);
      const traversal = await textPatch("traversal-smoke", "../escape.md");
      assert.equal(Boolean(traversal.isError), true, "Path traversal must be rejected");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: modeArg,
          runtimeMode,
          vaultRoot,
          cachePath,
          toolCount: toolNames.length,
          tools: toolNames,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close().catch(() => undefined);
    if (fakeRestServer) {
      await new Promise((resolve) => fakeRestServer.close(resolve)).catch(
        () => undefined,
      );
    }
    await rm(vaultRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
