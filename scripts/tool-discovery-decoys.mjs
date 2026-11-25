/**
 * Competing MCP servers for scripts/run-tool-discovery-eval.mjs --decoys.
 *
 * Each <server>.json in the decoy directory holds a captured catalogue
 * ({serverName, tools, serverInfo?, instructions?}). Every decoy is served by
 * the same catalogue-only replay server as the fixture, so a measured client
 * sees the competitor's real names and descriptions, and any call is refused
 * and logged before it could reach the real service.
 *
 * Decoy tools are reported by their client name, `mcp__<server>__<tool>`; the
 * fixture's tools keep their bare names.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { measureToolsList } from "./measure-tool-profile-schemas.mjs";

// Name parts that mark a tool which changes state, for catalogues without
// annotations. Annotations win when present.
const WRITE_PARTS = new Set([
  "add", "adopt", "append", "apply", "approve", "archive", "assign", "batch", "block",
  "cancel", "clear", "close", "complete", "convert", "create", "cut", "decline", "delete",
  "dictate", "dissociate", "duplicate", "edit", "enable", "disable", "generate", "import",
  "invite", "launch", "link", "merge", "move", "organize", "patch", "pause", "pin", "post",
  "publish", "push", "put", "record", "redeem", "regenerate", "reject", "remove", "rename",
  "reorder", "replace", "reset", "respond", "restore", "revise", "revoke", "run", "save",
  "schedule", "send", "set", "share", "sign", "split", "start", "stop", "submit", "subscribe",
  "toggle", "transfer", "trash", "unlink", "unpin", "unpublish", "unshare", "update",
  "upload", "upsert", "void", "write",
]);

function codexServerName(server) {
  return server.replace(/[^A-Za-z0-9]/gu, "_");
}

export function decoyToolWrites(tool) {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === true) return false;
  if (hints.readOnlyHint === false || hints.destructiveHint === true) return true;
  return tool.name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((part) => WRITE_PARTS.has(part));
}

export function loadDecoys(directory, { fixtureServer, fixtureTools, replay }) {
  const fixtureNames = new Set(fixtureTools.map((tool) => tool.name));
  const servers = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const catalog = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      const server = catalog.serverName ?? path.basename(file, ".json");
      if (server === fixtureServer) throw new Error(`Decoy ${file} reuses the fixture server name.`);
      const served = {
        serverInfo: catalog.serverInfo ?? { name: server, version: "decoy" },
        ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
        tools: catalog.tools,
      };
      return { server, tools: catalog.tools, fixture: replay(served, server), served };
    });
  const writes = new Map();
  const aliases = new Map();
  const bareCount = new Map();
  for (const { tools } of servers) {
    for (const tool of tools) bareCount.set(tool.name, (bareCount.get(tool.name) ?? 0) + 1);
  }
  const codexNames = new Set();
  const decoySurface = [];
  for (const { server, tools } of servers) {
    for (const tool of tools) {
      const full = `mcp__${server}__${tool.name}`;
      const codex = `${codexServerName(server)}__${tool.name}`;
      writes.set(full, decoyToolWrites(tool));
      codexNames.add(codex);
      aliases.set(codex, full);
      aliases.set(`mcp__${codex}`, full);
      if (!fixtureNames.has(tool.name) && bareCount.get(tool.name) === 1) aliases.set(tool.name, full);
      decoySurface.push({ ...tool, name: full, server, bareName: tool.name });
    }
  }
  const isDecoy = (name) => writes.has(name);
  return {
    summary: servers.map(({ server, tools }) => ({
      server,
      tools: tools.length,
      writeTools: tools.filter(decoyToolWrites).length,
      characters: JSON.stringify(tools).length,
    })),
    toolNames: new Set(writes.keys()),
    codexNames,
    aliases,
    rankingSurface: [
      ...fixtureTools.map((tool) => ({ ...tool, server: fixtureServer, bareName: tool.name })),
      ...decoySurface,
    ],
    launchesFor: (slot) => servers.map(({ server, fixture }) => ({ server, launch: fixture.launchFor(slot) })),
    refusedCalls: (slot) =>
      servers.flatMap(({ server, fixture }) =>
        fixture.refusedCalls(slot).map((name) => `mcp__${server}__${name}`),
      ),
    async verify(verifyReplay) {
      const results = {};
      for (const { server, fixture, served } of servers) {
        results[server] = await verifyReplay(fixture, measureToolsList(served.tools).toolsListSha256);
      }
      return results;
    },
    rankingScore(testCase, ranked) {
      const firstExpected = ranked.findIndex((name) => testCase.expected.includes(name));
      const foreignWriteAt = ranked.findIndex((name) => writes.get(name) === true);
      return {
        foreignFirst: ranked.length > 0 && isDecoy(ranked[0]),
        foreignWriteFirst: ranked.length > 0 && writes.get(ranked[0]) === true,
        foreignWriteAboveExpected:
          foreignWriteAt !== -1 &&
          foreignWriteAt < 3 &&
          (firstExpected === -1 || foreignWriteAt < firstExpected),
      };
    },
    finalScore(_testCase, finalAnswer) {
      return {
        finalForeign: isDecoy(finalAnswer),
        finalForeignWrite: writes.get(finalAnswer) === true,
      };
    },
  };
}
