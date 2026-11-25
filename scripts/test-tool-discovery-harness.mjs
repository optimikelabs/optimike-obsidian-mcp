#!/usr/bin/env node
/**
 * Model-free checks of the tool-discovery harness guards
 * (scripts/run-tool-discovery-eval.mjs, scripts/tool-discovery-decoys.mjs).
 * No client, model or network: decoy catalogues are synthetic.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexIsolationVerdict } from "./run-tool-discovery-eval.mjs";
import { loadDecoys } from "./tool-discovery-decoys.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "optimike-obsidian-mcp-stdio";
const root = mkdtempSync(path.join(os.tmpdir(), "optimike-discovery-harness-"));
let checks = 0;

function decoyDir(name, catalogs) {
  const directory = path.join(root, name);
  mkdirSync(directory);
  for (const [file, catalog] of Object.entries(catalogs)) {
    writeFileSync(path.join(directory, file), JSON.stringify(catalog), "utf8");
  }
  return directory;
}

function load(directory, reservedClientNames = []) {
  let replays = 0;
  const decoys = loadDecoys(directory, {
    fixtureServer: FIXTURE,
    fixtureTools: [{ name: "obsidian_read_note" }],
    reservedClientNames,
    replay: () => {
      replays++;
      return { launchFor: () => ({}), refusedCalls: () => [] };
    },
  });
  return { decoys, replays: () => replays };
}

try {
  // A bare decoy name must not hide the client name of another decoy tool.
  {
    const { decoys } = load(
      decoyDir("alias", {
        "foo.json": {
          serverName: "foo",
          tools: [
            { name: "send", annotations: { readOnlyHint: false } },
            { name: "foo__send", annotations: { readOnlyHint: true } },
          ],
        },
      }),
    );
    assert.equal(decoys.aliases.get("foo__send"), "mcp__foo__send", "client name wins over a bare name");
    assert.equal(decoys.finalScore({}, decoys.aliases.get("foo__send")).finalForeignWrite, true);
    assert.equal(decoys.aliases.get("mcp__foo__foo__send"), "mcp__foo__foo__send");
    assert.equal(decoys.finalScore({}, "mcp__foo__foo__send").finalForeignWrite, false);
    checks++;
  }

  // Unsafe or colliding names are refused before any replay is written.
  for (const [name, catalogs, reserved, message] of [
    ["path", { "a.json": { serverName: "../x", tools: [{ name: "a" }] } }, [], /server name must match/u],
    [
      "namespace",
      {
        "a.json": { serverName: "work-app", tools: [{ name: "a" }] },
        "b.json": { serverName: "work_app", tools: [{ name: "a" }] },
      },
      [],
      /collides with work-app/u,
    ],
    ["builtin", { "a.json": { serverName: "web", tools: [{ name: "run" }] } }, ["web__run"], /web__run/u],
    [
      "full-name",
      {
        "a.json": { serverName: "a", tools: [{ name: "b__c" }] },
        "b.json": { serverName: "a__b", tools: [{ name: "c" }] },
      },
      [],
      /a__b__c/u,
    ],
  ]) {
    let replays = 0;
    assert.throws(
      () =>
        loadDecoys(decoyDir(name, catalogs), {
          fixtureServer: FIXTURE,
          fixtureTools: [{ name: "obsidian_read_note" }],
          reservedClientNames: reserved,
          replay: () => {
            replays++;
            return {};
          },
        }),
      message,
      name,
    );
    assert.equal(replays, 0, `${name}: nothing written before the refusal`);
    checks++;
  }

  // Codex isolation accepts nothing a replay server refused, even when the
  // session record shows no top-level call.
  {
    const fixtureTools = new Set(["obsidian_read_note"]);
    const printed = JSON.stringify([`mcp__${FIXTURE.replace(/[^A-Za-z0-9]/gu, "_")}__obsidian_read_note`, "apply_patch"]);
    const run = { otherCalls: [], cells: [{}], rolloutFound: true, exitCode: 0 };
    assert.equal(codexIsolationVerdict({ printed, run, fixtureTools, refusedCalls: [] }).ok, true);
    const refused = codexIsolationVerdict({ printed, run, fixtureTools, refusedCalls: ["obsidian_read_note"] });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.evidence.refusedCalls, ["obsidian_read_note"]);
    checks++;
  }

  // Codex cannot be measured next to untrusted decoy catalogues.
  {
    let failure;
    try {
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "run-tool-discovery-eval.mjs"), "--client=codex", `--decoys=${root}`],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "codex with decoys must fail");
    assert.match(failure.stderr, /--decoys is not supported with --client=codex/u);
    checks++;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`tool-discovery harness checks passed (${checks})`);
