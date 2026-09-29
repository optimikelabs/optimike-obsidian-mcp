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
   MCP_ASSET_CHATGPT_FILE_INGRESS_ENABLED:"false",
   MCP_ASSET_CHATGPT_FILE_HOSTS:"",
   ...extra,
 };
 for(const key of ["OBSIDIAN_VAULT","MCP_ASSET_FOLDER","MCP_EXTERNAL_ROOTS_FILE","MCP_ASSET_CHATGPT_FILE_INGRESS_ENABLED","MCP_ASSET_CHATGPT_FILE_HOSTS"]) if(extra[key]===null) delete env[key];
 return spawnSync(process.execPath,["--input-type=module","-e",probe],{cwd:root,env,encoding:"utf8"});
}
assert.notEqual(run({OBSIDIAN_VAULT:null}).status,0,"enabled asset import must require OBSIDIAN_VAULT");
assert.notEqual(run({OBSIDIAN_VAULT:path.join(root,"fixture-vault"),MCP_ASSET_FOLDER:null}).status,0,"enabled asset import must require MCP_ASSET_FOLDER");
assert.notEqual(
 run({OBSIDIAN_VAULT:path.join(root,"fixture-vault"),MCP_EXTERNAL_ROOTS_FILE:null}),
 0,
 "enabled asset import without file ingress must require MCP_EXTERNAL_ROOTS_FILE",
);
assert.notEqual(
 run({
  OBSIDIAN_VAULT:path.join(root,"fixture-vault"),
  MCP_EXTERNAL_ROOTS_FILE:null,
  MCP_ASSET_CHATGPT_FILE_INGRESS_ENABLED:"true",
  MCP_ASSET_CHATGPT_FILE_HOSTS:null,
 }).status,
 0,
 "ChatGPT file ingress must require an explicit exact-host allowlist",
);
assert.equal(
 run({
  OBSIDIAN_VAULT:path.join(root,"fixture-vault"),
  MCP_EXTERNAL_ROOTS_FILE:null,
  MCP_ASSET_CHATGPT_FILE_INGRESS_ENABLED:"true",
  MCP_ASSET_CHATGPT_FILE_HOSTS:"files.example.test",
 }).status,
 0,
 "explicit ChatGPT file ingress can be the only configured source with an approved host",
);
assert.notEqual(
 run({
  OBSIDIAN_VAULT:path.join(root,"fixture-vault"),
  MCP_ASSET_CHATGPT_FILE_INGRESS_ENABLED:"true",
  MCP_ASSET_CHATGPT_FILE_HOSTS:"https://files.example.test",
 }).status,
 0,
 "ChatGPT file host policy accepts hostnames, not URL-shaped values",
);
assert.equal(run({OBSIDIAN_VAULT:path.join(root,"fixture-vault")}).status,0,"complete asset configuration should parse");
console.log("PASS test-asset-config.mjs");
