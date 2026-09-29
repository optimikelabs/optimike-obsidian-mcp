import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import yaml from "js-yaml";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const pkg=JSON.parse(read("package.json"));
for(const doc of ["docs/asset-import.md","docs/asset-import.fr.md"]) {
 const text=read(doc);assert.ok(pkg.files.includes(doc));
 for(const term of ["MCP_ASSET_FOLDER","OBSIDIAN_VAULT","MCP_ASSET_IMPORT_ENABLED","MCP_WRITE_MODE","external:read","NOT_RUN","asset_import_plan","asset_import_apply","asset_import_status"])
  assert.ok(text.includes(term),doc+" must declare "+term);
 assert.ok(!text.includes("http://127.0.0.1:27123"),"do not publish production-specific setup");
 assert.ok(!text.includes("?"),doc+" must not contain lossy replacement punctuation");
}
const flow=yaml.load(read(".github/workflows/asset-import.yml"));
for(const event of ["pull_request","push"])for(const pattern of ["src/**","scripts/**","package*.json","tsconfig*.json",".gitattributes"])
 assert.ok(flow.on[event].paths.includes(pattern),event+" must cover "+pattern);
assert.deepEqual(flow.jobs.assets.strategy.matrix.os,["windows-latest","ubuntu-latest"]);
assert.deepEqual(flow.jobs.assets.strategy.matrix.node,[22,24]);
assert.ok(flow.jobs.assets.steps.some(s=>s.run==="npm run test:assets"));
assert.equal(flow.permissions.contents,"read");
for(const file of ["test-asset-native.mjs","test-asset-processing.mjs","test-asset-operation.mjs","test-asset-surface.mjs"])assert.ok(pkg.scripts["test:assets"].includes(file));
console.log("PASS: optional asset contract, bounded suite, package entries and transitive Windows/Linux Node22/24 gate");
