#!/usr/bin/env node

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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
      MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
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
      "obsidian_batch_frontmatter",
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
    const semanticSearchAliases = new Set([
      "smart-search",
      "smart_search",
      "smart_semantic_search",
    ]);
    const closedWorldSemanticSearchTools = tools.tools.filter(
      (tool) =>
        semanticSearchAliases.has(tool.name) &&
        tool.annotations?.openWorldHint !== true,
    );
    if (closedWorldSemanticSearchTools.length > 0) {
      throw new Error(
        `Semantic search tools not marked open-world: ${closedWorldSemanticSearchTools
          .map((tool) => tool.name)
          .join(", ")}`,
      );
    }
    for (const alias of ["smart_search", "smart-search"]) {
      const description = toolsByName.get(alias)?.description ?? "";
      if (
        !description.includes("Legacy compatibility alias") ||
        !description.includes("Prefer smart_semantic_search")
      ) {
        throw new Error(
          `${alias} must identify itself as a legacy alias and route new calls to smart_semantic_search.`,
        );
      }
    }

    const routingDescriptionContracts = [
      ["obsidian_update_note", "obsidian_note_replace_plan"],
      ["obsidian_search_replace", "obsidian_note_replace_plan"],
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
        (modeArg === "headless-guarded" &&
          [
            "obsidian_update_note",
            "obsidian_search_replace",
            "obsidian_manage_frontmatter",
          ].includes(name)) ||
        (modeArg === "headless-filesystem" &&
          [
            "obsidian_update_note",
            "obsidian_delete_note",
            "obsidian_search_replace",
            "obsidian_manage_frontmatter",
            "obsidian_manage_tags",
            "obsidian_move_note",
            "obsidian_batch_frontmatter",
            "obsidian_admin_filesystem",
            "obsidian_manage_canvas",
            "bases_create",
            "bases_upsert_config",
            "bases_upsert_rows",
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
      "obsidian_batch_frontmatter",
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
      const update = await withTimeout(
        client.callTool({
          name: "obsidian_update_note",
          arguments: {
            targetType: "filePath",
            targetIdentifier: "Projects/Headless.md",
            modificationType: "wholeFile",
            wholeFileMode: "append",
            content: "\nGuarded append smoke.",
            returnContent: true,
          },
        }),
        "guarded update",
      );
      assertTextIncludes(update, "Guarded append smoke", "guarded update");

      const replace = await withTimeout(
        client.callTool({
          name: "obsidian_search_replace",
          arguments: {
            targetType: "filePath",
            targetIdentifier: "Projects/Headless.md",
            replacements: [
              {
                search: "Guarded append smoke",
                replace: "Guarded replace smoke",
              },
            ],
            returnContent: true,
          },
        }),
        "guarded search replace",
      );
      assertTextIncludes(
        replace,
        "Guarded replace smoke",
        "guarded search replace",
      );

      const frontmatter = await withTimeout(
        client.callTool({
          name: "obsidian_manage_frontmatter",
          arguments: {
            filePath: "Projects/Headless.md",
            operation: "set",
            key: "headless_guarded_smoke",
            value: true,
          },
        }),
        "guarded frontmatter",
      );
      assertTextIncludes(
        frontmatter,
        "headless_guarded_smoke",
        "guarded frontmatter",
      );

      if (modeArg === "headless-filesystem") {
        const tagsAdd = await withTimeout(
          client.callTool({
            name: "obsidian_manage_tags",
            arguments: {
              filePath: "Projects/Headless.md",
              operation: "add",
              location: "inline",
              tags: ["headless/filesystem"],
            },
          }),
          "filesystem inline tags add",
        );
        assertTextIncludes(
          tagsAdd,
          "headless/filesystem",
          "filesystem inline tags add",
        );

        const tagIndex = await withTimeout(
          client.callTool({
            name: "obsidian_manage_tags",
            arguments: {
              operation: "index",
            },
          }),
          "filesystem tag index",
        );
        assertTextIncludes(
          tagIndex,
          "headless/filesystem",
          "filesystem tag index",
        );

        const tagsRemove = await withTimeout(
          client.callTool({
            name: "obsidian_manage_tags",
            arguments: {
              filePath: "Projects/Headless.md",
              operation: "remove",
              location: "inline",
              tags: ["headless/filesystem"],
            },
          }),
          "filesystem inline tags remove",
        );
        assertTextIncludes(
          tagsRemove,
          "currentTags",
          "filesystem inline tags remove",
        );

        const tagAudit = await withTimeout(
          client.callTool({
            name: "obsidian_manage_tags",
            arguments: { operation: "audit" },
          }),
          "filesystem tag audit",
        );
        assertTextIncludes(tagAudit, "frontmatterTags", "filesystem tag audit");

        const tagRenameDryRun = await withTimeout(
          client.callTool({
            name: "obsidian_manage_tags",
            arguments: {
              operation: "rename",
              fromTag: "headless",
              toTag: "headless/renamed",
              dryRun: true,
            },
          }),
          "filesystem tag rename dry run",
        );
        assertTextIncludes(
          tagRenameDryRun,
          "headless/renamed",
          "filesystem tag rename dry run",
        );

        const batchDryRun = await withTimeout(
          client.callTool({
            name: "obsidian_batch_frontmatter",
            arguments: {
              dryRun: true,
              operations: [
                {
                  filePath: "Projects/Headless.md",
                  set: { headless_batch_smoke: "dry-run" },
                },
              ],
            },
          }),
          "filesystem batch frontmatter dry run",
        );
        assertTextIncludes(
          batchDryRun,
          '"dryRun": true',
          "filesystem batch frontmatter dry run",
        );

        const batchSet = await withTimeout(
          client.callTool({
            name: "obsidian_batch_frontmatter",
            arguments: {
              dryRun: false,
              operations: [
                {
                  filePath: "Projects/Headless.md",
                  set: { headless_batch_smoke: "ok" },
                },
              ],
            },
          }),
          "filesystem batch frontmatter set",
        );
        assertTextIncludes(
          batchSet,
          "headless_batch_smoke",
          "filesystem batch frontmatter set",
        );

        const moveTarget = jsonOf(
          await withTimeout(
            client.callTool({
              name: "obsidian_update_note",
              arguments: {
                targetType: "filePath",
                targetIdentifier: "Projects/MoveMe.md",
                modificationType: "wholeFile",
                wholeFileMode: "append",
                content: "move me",
                returnContent: true,
              },
            }),
            "filesystem move target create",
          ),
          "filesystem move target create",
        );

        const moveResult = await withTimeout(
          client.callTool({
            name: "obsidian_move_note",
            arguments: {
              sourcePath: "Projects/MoveMe.md",
              targetPath: "Projects/Moved.md",
              expectedHash: moveTarget.stats.hash,
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

        const rowUpsert = await withTimeout(
          client.callTool({
            name: "bases_upsert_rows",
            arguments: {
              base_id: "GuardedSmoke.base",
              operations: [
                {
                  file: "Projects/Headless.md",
                  set: { headless_guarded_smoke_row: "ok" },
                },
              ],
            },
          }),
          "guarded bases rows",
        );
        assertTextIncludes(
          rowUpsert,
          "filesystem-guarded",
          "guarded bases rows",
        );

        const deleteTarget = jsonOf(
          await withTimeout(
            client.callTool({
              name: "obsidian_update_note",
              arguments: {
                targetType: "filePath",
                targetIdentifier: "Projects/DeleteMe.md",
                modificationType: "wholeFile",
                wholeFileMode: "append",
                content: "delete me",
                returnContent: true,
              },
            }),
            "guarded delete target create",
          ),
          "guarded delete target create",
        );

        const deleteResult = await withTimeout(
          client.callTool({
            name: "obsidian_delete_note",
            arguments: {
              filePath: "Projects/DeleteMe.md",
              expectedHash: deleteTarget.stats.hash,
            },
          }),
          "guarded delete",
        );
        assertTextIncludes(deleteResult, "deletedHash", "guarded delete");
      }

      const staleHash = await client.callTool({
        name: "obsidian_update_note",
        arguments: {
          targetType: "filePath",
          targetIdentifier: "Projects/Headless.md",
          modificationType: "wholeFile",
          wholeFileMode: "append",
          content: "bad stale write",
          expectedHash: "not-the-current-hash",
        },
      });
      if (!staleHash.isError) {
        throw new Error("Expected stale expectedHash write to be rejected");
      }

      const traversal = await client.callTool({
        name: "obsidian_update_note",
        arguments: {
          targetType: "filePath",
          targetIdentifier: "../escape.md",
          modificationType: "wholeFile",
          wholeFileMode: "append",
          content: "bad",
        },
      });
      if (!traversal.isError) {
        throw new Error("Expected path traversal write to be rejected");
      }
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
