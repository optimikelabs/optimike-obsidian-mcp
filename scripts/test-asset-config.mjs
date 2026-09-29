import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("..",import.meta.url));
const probe='await import("./dist/config/index.js")';
function run(extra={}){
 const env={...process.env,
   NODE_ENV:"test",
   OBSIDIAN_RUNTIME_MODE:"live",
   OBSIDIAN_API_KEY:"fixture-only",
   OBSIDIAN_BASE_URL:"http://127.0.0.1:9",
   MCP_ASSET_IMPORT_ENABLED:"true",
   MCP_WRITE_MODE:"full",
   MCP_ASSET_FOLDER:"Images",
   MCP_EXTERNAL_ROOTS_FILE:path.join(root,"fixture-external-roots.json"),
   ...extra,
 };
 for(const key of ["OBSIDIAN_VAULT","MCP_ASSET_FOLDER","MCP_EXTERNAL_ROOTS_FILE"]) if(extra[key]===null) delete env[key];
 return spawnSync(process.execPath,["--input-type=module","-e",probe],{cwd:root,env,encoding:"utf8"});
}
assert.notEqual(run({OBSIDIAN_VAULT:null}).status,0,"enabled asset import must require OBSIDIAN_VAULT");
assert.notEqual(run({OBSIDIAN_VAULT:path.join(root,"fixture-vault"),MCP_ASSET_FOLDER:null}).status,0,"enabled asset import must require MCP_ASSET_FOLDER");
assert.notEqual(run({OBSIDIAN_VAULT:path.join(root,"fixture-vault"),MCP_EXTERNAL_ROOTS_FILE:null}).status,0,"enabled asset import must require MCP_EXTERNAL_ROOTS_FILE");
assert.equal(run({OBSIDIAN_VAULT:path.join(root,"fixture-vault")}).status,0,"complete asset configuration should parse");
console.log("PASS test-asset-config.mjs");
