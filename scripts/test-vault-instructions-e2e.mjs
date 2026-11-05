#!/usr/bin/env node

// End to end through the real server process (dist/index.js, stdio,
// headless-filesystem) on temporary vaults: server instructions, a refused
// direct write, read proofs through obsidian_read_note, a rule edited on disk
// during the session, the off / no-AGENTS.md cases, a decomposed (NFD) folder
// name next to its NFC twin, and a read-only tag audit under enforce.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tempRoot = mkdtempSync(path.join(tmpdir(), "optimike-vault-instructions-e2e-"));

function vault(files) {
  const root = mkdtempSync(path.join(tempRoot, "vault-"));
  for (const [relative, content] of Object.entries(files)) writeVault(root, relative, content);
  return root;
}
function writeVault(root, relative, content) {
  const absolute = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

async function start(root, mode) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      OBSIDIAN_VAULT: root,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "..", `${path.basename(root)}-cache.sqlite`),
      OBSIDIAN_ENABLE_CACHE: "true",
      OBSIDIAN_API_KEY: "",
      OBSIDIAN_BASE_URL: "http://127.0.0.1:9",
      MCP_WRITE_MODE: "guarded",
      MCP_VAULT_INSTRUCTIONS: mode,
      MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH: path.join(root, "..", `${path.basename(root)}-seals.sqlite`),
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_TOOL_PROFILE: "full",
      MCP_LOG_LEVEL: "error",
    },
  });
  const client = new Client({ name: "vault-instructions-e2e", version: "0" });
  await client.connect(transport);
  await new Promise((resolve) => setTimeout(resolve, 750));
  return {
    client,
    async append(text) {
      const result = await client.callTool({
        name: "obsidian_update_note",
        arguments: {
          targetType: "filePath",
          targetIdentifier: "Projects/Note.md",
          modificationType: "wholeFile",
          wholeFileMode: "append",
          content: text,
        },
      });
      let json;
      try {
        json = JSON.parse(result.content?.[0]?.text);
      } catch {
        json = undefined;
      }
      return { result, json };
    },
    read(filePath) {
      return client.callTool({ name: "obsidian_read_note", arguments: { filePath } });
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      let json;
      try {
        json = JSON.parse(result.content?.[0]?.text);
      } catch {
        json = undefined;
      }
      return { result, json };
    },
    appendTo(filePath, text) {
      return this.call("obsidian_update_note", {
        targetType: "filePath",
        targetIdentifier: filePath,
        modificationType: "wholeFile",
        wholeFileMode: "append",
        content: text,
      });
    },
    close: () => client.close(),
  };
}

const RULES = "# Vault\nRead me first.\n";
const LOCAL = "# Projects\nKeep project notes short.\n";

try {
  // enforce, with a cascade
  const root = vault({ "AGENTS.md": RULES, "Projects/AGENTS.md": LOCAL, "Projects/Note.md": "start\n" });
  const note = path.join(root, "Projects", "Note.md");
  const server = await start(root, "enforce");
  const instructions = server.client.getInstructions();
  assert.match(instructions ?? "", /AGENTS\.md/u, "server instructions announce the vault rules");
  assert.match(instructions, /vault_instructions_unread/u);
  assert.doesNotMatch(instructions, /Read me first/u);

  const refused = await server.append("\nfirst");
  assert.equal(refused.result.isError, true);
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_unread");
  assert.deepEqual(refused.json.vaultInstructions.files.map((entry) => [entry.path, entry.state]), [
    ["AGENTS.md", "unread"],
    ["Projects/AGENTS.md", "unread"],
  ]);
  assert.equal(readFileSync(note, "utf8"), "start\n", "nothing was written");

  await server.read("AGENTS.md");
  const stillRefused = await server.append("\nfirst");
  assert.deepEqual(stillRefused.json.vaultInstructions.nextActions, [
    { tool: "obsidian_read_note", arguments: { filePath: "Projects/AGENTS.md" } },
  ]);
  await server.read("Projects/AGENTS.md");
  const written = await server.append("\nfirst");
  assert.equal(written.result.isError, false, JSON.stringify(written.result));
  assert.match(readFileSync(note, "utf8"), /first/u);

  writeVault(root, "Projects/AGENTS.md", `${LOCAL}New rule.\n`);
  const changed = await server.append("\nsecond");
  assert.equal(changed.json.error.details.reasonCode, "vault_instructions_unread");
  assert.deepEqual(
    changed.json.vaultInstructions.files.filter((entry) => entry.state !== "read").map((entry) => [entry.path, entry.state]),
    [["Projects/AGENTS.md", "changed"]],
  );
  const reread = await server.read("Projects/AGENTS.md");
  assert.match(reread.content[0].text, /New rule/u, "the read serves the edited file, not a stale cache");
  const second = await server.append("\nsecond");
  assert.equal(second.result.isError, false);
  await server.close();

  // off: unchanged behaviour, no instructions
  const offRoot = vault({ "AGENTS.md": RULES, "Projects/AGENTS.md": LOCAL, "Projects/Note.md": "start\n" });
  const off = await start(offRoot, "off");
  assert.equal(off.client.getInstructions(), undefined);
  const offWrite = await off.append("\nfree");
  assert.equal(offWrite.result.isError, false);
  assert.equal(offWrite.json?.vaultInstructions, undefined);
  await off.close();

  // enforce on a vault without any AGENTS.md: unchanged behaviour
  const plainRoot = vault({ "Projects/Note.md": "start\n" });
  const plain = await start(plainRoot, "enforce");
  assert.equal(plain.client.getInstructions(), undefined);
  const plainWrite = await plain.append("\nfree");
  assert.equal(plainWrite.result.isError, false);
  assert.equal(plainWrite.json?.vaultInstructions, undefined);
  await plain.close();

  // enforce, a decomposed (NFD) folder name: the write is checked against the
  // folder the backend really writes, and against its NFC twin when it exists.
  const nfd = "Cafe\u0301";
  const nfc = "Caf\u00e9";
  const unicodeRoot = vault({ [`${nfd}/AGENTS.md`]: "# NFD rules\n", [`${nfd}/N.md`]: "before\n" });
  const unicodeNote = path.join(unicodeRoot, nfd, "N.md");
  const unicode = await start(unicodeRoot, "enforce");
  const nfdRefused = await unicode.appendTo(`${nfd}/N.md`, "after");
  assert.equal(nfdRefused.result.isError, true, "an unread local rule in an NFD folder refuses the write");
  assert.equal(nfdRefused.json.error.details.reasonCode, "vault_instructions_unread");
  assert.deepEqual(nfdRefused.json.vaultInstructions.files.map((entry) => entry.path), [`${nfd}/AGENTS.md`]);
  assert.equal(readFileSync(unicodeNote, "utf8"), "before\n", "nothing was written");
  await unicode.read(`${nfd}/AGENTS.md`);
  const nfdWritten = await unicode.appendTo(`${nfd}/N.md`, "after");
  assert.equal(nfdWritten.result.isError, false, JSON.stringify(nfdWritten.json));
  assert.match(readFileSync(unicodeNote, "utf8"), /after/u);
  await unicode.close();

  const twinsRoot = vault({ [`${nfd}/AGENTS.md`]: "# NFD rules\n", [`${nfc}/AGENTS.md`]: "# NFC rules\n", [`${nfd}/N.md`]: "before\n" });
  const twins = await start(twinsRoot, "enforce");
  const twinsRefused = await twins.appendTo(`${nfd}/N.md`, "after");
  assert.equal(twinsRefused.json.error.details.reasonCode, "vault_instructions_unread");
  assert.deepEqual(
    twinsRefused.json.vaultInstructions.files.map((entry) => entry.path).sort(),
    [`${nfd}/AGENTS.md`, `${nfc}/AGENTS.md`].sort(),
    "both spellings are checked when two folders exist",
  );
  await twins.read(`${nfd}/AGENTS.md`);
  await twins.read(`${nfc}/AGENTS.md`);
  const twinsWritten = await twins.appendTo(`${nfd}/N.md`, "after");
  assert.equal(twinsWritten.result.isError, false, JSON.stringify(twinsWritten.json));
  assert.match(readFileSync(path.join(twinsRoot, nfd, "N.md"), "utf8"), /after/u);
  await twins.close();

  // enforce: a read-only tag audit is never gated.
  const tagsRoot = vault({ "AGENTS.md": RULES, "Projects/AGENTS.md": LOCAL, "Projects/Note.md": "#alpha\n" });
  const tags = await start(tagsRoot, "enforce");
  const audit = await tags.call("obsidian_manage_tags", { operation: "audit" });
  assert.equal(audit.result.isError, false, JSON.stringify(audit.json));
  assert.equal(audit.json.vaultInstructions, undefined);
  await tags.close();

  console.log("vault instructions end-to-end test passed");
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // A temporary folder left behind is harmless.
  }
}
