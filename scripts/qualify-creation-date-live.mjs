// Isolated technical G1 replay. Credentials are inherited privately; never serialized.
import assert from "node:assert/strict";
import { load } from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const out = path.resolve(process.argv[2]);
const cfg = JSON.parse(
  fs.readFileSync(path.join(out, "obsidian.json"), "utf8"),
);
const scenario = JSON.parse(
  fs.readFileSync(path.join(out, "scenario.json"), "utf8"),
);
assert(![27123, 27124].includes(cfg.port));
assert(cfg.vault.startsWith(path.dirname(out)) && !cfg.vault.startsWith("F:"));
const kit = path.resolve(out, "../../test-comparatif/kit/scripts");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const save = (name, value) =>
  fs.writeFileSync(
    path.join(out, name + ".json"),
    JSON.stringify(value, null, 2),
    "utf8",
  );
const noteFile = path.join(cfg.vault, scenario.note);
const content = () => fs.readFileSync(noteFile, "utf8");
const frontmatter = (text) =>
  load(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "") ?? {};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function cdp(expression, name) {
  const expr = path.join(out, name + ".js");
  fs.writeFileSync(expr, expression, "utf8");
  const result = spawnSync(
    process.execPath,
    [path.join(kit, "campaign_cdp.mjs"), path.join(out, "obsidian.json"), expr],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout).result;
  save(name, value);
  return value;
}
function snapshot(name) {
  const dest = path.join(out, "snapshots", name);
  fs.cpSync(cfg.vault, dest, { recursive: true });
  const manifest = {};
  function walk(dir, rel = "") {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const key = rel ? rel + "/" + item.name : item.name;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file, key);
      else {
        const bytes = fs.readFileSync(file);
        manifest[key] = { sha256: hash(bytes), size: bytes.length };
      }
    }
  }
  walk(dest);
  save(name + "-manifest", manifest);
  return manifest;
}
async function settle() {
  let previous = content(),
    since = Date.now();
  const end = Date.now() + 65_000;
  while (Date.now() < end) {
    await delay(250);
    const current = content();
    if (current !== previous) {
      previous = current;
      since = Date.now();
    }
    // Delivered FDM min interval (30 s) + debounce/freshness (7.25 s), no installer shortcut.
    if (Date.now() - since >= 38_000) return;
  }
  throw Error("FDM did not settle");
}
const client = new Client({ name: "creation-b-G1", version: "1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js"), "--tool-profile", "authoring"],
  env: {
    ...process.env,
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_PROTOCOL_MODE: "legacy",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (data) =>
  fs.appendFileSync(path.join(out, "mcp.stderr.log"), data),
);
async function call(name, args, error = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  });
  const payload = JSON.parse(
    result.content.find((c) => c.type === "text").text,
  );
  fs.appendFileSync(
    path.join(out, "mcp-wire.jsonl"),
    JSON.stringify({
      utc: new Date().toISOString(),
      name,
      arguments: args,
      result,
    }) + "\n",
    "utf8",
  );
  if (Boolean(result.isError) !== error) {
    await cdp(
      "({observations:globalThis.__creationB,error:globalThis.__creationBError})",
      "unexpected-error-native-proof",
    );
  }
  assert.equal(Boolean(result.isError), error, JSON.stringify(payload));
  return payload;
}
try {
  await client.connect(transport);
  save("catalogue", await client.listTools());
  const initial = content();
  assert(!initial.includes("création:"));
  snapshot("B0-sans-date");
  const admission = await cdp(
    `(()=>{const bridge=app.plugins.getPlugin('obsidian-atomic-write-bridge');const prepare=bridge.datePreparation;bridge.datePreparation=Object.assign(async(...args)=>{try{return await prepare(...args)}catch(e){globalThis.__creationBError={message:e.message,stack:e.stack};throw e;}},{dispose:prepare.dispose});const p=app.plugins.getPlugin('frontmatter-date-manager');const original=app.fileManager.processFrontMatter;globalThis.__creationB=[];app.fileManager.processFrontMatter=function(file,cb,...args){const stack=new Error().stack;return original.call(this,file,fm=>{const before=JSON.parse(JSON.stringify(fm));const value=cb(fm);globalThis.__creationB.push({path:file.path,fromFdm:stack.includes('plugin:frontmatter-date-manager'),before,after:JSON.parse(JSON.stringify(fm)),utc:Date.now()});return value;},...args);};return {bridgeWritesEnabled:!!app.plugins.getPlugin('obsidian-atomic-write-bridge')?.allowWrites,vault:app.vault.adapter.basePath,plugins:Object.fromEntries(Object.entries(app.plugins.plugins).map(([id,p])=>[id,p.manifest.version])),fdmSettings:{enableAutoUpdate:p.settings.enableAutoUpdate,headerCreated:p.settings.headerCreated}};})()`,
    "runtime-admission",
  );
  assert.equal(
    admission.bridgeWritesEnabled,
    true,
    "Isolated Bridge writes must be enabled",
  );
  const first = await call("obsidian_text_patch_plan", {
    path: scenario.note,
    operations: [
      {
        op: "replace_literal",
        search: scenario.old,
        replacement: scenario.new,
      },
    ],
    idempotencyKey: "creation-b-G1-conflict",
    responseMode: "compact",
  });
  assert.equal(first.phase, "planned");
  assert.equal(first.datePreparation.kind, "date-manager-before-plan");
  assert(initial.includes("\r\n"), "G1 fixture must exercise CRLF");
  assert.equal(first.datePreparation.lineEndingsNormalized, true);
  assert.match(
    first.datePreparation.message,
    /fins de ligne normalisées par Obsidian pendant la datation/,
  );
  assert.match(content(), /création:/);
  const creationByFdm = frontmatter(content())["création"];
  assert.equal(typeof creationByFdm, "string");
  assert(content().includes(scenario.old));
  const observations = await cdp(
    "globalThis.__creationB",
    "datation-native-preuves",
  );
  assert(
    observations.some(
      (row) =>
        row.path === scenario.note &&
        row.fromFdm &&
        !row.before["création"] &&
        row.after["création"],
    ),
  );
  snapshot("B0-datee-apres-plan");
  const before = content();
  const position = before.indexOf(scenario.old);
  assert(position >= 0);
  const edited = spawnSync(
    process.execPath,
    [
      path.join(kit, "retouche-editeur.mjs"),
      "--port",
      String(cfg.port),
      "--vault",
      cfg.vault,
      "--note",
      scenario.note,
      "--position",
      String(position),
      "--delete-length",
      String(scenario.old.length),
      "--text",
      scenario.retouche,
      "--expected-before-sha256",
      hash(before),
    ],
    { encoding: "utf8", timeout: 65_000 },
  );
  assert.equal(edited.status, 0, edited.stderr);
  save("retouche-editeur", JSON.parse(edited.stdout));
  await settle();
  const B1 = snapshot("B1");
  const refused = await call("obsidian_text_patch_apply", {
    planRef: first.planRef,
    idempotencyKey: "creation-b-G1-conflict",
    completionMode: "verified",
  });
  assert.equal(refused.outcome, "conflict");
  const B2 = snapshot("B2");
  assert.deepEqual(B2[scenario.note], B1[scenario.note]);
  const accepted = await call("obsidian_text_patch_plan", {
    path: scenario.note,
    operations: [
      { op: "append_body", text: "\n" + scenario.accepted_line + "\n" },
    ],
    idempotencyKey: "creation-b-G1-accepted",
  });
  assert(!accepted.datePreparation);
  const args = {
    planRef: accepted.planRef,
    idempotencyKey: "creation-b-G1-accepted",
    completionMode: "verified",
  };
  let committed = await call("obsidian_text_patch_apply", args);
  for (let i = 0; committed.outcome !== "committed" && i < 4; i++) {
    if (committed.postflight.checkAfter)
      await delay(
        Math.max(0, Date.parse(committed.postflight.checkAfter) - Date.now()) +
          500,
      );
    committed = await call("obsidian_text_patch_status", {
      planRef: accepted.planRef,
    });
  }
  assert.equal(committed.outcome, "committed");
  assert.equal(committed.postflight.status, "verified");
  const B3 = snapshot("B3");
  const replay = await call("obsidian_text_patch_apply", args);
  const B4 = snapshot("B4");
  assert.equal(replay.operationId, committed.operationId);
  assert.equal(replay.outcome, "committed");
  assert.deepEqual(B4, B3);
  assert.equal(content().split(scenario.accepted_line).length - 1, 1);
  assert(content().includes(scenario.retouche));
  assert.equal(frontmatter(content())["création"], creationByFdm);
  const beforeForbidden = content();
  const forbiddenDate = await call(
    "obsidian_frontmatter_patch_plan",
    {
      path: scenario.note,
      operations: [{ op: "set", key: "création", value: "2099-01-01T00:00" }],
      idempotencyKey: "creation-b-protected-date",
    },
    true,
  );
  assert.equal(forbiddenDate.error.code, "FORBIDDEN");
  assert.equal(content(), beforeForbidden);
  save("G1-VERIFICATION", {
    passed: true,
    deterministicTechnicalReplay: true,
    noComparisonOfModels: true,
    dateOwnedByFdm: true,
    lineEndingsNormalized: first.datePreparation.lineEndingsNormalized,
    datePreparationMessage: first.datePreparation.message,
    creationPreserved: frontmatter(content())["création"] === creationByFdm,
    clientDateWriteRejected: forbiddenDate.error.code === "FORBIDDEN",
    conflict: refused.outcome,
    B1equalsB2note: true,
    B3equalsB4allFiles: true,
    committed: committed.outcome,
    postflight: committed.postflight.status,
    acceptedOccurrences: 1,
    target: scenario.note,
    plan: first.planRef,
    acceptedPlan: accepted.planRef,
  });
  // Both template paths and FDM exclusions must remain undated after delayed FDM callbacks.
  await cdp(
    String.raw`(async()=>{
    const t=app.plugins.getPlugin('templater-obsidian');
    if(!t) throw Error('Templater required for scope qualification');
    t.settings.templates_folder='CreationB templates';
    const f=app.plugins.getPlugin('frontmatter-date-manager');
    f.settings.filterRules += '\nCreationB excluded'; f.recompileFilterRules();
    for(const folder of ['CreationB templates','CreationB excluded']) await app.vault.createFolder(folder);
    for(const p of ['X/Modèles/CreationB.md','CreationB templates/Model.md','CreationB excluded/Note.md']) await app.vault.create(p,'---\nstatut: test\n---\nBefore scope test\n');
    return {templates:t.settings.templates_folder,filterRules:f.settings.filterRules};
  })()`,
    "scope-config",
  );
  const scopePaths = [
    "X/Modèles/CreationB.md",
    "CreationB templates/Model.md",
    "CreationB excluded/Note.md",
  ];
  for (const [i, scopePath] of scopePaths.entries()) {
    const p = await call("obsidian_text_patch_plan", {
      path: scopePath,
      operations: [{ op: "append_body", text: "Accepted scope test" }],
      idempotencyKey: "scope-" + i,
    });
    assert.equal(p.datePreparation.kind, "outside-date-management");
    const r = await call("obsidian_text_patch_apply", {
      planRef: p.planRef,
      idempotencyKey: "scope-" + i,
      completionMode: "verified",
    });
    assert.equal(r.outcome, "committed");
    assert.equal(r.postflight.status, "verified");
  }
  await delay(38_000);
  for (const scopePath of scopePaths) {
    const raw = fs.readFileSync(path.join(cfg.vault, scopePath), "utf8");
    assert(!raw.includes("création:") && !raw.includes("modification:"));
    assert(raw.includes("Accepted scope test"));
  }
  save("scope-verification", {
    passed: true,
    paths: scopePaths,
    observedAfterMs: 38000,
    noDates: true,
  });
  const undated = "CreationB no manager.md";
  await cdp(
    "(async()=>{await app.plugins.unloadPlugin('frontmatter-date-manager');await app.vault.create('CreationB no manager.md','Undated ordinary note');return true;})()",
    "create-no-manager",
  );
  const noManagerBefore = fs.readFileSync(path.join(cfg.vault, undated));
  await cdp(
    "(()=>({fdmLoaded:!!app.plugins.getPlugin('frontmatter-date-manager')}))()",
    "fdm-unloaded",
  );
  const noManager = await call(
    "obsidian_text_patch_plan",
    {
      path: undated,
      operations: [{ op: "append_body", text: "blocked" }],
      idempotencyKey: "creation-b-no-manager",
    },
    true,
  );
  assert.equal(
    noManager.error.details.reasonCode,
    "atomic_write_creation_property_missing",
  );
  assert.equal(
    noManager.error.message,
    "Cette note n'a pas encore de date de création. Ouvrez-la dans Obsidian et enregistrez-la une fois, puis réessayez.",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(cfg.vault, undated)),
    noManagerBefore,
  );
  save("sans-gestionnaire-verification", {
    passed: true,
    target: undated,
    unchanged: true,
    error: noManager,
  });
  console.log(
    "PASS: real isolated G1, FDM dates before plan, stale plan refused, verified commit, identical replay.",
  );
} finally {
  await client.close();
}
