import { isolatedStateEnv, isolatedStateDirectory } from "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.join(isolatedStateDirectory, "vault");
const at = name => path.join(root, name);
const put = (name, content) => writeFile(at(name), content);
const read = name => readFile(at(name), "utf8");
const missing = name => assert.rejects(stat(at(name)), { code: "ENOENT" });
const settings = options => put(".obsidian/app.json", JSON.stringify(options));
await Promise.all([".obsidian", "New", "Reader", "Twin", "Trash/Reader"].map(dir => mkdir(at(dir), { recursive: true })));
let client;
const start = async (entry, crash = false, overrides = {}) => {
  await client?.close();
  client = new Client({ name: "headless-note-operation-test", version: "1" });
  const crashAfterPublication = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const link = fs.linkSync;
    fs.linkSync = (source, destination) => {
      link(source, destination);
      if (destination.endsWith('Crash moved.md')) process.exit(73);
    };
    syncBuiltinESMExports();
  `;
  const args = crash ? ["--import", "data:text/javascript," + encodeURIComponent(crashAfterPublication), entry] : [entry];
  await client.connect(new StdioClientTransport({
    command: process.execPath, args, env: {
      ...process.env, ...isolatedStateEnv(), OBSIDIAN_VAULT: root, OBSIDIAN_ENABLE_CACHE: "true",
      OBSIDIAN_CACHE_SOURCE: "filesystem", OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(isolatedStateDirectory, "cache.sqlite"),
      MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(isolatedStateDirectory, "operations.sqlite"),
      MCP_TRANSPORT_TYPE: "stdio", MCP_TOOL_PROFILE: "operational", MCP_WRITE_MODE: "full",
      MCP_VAULT_INSTRUCTIONS: "off", MCP_VAULT_INSTRUCTIONS_MIN: "off",
      SEMANTIC_SEARCH_PREWARM: "false", OBSIDIAN_API_KEY: "", MCP_LOG_LEVEL: "error", ...overrides,
    },
  }));
};

const rawCall = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return { result, body: JSON.parse(result.content[0].text) };
};
const call = async (name, args) => {
  const { result, body } = await rawCall(name, args);
  assert.equal(Boolean(result.isError), false, JSON.stringify(body));
  return body;
};
const movePlan = (sourcePath, destinationPath, idempotencyKey) =>
  call("obsidian_note_move_plan", { sourcePath, destinationPath, idempotencyKey });
const lifecycle = (kind, role, plan, idempotencyKey) => call(`obsidian_note_${kind}_${role}`, {
  planRef: plan.planRef, ...(idempotencyKey ? { idempotencyKey } : {}),
});
const linkQuery = filePath => call("obsidian_note_links", { filePath });

try {
  if (process.argv[2] === "--legacy") {
    await put("Old.md", "old content");
    await put("Reader/Links.md", "[[Old]]");
    await start(process.argv[3] ?? "dist/index.js", false, { MCP_TOOL_PROFILE: "full" });
    const { createHash } = await import("node:crypto");
    await call("obsidian_move_note", { sourcePath: "Old.md", targetPath: "New/Renamed.md",
      expectedHash: createHash("sha1").update("old content").digest("hex") });
    assert.equal(await read("Reader/Links.md"), "[[Old]]");
    assert.equal((await linkQuery("Reader/Links.md")).outgoing[0].resolution.status, "unresolved");
    await put("Reader/Links.md", "[[Renamed]]");
    await call("obsidian_delete_note", { filePath: "New/Renamed.md",
      expectedHash: createHash("sha1").update("old content").digest("hex") });
    await missing("New/Renamed.md");
    await missing(".trash");
    console.log("Observed legacy behavior: move leaves a broken link, deletion unlinks a referenced file without trash.");
  } else {
    await settings({ alwaysUpdateLinks: true, newLinkFormat: "shortest", trashOption: "local" });
    await put("Old.md", "original\n");
    await put("Twin/Target.md", "other note");
    const prefix = "\uFEFF---\r\ncréation: 2026-11-28\r\nmodification: 2026-11-28\r\nrelated: \"[[Old#Heading]]\"\r\n---\r\n";
    const opaque = "`[[Old]]` %% [[Old]] %% $[[Old]]$ <span>[[Old]]</span>\r\n```md\r\n[[Old]]\r\n```\r\n";
    const body = "[[Old|alias]] ![[Old#^block]] [label](../Old.md#Heading \"title\") [[Twin/Target]] [[Missing]]\r\n[ref][1]\r\n\r\n[1]: ../Old.md\r\n";
    await put("Reader/Links.md", prefix + body + opaque);
    await start("dist/index.js");
    const catalog = new Set((await client.listTools()).tools.map(tool => tool.name));
    for (const kind of ["move", "delete"]) {
      for (const role of ["plan", "apply", "status", "recover"]) assert(catalog.has(`obsidian_note_${kind}_${role}`));
    }
    assert(!catalog.has("obsidian_move_note") && !catalog.has("obsidian_delete_note"));

    const planned = await movePlan("Old.md", "New/Target.md", "first");
    assert.equal(planned.preview.noteCount, 1);
    assert.equal(planned.preview.rewriteCount, 5);
    assert.equal(await read("Reader/Links.md"), prefix + body + opaque);
    const moved = await lifecycle("move", "apply", planned, "first");
    assert.equal(moved.outcome, "committed");
    assert.equal(moved.cache, "refreshed");
    assert.equal((await lifecycle("move", "apply", planned, "first")).outcome, "committed");
    const expected = (prefix + body).replaceAll("[[Old", "[[New/Target").replaceAll("../Old.md", "New/Target.md");
    assert.equal(await read("Reader/Links.md"), expected + opaque);
    assert.equal(await read("New/Target.md"), "original\n");
    assert.equal((await linkQuery("New/Target.md")).backlinks[0].count, 5);
    await missing("Old.md");

    await settings({ newLinkFormat: "relative" });
    await put("Reader/A.png", Buffer.from([0, 255, 32]));
    await put("Reader/Image.md", "![[A.png]] ![photo](./A.png)");
    const asset = await movePlan("Reader/A.png", "Reader/B.png", "asset");
    assert.equal((await lifecycle("move", "apply", asset, "asset")).outcome, "committed");
    assert.equal(await read("Reader/Image.md"), "![[./B.png]] ![photo](./B.png)");
    assert.deepEqual(await readFile(at("Reader/B.png")), Buffer.from([0, 255, 32]));
    assert.equal((await linkQuery("Reader/Image.md")).outgoing[0].resolution.targetPath, "Reader/B.png");

    await settings({ newLinkFormat: "absolute", useMarkdownLinks: true });
    await put("Reader/Ref.md", "\uFEFF[[New/Target#Heading|Alias]]");
    const rename = await movePlan("New/Target.md", "New/Ref name.md", "rename");
    assert.equal((await lifecycle("move", "apply", rename, "rename")).outcome, "committed");
    assert.equal(await read("Reader/Ref.md"), "\uFEFF[Alias](/New/Ref%20name.md#Heading)");

    await settings({ alwaysUpdateLinks: false });
    const disabled = await movePlan("New/Ref name.md", "New/No update.md", "disabled");
    assert.equal(disabled.preview.noteCount, 0);
    assert.equal((await lifecycle("move", "apply", disabled, "disabled")).outcome, "committed");
    assert.equal(await read("Reader/Ref.md"), "\uFEFF[Alias](/New/Ref%20name.md#Heading)");

    await settings({ newLinkFormat: "shortest" });
    await put("Reader/Edit.md", "[[New/No update]]");
    const stale = await movePlan("New/No update.md", "New/Stale.md", "stale");
    await put("Reader/Edit.md", "[[New/No update]] edited");
    assert.equal((await lifecycle("move", "apply", stale, "stale")).outcome, "conflict");
    assert.equal(await read("Reader/Edit.md"), "[[New/No update]] edited");
    await missing("New/Stale.md");

    await put("Crash.md", "crash fixture");
    await put("Reader/Crash link.md", "[[Crash]]");
    const crash = await movePlan("Crash.md", "Crash moved.md", "crash");
    await start("dist/index.js", true);
    await assert.rejects(lifecycle("move", "apply", crash, "crash"), /closed|disconnect/i);
    assert.equal(await read("Crash.md"), await read("Crash moved.md"));
    await start("dist/index.js");
    assert.equal((await lifecycle("move", "status", crash)).outcome, "outcome_unknown");
    assert.equal((await lifecycle("move", "recover", crash, "crash")).outcome, "committed");
    assert.equal(await read("Reader/Crash link.md"), "[[Crash moved]]");
    await missing("Crash.md");

    await settings({ trashFolder: "Trash" });
    await put("Trash/Reader/Crash link.md", "existing trash");
    await put("Reader/Trash backlink.md", "[[Reader/Crash link]]");
    const deletePlan = (key, acknowledged) => call("obsidian_note_delete_plan", {
      path: "Reader/Crash link.md", idempotencyKey: key, acknowledgeBacklinks: acknowledged,
    });
    const rejected = await deletePlan("reject", false);
    assert.equal(rejected.incomingLinks.count, 1);
    assert.equal(rejected.applyAllowed, false);
    const deletion = await deletePlan("delete", true);
    assert.equal(deletion.trash.path, "Trash/Reader/Crash link.1.md");
    const trashed = await lifecycle("delete", "apply", deletion, "delete");
    assert.equal(trashed.outcome, "committed");
    assert.equal((await lifecycle("delete", "status", deletion)).postflight.status, "verified");
    assert.equal(await read("Trash/Reader/Crash link.md"), "existing trash");
    assert.equal(await read(deletion.trash.path), "[[Crash moved]]");
    assert.equal((await linkQuery("Reader/Trash backlink.md")).outgoing[0].resolution.status, "unresolved");

    await settings({});
    await put("Unlinked.md", "unlinked");
    const unlinked = await call("obsidian_note_delete_plan", { path: "Unlinked.md", idempotencyKey: "unlinked" });
    assert.equal(unlinked.incomingLinks.count, 0);
    await put("Reader/Late backlink.md", "[[Unlinked]]");
    assert.equal((await lifecycle("delete", "apply", unlinked, "unlinked")).outcome, "conflict");
    assert.equal(await read("Unlinked.md"), "unlinked");
    await missing(".trash/Unlinked.md");
    const acknowledged = await call("obsidian_note_delete_plan", {
      path: "Unlinked.md", idempotencyKey: "local-trash", acknowledgeBacklinks: true,
    });
    assert.equal((await lifecycle("delete", "apply", acknowledged, "local-trash")).outcome, "committed");
    assert.equal(await read(".trash/Unlinked.md"), "unlinked");
    await put("No backlinks.md", "no backlinks");
    const noBacklinks = await call("obsidian_note_delete_plan", { path: "No backlinks.md", idempotencyKey: "no-backlinks" });
    assert.equal((await lifecycle("delete", "apply", noBacklinks, "no-backlinks")).outcome, "committed");
    assert.equal(await read(".trash/No backlinks.md"), "no backlinks");

    await start("dist/index.js", false, { MCP_WRITE_MODE: "guarded" });
    const { result, body: refused } = await rawCall("obsidian_note_move_plan", {
      sourcePath: "Reader/Edit.md", destinationPath: "Reader/Forbidden.md", idempotencyKey: "guarded",
    });
    assert.equal(result.isError, true);
    assert.equal(refused.error.code, "FORBIDDEN");
    await missing("Reader/Forbidden.md");
    console.log("PASS headless move/relink, hash conflict, crash recovery, trash, link index and profiles");
  }
} finally {
  await client?.close();
}
