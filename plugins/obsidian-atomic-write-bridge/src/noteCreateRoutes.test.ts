import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { App } from "obsidian";
import { createNoteCreateRoutes } from "./noteCreateRoutes.js";
import { noteCreateHash } from "../../../src/services/noteCreateContract.js";

test("M4 routes reject stale bindings with request identity and never create or suffix a conflicted target", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "create-routes-"));
  let enabled = true;
  const handlers = new Map<string, (req: any, res: any) => void>();
  const app = { vault: { adapter: { getBasePath: () => root }, getAbstractFileByPath: () => null } } as unknown as App;
  const routes = createNoteCreateRoutes(app, { binding: () => "a".repeat(64), enabled: () => enabled })!;
  routes.mount({ addRoute: url => ({ post: fn => { handlers.set(url, fn); } }) });
  function call(suffix: string, body: unknown) {
    let code = 0; let result: any;
    const res = { status: (n: number) => { code = n; return res; }, json: (v: unknown) => { result = v; } };
    handlers.get("/extensions/obsidian-atomic-write-bridge/note-create/" + suffix)!({ body }, res);
    return { code, result };
  }
  try {
    const p = call("preflight", { contractVersion: 1, path: "A.md" });
    assert.equal(p.code, 200);
    const request = { contractVersion: 1, operationId: randomUUID(), path: "A.md", content: "# A\n",
      contentSha256: noteCreateHash("# A\n"), bindingFingerprint: p.result.bindingFingerprint, policyDigest: p.result.policyDigest };
    const stale = call("apply", { ...request, bindingFingerprint: "b".repeat(64) });
    assert.equal(stale.result.outcome, "conflict");
    assert.equal(stale.result.bindingFingerprint, "b".repeat(64));
    assert.deepEqual(readdirSync(root), []);
    assert.equal(call("apply", request).result.outcome, "created");
    assert.equal(call("apply", request).result.outcome, "conflict");
    assert.deepEqual(readdirSync(root), ["A.md"]);
    (app as any).plugins = { plugins: { "frontmatter-date-manager": { settings: {
      enableAutoUpdate: true, enableCreateTime: true, enableModifiedTime: true, enableLastViewed: true,
      headerCreated: "created", headerUpdated: "updated", dateFormat: "yyyy-MM-dd'T'HH:mm",
    } } } };
    const found = call("inspect", { contractVersion: 1, path: "A.md" });
    assert.equal(found.result.content, "# A\n");
    assert.equal(found.result.sha256, request.contentSha256);
    assert.equal("policyDigest" in found.result, false);
    enabled = false;
    const rejected = call("apply", { ...request, operationId: randomUUID(), path: "B.md" });
    assert.equal(rejected.result.outcome, "conflict");
    assert.deepEqual(readdirSync(root), ["A.md"]);
    const invalid = call("apply", { ...request, path: "../private.md" });
    assert.equal(invalid.code, 400);
    assert.equal(JSON.stringify(invalid.result).includes(root), false);
    assert.equal(JSON.stringify(invalid.result).includes("private.md"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
