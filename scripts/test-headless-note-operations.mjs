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
const start = async (entry, fault = false, overrides = {}) => {
  await client?.close();
  client = new Client({ name: "headless-note-operation-test", version: "1" });
  const injected = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const fault = ${JSON.stringify(fault)};
    const link = fs.linkSync;
    fs.linkSync = (source, destination) => {
      if (fault === 'before-effect' && destination.endsWith('Pre-effect moved.md')) process.exit(75);
      if (fault === 'probe' && destination.includes('.optimike-probe-') ||
          fault === 'link' && destination.endsWith('Unavailable moved.md')) {
        throw Object.assign(new Error('fixture hard link unavailable'), { code: 'EXDEV' });
      }
      link(source, destination);
      if (fault === true && destination.endsWith('Crash moved.md')) process.exit(73);
    };
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (source.includes('.optimike-') && destination.endsWith('Second partial.md') && fault === 'rewrite') process.exit(74);
      rename(source, destination);
      if (source.includes('.optimike-') && destination.endsWith('First sync.md') && fault === 'sync') {
        fs.writeFileSync(destination.replace('First sync.md', 'Second sync.md'), 'new external contents');
      }
    };
    syncBuiltinESMExports();
  `;
  const args = fault ? ["--import", "data:text/javascript," + encodeURIComponent(injected), entry] : [entry];
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
  const timeout = process.argv[2]?.startsWith("--benchmark") ? { timeout: 240_000 } : undefined;
  const result = await client.callTool({ name, arguments: args }, timeout);
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
  } else if (["--benchmark", "--benchmark-supported"].includes(process.argv[2])) {
    const backlinks = process.argv[2] === "--benchmark-supported" ? 80 : 2000;
    await put("Bench source.md", "benchmark seed");
    for (let i = 0; i < 3000; i += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, j) => {
        const n = i + j;
        return put(`Reader/Bench ${n}.md`, n < backlinks ? "[[Bench source]]" : "No backlinks.");
      }));
    }
    await start(process.argv[3] ?? "dist/index.js");
    const started = performance.now();
    const plan = await rawCall("obsidian_note_move_plan", {
      sourcePath: "Bench source.md", destinationPath: "New/Bench moved.md", idempotencyKey: "bench",
    });
    const planned = performance.now();
    console.log(JSON.stringify({ phase: "plan", backlinks, planMs: Math.round(planned - started) }));
    if (plan.result.isError) {
      assert.equal(plan.body.error.details.reasonCode, "headless_backlink_limit");
      console.log(JSON.stringify({ planMs: Math.round(planned - started), outcome: "headless_backlink_limit" }));
    } else {
      const applied = await lifecycle("move", "apply", plan.body, "bench");
      assert.equal(applied.outcome, "committed");
      console.log(JSON.stringify({ planMs: Math.round(planned - started), applyMs: Math.round(performance.now() - planned), outcome: applied.outcome }));
    }
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
    assert.equal(await read("Reader/Ref.md"), "\uFEFF[[/New/Ref name#Heading|Alias]]");

    await settings({ alwaysUpdateLinks: false });
    const disabled = await movePlan("New/Ref name.md", "New/No update.md", "disabled");
    assert.equal(disabled.preview.noteCount, 0);
    assert.equal((await lifecycle("move", "apply", disabled, "disabled")).outcome, "committed");
    assert.equal(await read("Reader/Ref.md"), "\uFEFF[[/New/Ref name#Heading|Alias]]");

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
    await put(deletion.trash.path, "externally changed trash contents");
    assert.equal((await lifecycle("delete", "status", deletion)).postflight.status, "indeterminate");
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

    // Preserve escaped table separators, block scalars, self links, and the
    // original syntax even when Obsidian is configured to generate Markdown.
    await settings({ newLinkFormat: "shortest", useMarkdownLinks: true });
    await put("Reader/Sib.md", "sibling");
    await put("Reader/Mover.md", "[label](./Sib.md) [[./Sib]] [[Mover#^b1]] [[#^b1]]");
    await put("Reader/Mover references.md",
      "---\nrelated: |\n  text [[Mover#^b1]]\n---\n\n| A | B |\n| --- | --- |\n| [[Mover\\|alias]] | y |\n");
    const relatives = await movePlan("Reader/Mover.md", "New/Moved.md", "relative-links");
    const relocated = await lifecycle("move", "apply", relatives, "relative-links");
    assert.equal(relocated.graph_postflight, "verified");
    assert.equal(await read("New/Moved.md"), "[label](../Reader/Sib.md) [[../Reader/Sib]] [[Moved#^b1]] [[#^b1]]");
    assert.match(await read("Reader/Mover references.md"), /text \[\[Moved#\^b1\]\]/);
    assert((await read("Reader/Mover references.md")).includes("| [[Moved\\|alias]] | y |"));
    await put("Reader/Moved.md", "new candidate introduced outside the journal");
    assert.equal((await lifecycle("move", "status", relatives)).graph_postflight, "indeterminate");

    await mkdir(at("A"));
    await mkdir(at("C"));
    await mkdir(at("D"));
    await put("C/Target.md", "other target");
    await put("D/Third party link.md", "[[Target]]");
    await put("Doomed.md", "incoming move");
    const retargeted = await rawCall("obsidian_note_move_plan", {
      sourcePath: "Doomed.md", destinationPath: "A/Target.md", idempotencyKey: "third-party-target",
    });
    assert.equal(retargeted.body.error.details.reasonCode, "headless_link_target_changed");
    await missing("A/Target.md");

    for (const option of ["system", "none"]) {
      await settings({ trashOption: option });
      const preference = await rawCall("obsidian_note_delete_plan", { path: "Doomed.md", idempotencyKey: option });
      assert.equal(preference.body.error.details.reasonCode, "headless_trash_preference_unsupported");
    }
    await settings({});

    // Fault at the probe and during dispatch after a successful plan.
    await put("Unavailable.md", "link fixture");
    await start("dist/index.js", "probe");
    const unavailable = await rawCall("obsidian_note_move_plan", {
      sourcePath: "Unavailable.md", destinationPath: "New/Unavailable moved.md", idempotencyKey: "probe",
    });
    assert.equal(unavailable.body.error.details.reasonCode, "hard_links_unsupported");
    await start("dist/index.js");
    const linkFailure = await movePlan("Unavailable.md", "New/Unavailable moved.md", "unavailable");
    await start("dist/index.js", "link");
    const linkConflict = await lifecycle("move", "apply", linkFailure, "unavailable");
    assert.equal(linkConflict.outcome, "conflict");
    assert.equal(linkConflict.reasonCode, "hard_links_unsupported");
    assert.equal(await read("Unavailable.md"), "link fixture");

    await put("Pre-effect.md", "no publication");
    const preEffect = await movePlan("Pre-effect.md", "New/Pre-effect moved.md", "pre-effect");
    await start("dist/index.js", "before-effect");
    await assert.rejects(lifecycle("move", "apply", preEffect, "pre-effect"), /closed|disconnect/i);
    await start("dist/index.js");
    const noEffect = await lifecycle("move", "status", preEffect);
    assert.equal(noEffect.outcome, "conflict");
    assert.equal(noEffect.recoveryAllowed, false);
    assert.equal(await read("Pre-effect.md"), "no publication");
    await missing("New/Pre-effect moved.md");

    await put("Partial.md", "partial version");
    await put("Reader/First partial.md", "[[Partial]]");
    await put("Reader/Second partial.md", "[[Partial]]");
    const partial = await movePlan("Partial.md", "New/Partial moved.md", "partial");
    await start("dist/index.js", "rewrite");
    await assert.rejects(lifecycle("move", "apply", partial, "partial"), /closed|disconnect/i);
    assert.equal(await read("Reader/First partial.md"), "[[Partial moved]]");
    await put("Reader/Second partial.md", "changed by Sync");
    await start("dist/index.js");
    const manual = await lifecycle("move", "status", partial);
    assert.equal(manual.recoveryAllowed, false);
    assert.equal(manual.abandonAllowed, true);
    assert.equal(manual.nextAction, "manual_repair");
    assert.equal(manual.reasonCode, "headless_manual_repair_required");
    const disjoint = await movePlan("Unavailable.md", "New/After abandon.md", "after-abandon");
    const pending = await rawCall("obsidian_note_move_apply", { planRef: disjoint.planRef, idempotencyKey: "after-abandon" });
    assert.equal(pending.body.error.details.reasonCode, "headless_operation_pending");
    const abandoned = await call("obsidian_note_move_recover", {
      planRef: partial.planRef, idempotencyKey: "partial", action: "abandon",
    });
    assert.equal(abandoned.outcome, "abandoned");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(isolatedStateDirectory, "operations.sqlite"), { readOnly: true });
    try {
      const saved = db.prepare("SELECT payload FROM headless_file_operations WHERE id = ?").get(partial.operationId);
      assert.equal(JSON.parse(saved.payload).rewrites.find(item => item.path === "Reader/First partial.md").beforeText, "[[Partial]]");
    } finally {
      db.close();
    }
    assert.equal(await read("Reader/Second partial.md"), "changed by Sync");
    const { readdir } = await import("node:fs/promises");
    assert(!(await readdir(at("Reader"))).some(file => file.startsWith(".optimike-")));
    assert.equal((await lifecycle("move", "apply", disjoint, "after-abandon")).outcome, "committed");

    await put("Sync.md", "sync fixture");
    await put("Reader/First sync.md", "[[Sync]]");
    await put("Reader/Second sync.md", "[[Sync]]");
    const syncMove = await movePlan("Sync.md", "New/Sync moved.md", "sync");
    await start("dist/index.js", "sync");
    const observedSync = await lifecycle("move", "apply", syncMove, "sync");
    assert.equal(observedSync.reasonCode, "headless_manual_repair_required");
    assert.equal(await read("Reader/Second sync.md"), "new external contents");
    await call("obsidian_note_move_recover", { planRef: syncMove.planRef, idempotencyKey: "sync", action: "abandon" });

    await put("Many.md", "many");
    await Promise.all(Array.from({ length: 101 }, (_, i) => put(`Reader/Many ${i}.md`, "[[Many]]")));
    const tooMany = await rawCall("obsidian_note_move_plan", {
      sourcePath: "Many.md", destinationPath: "New/Many moved.md", idempotencyKey: "many",
    });
    assert.equal(tooMany.body.error.details.reasonCode, "headless_backlink_limit");

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
