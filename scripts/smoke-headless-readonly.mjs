#!/usr/bin/env node

import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "12000");
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
    throw new Error(`${label} did not include ${JSON.stringify(needle)}: ${text}`);
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
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "optimike-headless-vault-"));
  await mkdir(path.join(vaultRoot, "Projects"), { recursive: true });
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
      "- [ ] Verify task extraction #headless",
      "- [x] Keep live mode as rollback",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, "Root.md"),
    ["---", "type: root", "---", "", "Root smoke note with searchable keyword alphasmoke.", ""].join("\n"),
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
      "views:",
      "  - type: list",
      "    name: All",
      "    order:",
      "      - file.name",
      "      - type",
      "    sort:",
      "      - property: file.name",
      "        direction: ASC",
      "",
    ].join("\n"),
    "utf8",
  );
  return vaultRoot;
}

async function main() {
  const vaultRoot = await createTempVault();
  const cachePath = path.join(vaultRoot, ".obsidian", "optimike-mcp", "shared-cache.sqlite");
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
        const relativePath = decodeURIComponent(request.url.replace(/^\/vault\//u, ""));
        const absolutePath = path.join(vaultRoot, relativePath);
        try {
          const fileStat = await stat(absolutePath);
          response.setHeader("x-obsidian-mtime", String(fileStat.mtimeMs / 1000));
          response.setHeader("x-obsidian-ctime", String(fileStat.ctimeMs / 1000));
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
      if (request.method === "POST" && request.url?.startsWith("/search/simple/")) {
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
    await new Promise((resolve) => fakeRestServer.listen(0, "127.0.0.1", resolve));
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
    const expected = [
      "obsidian_list_notes",
      "obsidian_read_note",
      "obsidian_global_search",
      "list_all_tasks",
      "query_tasks",
      "obsidian_runtime_status",
      "obsidian_runtime_maintenance",
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
            "bases_create",
            "bases_upsert_config",
            "bases_upsert_rows",
          ].includes(name))
      ) {
        if (!toolNames.includes(name)) {
          throw new Error(`Expected write tool in ${modeArg}: ${name}`);
        }
      } else if (toolNames.includes(name)) {
        throw new Error(`Live/write tool should not be registered in ${modeArg}: ${name}`);
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
    if (assertTextIncludes(excludedSearch, "totalFiles", "excluded global search").includes("Excluded.md")) {
      throw new Error("Vault exclusion policy failed: tmp/Excluded.md was indexed");
    }

    const tasks = await withTimeout(
      client.callTool({
        name: "list_all_tasks",
        arguments: { path: "/", responseFormat: "json", responseMode: "compact" },
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
      assertTextIncludes(replace, "Guarded replace smoke", "guarded search replace");

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
      assertTextIncludes(frontmatter, "headless_guarded_smoke", "guarded frontmatter");

      if (modeArg === "headless-filesystem") {
        const tagsAdd = await withTimeout(
        client.callTool({
          name: "obsidian_manage_tags",
          arguments: {
            filePath: "Projects/Headless.md",
            operation: "add",
            tags: ["headless/filesystem"],
          },
        }),
        "guarded tags add",
      );
      assertTextIncludes(tagsAdd, "headless/filesystem", "guarded tags add");

      const tagsRemove = await withTimeout(
        client.callTool({
          name: "obsidian_manage_tags",
          arguments: {
            filePath: "Projects/Headless.md",
            operation: "remove",
            tags: ["headless/filesystem"],
          },
        }),
        "guarded tags remove",
      );
      assertTextIncludes(tagsRemove, "currentTags", "guarded tags remove");

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
      assertTextIncludes(baseCreate, "filesystem-guarded", "guarded bases create");

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
      assertTextIncludes(baseConfig, "filesystem-guarded", "guarded bases config");

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
      assertTextIncludes(rowUpsert, "filesystem-guarded", "guarded bases rows");

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
    await rm(vaultRoot, { recursive: true, force: true }).catch(() => undefined);
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
