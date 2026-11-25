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
 * fixture's tools keep their bare names. A decoy "writes" by its annotations,
 * else by a presumption from its name parts (`writeBasis` in the summary).
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

const SERVER_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

function codexServerName(server) {
  return server.replace(/[^A-Za-z0-9]/gu, "_");
}

function annotatedWrite(tool) {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === true) return false;
  if (hints.readOnlyHint === false || hints.destructiveHint === true) return true;
  return undefined;
}

export function decoyToolWrites(tool) {
  return (
    annotatedWrite(tool) ??
    tool.name
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .some((part) => WRITE_PARTS.has(part))
  );
}

export function loadDecoys(
  directory,
  { fixtureServer, fixtureTools, replay, reservedClientNames = [] },
) {
  const fixtureNames = new Set(fixtureTools.map((tool) => tool.name));
  // Validate every name before anything is written: the server name becomes a
  // private directory, a client config key and a Codex namespace.
  const clientNames = new Map([[codexServerName(fixtureServer), fixtureServer]]);
  // One client name per tool: no clash with another decoy tool, a fixture tool
  // or a client built-in (`web__run`), or the isolation check could count one
  // tool as proof of another.
  const takenToolNames = new Set([
    ...reservedClientNames,
    ...fixtureTools.map((tool) => `${codexServerName(fixtureServer)}__${tool.name}`),
  ]);
  const catalogs = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const catalog = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      const server = catalog.serverName ?? path.basename(file, ".json");
      if (typeof server !== "string" || !SERVER_KEY.test(server)) {
        throw new Error(`Decoy ${file}: server name must match ${SERVER_KEY}.`);
      }
      const clash = clientNames.get(codexServerName(server));
      if (clash !== undefined) {
        throw new Error(`Decoy ${file}: server ${server} collides with ${clash} in client tool names.`);
      }
      clientNames.set(codexServerName(server), server);
      if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) {
        throw new Error(`Decoy ${file}: no tools.`);
      }
      const toolNames = catalog.tools.map((tool) => tool.name);
      if (toolNames.some((name) => typeof name !== "string" || name === "")) {
        throw new Error(`Decoy ${file}: every tool needs a name.`);
      }
      for (const name of toolNames) {
        const clientName = `${codexServerName(server)}__${name}`;
        if (takenToolNames.has(clientName)) {
          throw new Error(`Decoy ${file}: tool ${name} collides with another client tool name (${clientName}).`);
        }
        takenToolNames.add(clientName);
      }
      return { file, server, catalog };
    });
  const servers = catalogs.map(({ server, catalog }, index) => {
    const served = {
      serverInfo: catalog.serverInfo ?? { name: server, version: "decoy" },
      ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
      tools: catalog.tools,
    };
    // The private directory name is generated, never taken from the catalogue.
    return { server, tools: catalog.tools, fixture: replay(served, `decoy-${index}`), served };
  });
  const writes = new Map();
  const aliases = new Map();
  const bareCount = new Map();
  for (const { tools } of servers) {
    for (const tool of tools) bareCount.set(tool.name, (bareCount.get(tool.name) ?? 0) + 1);
  }
  const codexNames = new Set();
  const wholeReplyAliases = new Map();
  const decoySurface = [];
  // Canonical client names first, for every decoy tool...
  for (const { server, tools } of servers) {
    for (const tool of tools) {
      const full = `mcp__${server}__${tool.name}`;
      const codex = `${codexServerName(server)}__${tool.name}`;
      writes.set(full, decoyToolWrites(tool));
      codexNames.add(codex);
      aliases.set(full, full);
      aliases.set(codex, full);
      aliases.set(`mcp__${codex}`, full);
      decoySurface.push({ ...tool, name: full, server, bareName: tool.name });
    }
  }
  // ...then bare names, only where the key is free: a bare `foo__send` must
  // not hide the client name of server foo's tool `send`. A bare one-word
  // name (`read`, `query`) is an ordinary word inside a reply; it counts only
  // as the whole reply (see wholeReplyAliases).
  for (const { server, tools } of servers) {
    for (const tool of tools) {
      const full = `mcp__${server}__${tool.name}`;
      const unique = bareCount.get(tool.name) === 1 && !fixtureNames.has(tool.name);
      if (!unique || aliases.has(tool.name)) continue;
      if (/[_-]/u.test(tool.name)) aliases.set(tool.name, full);
      wholeReplyAliases.set(tool.name, full);
    }
  }
  const isDecoy = (name) => writes.has(name);
  return {
    summary: servers.map(({ server, tools }) => ({
      server,
      tools: tools.length,
      writeTools: tools.filter(decoyToolWrites).length,
      writeBasis: tools.every((tool) => annotatedWrite(tool) !== undefined)
        ? "annotations"
        : tools.some((tool) => annotatedWrite(tool) !== undefined)
          ? "annotations, else name"
          : "name (presumed)",
      characters: JSON.stringify(tools).length,
    })),
    toolNames: new Set(writes.keys()),
    codexNames,
    aliases,
    wholeReplyAliases,
    rankingSurface: [
      ...fixtureTools.map((tool) => ({ ...tool, server: fixtureServer, bareName: tool.name })),
      ...decoySurface,
    ],
    launchesFor: (slot) => servers.map(({ server, fixture }) => ({ server, launch: fixture.launchFor(slot) })),
    refusedCallsFor: (slot) =>
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
