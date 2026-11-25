#!/usr/bin/env node
/**
 * Measures tool *discovery* by clients that defer MCP tool definitions:
 * Claude Code (tool names plus a keyword ToolSearch, reproduced model-free by
 * --client=claude-sim) and Codex code mode (the model filters ALL_TOOLS in its
 * own code cells). It records what the search or the code showed and which
 * tool the model names, never lets the model execute a fixture tool, and
 * counts any attempt. See evals/README.md, "Tool discovery".
 *
 * The server (default: this checkout's dist/) runs against an empty synthetic
 * vault, a loopback Local REST status fixture and private state per run. Run
 * artifacts are written outside the repository (--out).
 *
 *   node scripts/run-tool-discovery-eval.mjs --client=claude-sim
 *   node scripts/run-tool-discovery-eval.mjs --client=claude --runs=2 --out=<dir>
 *   node scripts/run-tool-discovery-eval.mjs --client=codex --runs=3 --out=<dir>
 *
 * --decoys=<dir> adds competing servers next to the fixture: every
 * <server>.json there ({serverName, tools, instructions?}) is served by its own
 * replay server, which refuses and logs every call like the fixture. Keep
 * captured third-party catalogues outside the repository.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  authenticatedStatusServer,
  isolatedEnv,
  measureToolsList,
  operatingSystemEnvironment,
} from "./measure-tool-profile-schemas.mjs";
import { loadDecoys } from "./tool-discovery-decoys.mjs";
import { CLAUDE_CODE_SEARCH_VERSION, rankToolsClaudeCode, searchHintOf } from "./tool-discovery-index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_NAME = "optimike-obsidian-mcp-stdio";
const DEFAULT_CORPUS = path.join(repoRoot, "evals", "tool-discovery-corpus.json");
const DEFAULT_SERVER = path.join(repoRoot, "dist", "index.js");
const REPLAY_SERVER = path.join(repoRoot, "scripts", "tool-discovery-replay-server.mjs");

function parseArgs(argv) {
  const args = {
    client: "claude-sim",
    runs: 1,
    concurrency: 4,
    profile: "operational",
    corpus: DEFAULT_CORPUS,
    out: undefined,
    cases: undefined,
    model: undefined,
    reasoning: undefined,
    server: DEFAULT_SERVER,
    decoys: undefined,
    context: "vault",
  };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/u, "").split(/=(.*)/su);
    if (key === "client") args.client = value;
    else if (key === "runs") args.runs = Number(value);
    else if (key === "concurrency") args.concurrency = Number(value);
    else if (key === "profile") args.profile = value;
    else if (key === "corpus") args.corpus = path.resolve(value);
    else if (key === "out") args.out = path.resolve(value);
    else if (key === "cases") args.cases = new Set(value.split(","));
    else if (key === "model") args.model = value;
    else if (key === "reasoning") args.reasoning = value;
    else if (key === "server") args.server = path.resolve(value);
    else if (key === "decoys") args.decoys = path.resolve(value);
    else if (key === "context") args.context = value;
    else throw new Error(`Unknown argument ${raw}`);
  }
  if (!["claude-sim", "claude", "codex"].includes(args.client)) {
    throw new Error("--client must be claude-sim, claude or codex.");
  }
  if (!["vault", "none"].includes(args.context)) {
    throw new Error("--context must be vault or none.");
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 5) {
    throw new Error("--runs must be an integer from 1 to 5.");
  }
  return args;
}

function loadDiscoveryCases(corpusPath = DEFAULT_CORPUS) {
  const bytes = readFileSync(corpusPath);
  const corpus = JSON.parse(bytes.toString("utf8"));
  const cases = [];
  for (const intent of corpus.intents) {
    for (const [language, request] of Object.entries(intent.requests)) {
      cases.push({
        id: `${intent.id}.${language}`,
        intent: intent.id,
        language,
        request,
        mode: "request",
        expected: intent.expectedTools,
        risky: intent.riskyTools ?? [],
      });
    }
    cases.push({
      id: `${intent.id}.query`,
      intent: intent.id,
      language: "query",
      request: intent.query,
      mode: "query",
      expected: intent.expectedTools,
      risky: intent.riskyTools ?? [],
    });
    for (const [index, query] of (intent.holdoutQueries ?? []).entries()) {
      cases.push({
        id: `${intent.id}.holdout-${index + 1}`,
        intent: intent.id,
        language: "holdout",
        request: query,
        mode: "holdout",
        expected: intent.expectedTools,
        risky: intent.riskyTools ?? [],
      });
    }
  }
  return {
    corpus,
    cases,
    corpusSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Captures the real server's catalogue (tools/list, instructions, server info)
 * once, against an empty synthetic vault, a loopback Local REST status fixture
 * and private state, then stops it. Measured clients never reach this server.
 */
async function captureCatalog(profile, serverEntry, privateRoot) {
  // The runtime only accepts a logs directory inside its own checkout (ignored).
  const logsParent = path.resolve(path.dirname(serverEntry), "..", "logs", "discovery-eval");
  mkdirSync(logsParent, { recursive: true });
  const logsRoot = mkdtempSync(path.join(logsParent, "run-"));
  const vault = path.join(privateRoot, "vault");
  mkdirSync(path.join(vault, "Assets"), { recursive: true });
  writeFileSync(
    path.join(vault, "Welcome.md"),
    "# Welcome\n\nSynthetic discovery fixture.\n",
    "utf8",
  );
  const sourceRoot = path.join(privateRoot, "inbox");
  mkdirSync(sourceRoot, { recursive: true });
  const rootsFile = path.join(privateRoot, "external-roots.json");
  writeFileSync(
    rootsFile,
    JSON.stringify({
      version: 1,
      roots: [
        {
          id: "fixture.inbox",
          path: sourceRoot,
          capabilities: ["visible", "readable", "handoff"],
          include: ["**/*.png"],
        },
      ],
    }),
    "utf8",
  );
  const state = path.join(privateRoot, "state");
  const statusServer = await authenticatedStatusServer();
  const env = {
    ...isolatedEnv(
      {
        ...operatingSystemEnvironment(),
        OBSIDIAN_RUNTIME_MODE: "live",
        OBSIDIAN_VAULT: vault,
        OBSIDIAN_API_KEY: "discovery-fixture-only",
        OBSIDIAN_BASE_URL: statusServer.baseUrl,
        OBSIDIAN_STARTUP_MAX_RETRIES: "1",
        OBSIDIAN_STARTUP_RETRY_DELAY_MS: "1",
        OBSIDIAN_STARTUP_BLOCKING: "true",
        OBSIDIAN_ENABLE_CACHE: "true",
        MCP_ASSET_IMPORT_ENABLED: "true",
        MCP_ASSET_FOLDER: "Assets",
        MCP_EXTERNAL_ROOTS_FILE: rootsFile,
      },
      state,
      logsRoot,
      profile,
    ),
    LOCALAPPDATA: path.join(state, "local-app-data"),
    XDG_STATE_HOME: path.join(state, "xdg-state"),
  };
  // cwd is private: the runtime loads a .env from its working directory.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, "--tool-profile", profile],
    cwd: privateRoot,
    env,
  });
  const client = new Client({ name: "optimike-discovery-eval", version: "1" });
  try {
    await client.connect(transport);
    return {
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    };
  } finally {
    await client.close().catch(() => undefined);
    await statusServer.close();
    rmSync(logsRoot, { recursive: true, force: true });
  }
}

/**
 * Measured clients connect to the catalogue-only replay server: it serves the
 * captured surface and refuses and logs every tools/call before dispatch.
 */
function replayFixture(catalog, privateRoot) {
  mkdirSync(privateRoot, { recursive: true });
  const catalogPath = path.join(privateRoot, "catalog.json");
  const callsDir = path.join(privateRoot, "calls");
  mkdirSync(callsDir, { recursive: true });
  writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
  const callsPath = (slot) => path.join(callsDir, `${slot}.jsonl`);
  return {
    launchFor: (slot) => ({
      command: process.execPath,
      args: [REPLAY_SERVER, catalogPath, callsPath(slot)],
      env: operatingSystemEnvironment(),
    }),
    refusedCalls: (slot) => {
      let text = "";
      try {
        text = readFileSync(callsPath(slot), "utf8");
      } catch {
        return [];
      }
      return text
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line).name);
    },
  };
}

/** Model-free preflight: the replay serves the exact surface and refuses calls. */
async function verifyReplay(fixture, expectedSha256) {
  const launch = fixture.launchFor("preflight");
  const client = new Client({ name: "optimike-discovery-preflight", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ ...launch, cwd: os.tmpdir() }));
    const tools = (await client.listTools()).tools;
    const served = measureToolsList(tools).toolsListSha256;
    const probe = tools[0].name;
    const result = await client.callTool({ name: probe, arguments: {} });
    const refused = result.isError === true && fixture.refusedCalls("preflight").includes(probe);
    if (served !== expectedSha256 || !refused) {
      throw new Error(
        `Replay preflight failed: surface ${served === expectedSha256 ? "matches" : "differs"}, call ${refused ? "refused" : "not refused"}.`,
      );
    }
    return { servedToolsListSha256: served, callRefused: true };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Identity of the measured build, separate from the harness checkout. */
function serverIdentity(serverEntry) {
  const root = path.resolve(path.dirname(serverEntry), "..");
  const newest = (directory) => {
    let latest = 0;
    const stack = [directory];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else latest = Math.max(latest, statSync(full).mtimeMs);
      }
    }
    return latest;
  };
  if (newest(path.join(root, "src")) > newest(path.dirname(serverEntry))) {
    throw new Error(`${serverEntry} is older than its src/: run npm run build first.`);
  }
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return {
    entry: path.relative(repoRoot, serverEntry).replaceAll(path.sep, "/"),
    commit: git(["rev-parse", "HEAD"]),
    dirtyWorktree: git(["status", "--porcelain"]) !== "",
  };
}

function toolsListCharacters(tools) {
  let descriptions = 0;
  let schemas = 0;
  let names = 0;
  let searchHints = 0;
  for (const tool of tools) {
    descriptions += tool.description?.length ?? 0;
    schemas += JSON.stringify(tool.inputSchema ?? {}).length;
    names += tool.name.length;
    searchHints += searchHintOf(tool)?.length ?? 0;
  }
  return {
    total: JSON.stringify(tools).length,
    descriptions,
    schemas,
    names,
    searchHints,
    toolsWithSearchHint: tools.filter((tool) => searchHintOf(tool) !== undefined).length,
  };
}

// ---------------------------------------------------------------------------
// Client runners

function childEnvironment() {
  // Do not leak the parent agent session (nested-session markers, messaging
  // sockets/tokens) into the measured client.
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name === "CLAUDECODE" ||
      name.startsWith("CLAUDE_CODE_") ||
      name === "CLAUDE_PID" ||
      name === "CLAUDE_EFFORT" ||
      name === "CLAUDE_AGENT_SDK_VERSION" ||
      name.startsWith("CODEX_THREAD") ||
      name === "CODEX_SANDBOX"
    ) {
      delete env[name];
    }
  }
  return env;
}

function runProcess(command, args, { cwd, input, env, timeoutMs = 240_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      // Only the PID this harness started.
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // A spawn error ends the run as a failure (code -1), like a nonzero exit.
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

// With competing servers the prompt no longer says that the only server is the
// vault: the client must tell the vault apart from the other servers.
// --context=none drops the vault from the prompt, like a client without
// instructions about where the user's notes and tasks live.
function connectionSentence(competing, context = "vault") {
  if (context === "none") return "You are connected to several MCP servers.";
  return competing
    ? "You are connected to several MCP servers; one of them gives access to the user's Obsidian vault."
    : "You are connected to a user's Obsidian vault through an MCP server.";
}

function discoveryPrompt(testCase, competing = false, context = "vault") {
  if (testCase.mode !== "request") {
    return [
      "Call your tool search tool exactly once, with exactly this query string and nothing added:",
      "",
      testCase.request,
      "",
      "Do not call any other tool. Then reply with only the name of the first tool it returned.",
    ].join("\n");
  }
  const request = testCase.request;
  return [
    connectionSentence(competing, context),
    "The user asks:",
    "",
    `> ${request}`,
    "",
    "Use your tool search to find the single most appropriate tool for this request.",
    "Do not call any tool other than tool search, and do not perform the request.",
    "Search at most twice. Then reply with only the name of the tool you would use.",
  ].join("\n");
}

function stripServerPrefix(name) {
  if (typeof name !== "string") return name;
  const claudePrefix = `mcp__${SERVER_NAME}__`;
  if (name.startsWith(claudePrefix)) return name.slice(claudePrefix.length);
  const codexPrefix = `${SERVER_NAME}__`;
  if (name.startsWith(codexPrefix)) return name.slice(codexPrefix.length);
  const dotted = `${SERVER_NAME}.`;
  if (name.startsWith(dotted)) return name.slice(dotted.length);
  return name;
}

function claudeSearchResults(content) {
  const blocks = Array.isArray(content) ? content : [content];
  const names = [];
  for (const block of blocks) {
    if (block?.type === "tool_reference") names.push(block.tool_name);
    else if (typeof block?.text === "string" || typeof block === "string") {
      const text = typeof block === "string" ? block : block.text;
      for (const match of text.matchAll(/mcp__[\w-]+__\w+/gu)) {
        names.push(match[0]);
      }
    }
  }
  return names.map(stripServerPrefix);
}

async function runClaudeCase(testCase, launch, configPath, options) {
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          type: "stdio",
          command: launch.command,
          args: launch.args,
          env: launch.env,
        },
        ...Object.fromEntries(
          (options.decoyLaunches ?? []).map(({ server, launch: decoy }) => [
            server,
            { type: "stdio", command: decoy.command, args: decoy.args, env: decoy.env },
          ]),
        ),
      },
    }),
    "utf8",
  );
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
    "--setting-sources",
    "",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "ToolSearch",
    "--max-turns",
    "6",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.reasoning) args.push("--effort", options.reasoning);
  // Blocking MCP connect: the first turn starts once the fixture is connected,
  // as in an interactive session where the server is already up.
  const env = {
    ...childEnvironment(),
    ENABLE_TOOL_SEARCH: "true",
    MCP_CONNECTION_NONBLOCKING: "false",
  };
  const started = Date.now();
  const result = await runProcess(claudeCommand(), args, {
    cwd: path.dirname(configPath),
    input: discoveryPrompt(testCase, Boolean(options.decoyLaunches?.length), options.context),
    env,
  });
  const searches = [];
  const otherCalls = [];
  const pending = new Map();
  let finalText = "";
  let model;
  let mcpStatus;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") {
      model = event.model;
      mcpStatus = event.mcp_servers?.find((server) => server.name === SERVER_NAME)?.status;
      const decoyServers = new Set((options.decoyLaunches ?? []).map(({ server }) => server));
      const decoysDown = (event.mcp_servers ?? []).filter(
        (server) => decoyServers.has(server.name) && server.status !== "connected",
      );
      if (mcpStatus === "connected" && decoysDown.length) {
        mcpStatus = `decoy ${decoysDown.map((server) => server.name).join(",")} not connected`;
      }
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) {
      if (event.type === "result" && typeof event.result === "string") {
        finalText = event.result;
      }
      continue;
    }
    for (const block of content) {
      if (event.type === "assistant" && block.type === "tool_use") {
        if (block.name === "ToolSearch") {
          const search = {
            query: block.input?.query ?? null,
            maxResults: block.input?.max_results ?? 5,
            results: null,
          };
          pending.set(block.id, search);
          searches.push(search);
        } else {
          otherCalls.push(stripServerPrefix(block.name));
        }
      } else if (event.type === "user" && block.type === "tool_result") {
        const search = pending.get(block.tool_use_id);
        if (search) search.results = claudeSearchResults(block.content);
      }
    }
    if (event.type === "result" && typeof event.result === "string") {
      finalText = event.result;
    }
  }
  return {
    exitCode: result.code,
    model,
    searches,
    otherCalls,
    mcpStatus,
    finalText: finalText.slice(0, 400),
    finalAnswer: namedTool(finalText, options.knownTools, options.decoyAliases),
    latencyMs: Date.now() - started,
    stderrTail: result.code === 0 ? undefined : result.stderr.slice(-600),
  };
}

/** First fixture tool named in a final reply, else the reply's last word. */
function namedTool(text, knownTools, aliases = new Map()) {
  for (const match of String(text).matchAll(/[A-Za-z][\w-]*/gu)) {
    const name = codexToolName(stripServerPrefix(match[0]));
    if (knownTools.has(name)) return name;
    if (aliases.has(name)) return aliases.get(name);
  }
  return String(text).trim().split(/\s+/u).pop() ?? "";
}

function claudeCommand() {
  if (process.platform !== "win32") return "claude";
  return execFileSync("where.exe", ["claude"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().endsWith(".exe"));
}

// ---------------------------------------------------------------------------

function scoreCase(testCase, ranked, decoys) {
  const top = ranked.slice(0, 3);
  return {
    ...(decoys ? decoys.rankingScore(testCase, ranked) : {}),
    top1: top[0] !== undefined && testCase.expected.includes(top[0]),
    top3: top.some((name) => testCase.expected.includes(name)),
    riskyAboveExpected: (() => {
      const firstExpected = ranked.findIndex((n) => testCase.expected.includes(n));
      const firstRisky = ranked.findIndex((n) => testCase.risky.includes(n));
      return (
        firstRisky !== -1 &&
        firstRisky < 3 &&
        (firstExpected === -1 || firstRisky < firstExpected)
      );
    })(),
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

/**
 * True when the real ToolSearch result equals the reproduction, ignoring
 * client built-in deferred tools (their text is not on this server's surface):
 * the real server tools must be the reproduction's prefix, and the whole
 * reproduction when the real result holds no built-in tool.
 */
function simulationAgrees(real, simulated, known) {
  const realServerTools = real.filter((name) => known.has(name));
  return (
    realServerTools.every((name, index) => simulated[index] === name) &&
    (realServerTools.length < real.length || realServerTools.length === simulated.length)
  );
}

function summarize(rows) {
  const byLanguage = {};
  for (const language of ["query", "en", "fr", "holdout"]) {
    const subset = rows.filter((row) => row.caseId.split(".")[1].startsWith(language));
    if (subset.length) byLanguage[language] = summarizeRows(subset);
  }
  return { ...summarizeRows(rows), byLanguage };
}

function summarizeRows(allRows) {
  // A run whose fixture never connected measured the client alone: it counts
  // as a harness failure, not as a discovery miss.
  const unavailable = allRows.filter(
    (row) => row.mcpStatus !== undefined && row.mcpStatus !== "connected",
  );
  const deviated = allRows.filter((row) => row.queryDeviated);
  const rows = allRows.filter(
    (row) => !unavailable.includes(row) && !row.error && !row.queryDeviated,
  );
  const total = rows.length;
  const count = (key) => rows.filter((row) => row.score?.[key]).length;
  const checked = rows.flatMap((row) =>
    (row.searches ?? []).filter((search) => typeof search.simulationAgrees === "boolean"),
  );
  return {
    ...(checked.length
      ? {
          simulationChecks: checked.length,
          simulationAgreements: checked.filter((search) => search.simulationAgrees).length,
        }
      : {}),
    cases: total,
    top1: count("top1"),
    top3: count("top3"),
    riskyAboveExpected: count("riskyAboveExpected"),
    finalCorrect: rows.filter((row) => row.finalCorrect).length,
    ...(rows.some((row) => "expectedShown" in row)
      ? {
          expectedShown: rows.filter((row) => row.expectedShown).length,
          riskyShown: rows.filter((row) => row.riskyShown?.length).length,
        }
      : {}),
    ...(rows.some((row) => row.score && "foreignFirst" in row.score)
      ? {
          foreignFirst: count("foreignFirst"),
          foreignWriteFirst: count("foreignWriteFirst"),
          foreignWriteAboveExpected: count("foreignWriteAboveExpected"),
        }
      : {}),
    ...(rows.some((row) => "finalForeign" in row)
      ? {
          finalForeign: rows.filter((row) => row.finalForeign).length,
          finalForeignWrite: rows.filter((row) => row.finalForeignWrite).length,
        }
      : {}),
    otherToolCalls: rows.filter((row) => row.otherCalls?.length).length,
    failedRuns: allRows.filter((row) => row.error).length,
    fixtureUnavailableRuns: unavailable.length,
    queryDeviations: deviated.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { cases: allCases, corpusSha256 } = loadDiscoveryCases(options.corpus);
  const cases = options.cases
    ? allCases.filter((item) => options.cases.has(item.id) || options.cases.has(item.intent))
    : allCases;
  const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const harnessDirty =
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim() !==
    "";
  const server = serverIdentity(options.server);
  const privateRoot = mkdtempSync(path.join(os.tmpdir(), "optimike-discovery-"));
  try {
    const catalog = await captureCatalog(options.profile, options.server, privateRoot);
    const tools = catalog.tools;
    const fixture = replayFixture(catalog, privateRoot);
    const surface = {
      profile: options.profile,
      ...measureToolsList(tools),
      characters: toolsListCharacters(tools),
    };
    delete surface.toolNames;
    const fixtureKnown = new Set(tools.map((tool) => tool.name));
    const decoys = options.decoys
      ? loadDecoys(options.decoys, {
          fixtureServer: SERVER_NAME,
          fixtureTools: tools,
          replay: (catalog, server) =>
            replayFixture(catalog, path.join(privateRoot, "decoys", server)),
        })
      : undefined;
    const known = decoys ? new Set([...fixtureKnown, ...decoys.toolNames]) : fixtureKnown;
    const rankedSurface = decoys ? decoys.rankingSurface : tools;
    const simulate = (query, maxResults = 5) =>
      rankToolsClaudeCode(rankedSurface, query, { serverName: SERVER_NAME, maxResults }).map(
        (item) => item.name,
      );
    const decoyLaunches = (slot) => decoys?.launchesFor(slot) ?? [];
    const decoyRefusals = (slot) => decoys?.refusedCalls(slot) ?? [];
    const withFinal = (testCase, finalAnswer) =>
      decoys ? decoys.finalScore(testCase, finalAnswer) : {};
    for (const testCase of cases) {
      for (const name of [...testCase.expected, ...testCase.risky]) {
        if (!fixtureKnown.has(name)) {
          throw new Error(`${testCase.id}: ${name} is not exposed by ${options.profile}.`);
        }
      }
    }
    const header = {
      schemaVersion: "tool-discovery-run/v1",
      client: options.client,
      harness: { commit: harnessCommit, dirtyWorktree: harnessDirty },
      server,
      corpusSha256,
      surface,
      runs: options.runs,
      model: options.model ?? "client-default",
      ...(options.client.startsWith("claude")
        ? { claudeCodeSearchReproduction: CLAUDE_CODE_SEARCH_VERSION }
        : {}),
      reasoning: options.reasoning ?? "client-default",
      promptContext: options.context,
      ...(decoys ? { decoys: decoys.summary } : {}),
      startedAt: new Date().toISOString(),
    };
    if (options.client !== "claude-sim") {
      header.replay = await verifyReplay(fixture, surface.toolsListSha256);
      if (decoys) header.decoyReplay = await decoys.verify(verifyReplay);
    }
    let rows;
    if (options.client === "claude-sim") {
      rows = cases.map((testCase) => {
        const ranked = simulate(testCase.request);
        return {
          caseId: testCase.id,
          runIndex: 0,
          ranked: ranked.slice(0, 5),
          score: scoreCase(testCase, ranked, decoys),
        };
      });
    } else if (options.client === "codex") {
      // Code mode has no search tool to feed a keyword query: only user requests run.
      const requestCases = cases.filter((testCase) => testCase.mode === "request");
      const workDir = mkdtempSync(path.join(os.tmpdir(), "optimike-discovery-client-"));
      try {
        header.codexIsolation = await assertCodexIsolation(
          fixture.launchFor("isolation"),
          workDir,
          {
            ...options,
            decoyLaunches: decoyLaunches("isolation"),
            decoyCodexNames: decoys?.codexNames,
          },
          fixtureKnown,
        );
        process.stderr.write(`codex isolation: ${JSON.stringify(header.codexIsolation)}\n`);
        const jobs = [];
        for (let runIndex = 0; runIndex < options.runs; runIndex++) {
          for (const testCase of requestCases) jobs.push({ testCase, runIndex });
        }
        rows = await mapLimit(jobs, options.concurrency, async ({ testCase, runIndex }, slot) => {
          try {
            const run = await runCodexCase(
              testCase,
              fixture.launchFor(slot),
              workDir,
              { ...options, decoyLaunches: decoyLaunches(slot), decoyAliases: decoys?.aliases },
              fixtureKnown,
            );
            run.otherCalls.push(...fixture.refusedCalls(slot), ...decoyRefusals(slot));
            const failure =
              run.exitCode !== 0
                ? `codex exited with ${run.exitCode}`
                : run.rolloutFound
                  ? undefined
                  : "codex session record missing";
            if (failure) return { caseId: testCase.id, runIndex, ...run, error: failure };
            process.stderr.write(
              `${testCase.id}#${runIndex}: ${run.cells.length} cell(s), ${run.shownTools.length} shown -> ${run.finalAnswer}\n`,
            );
            return {
              caseId: testCase.id,
              runIndex,
              ...run,
              expectedShown: run.shownTools.some((name) => testCase.expected.includes(name)),
              riskyShown: run.shownTools.filter((name) => testCase.risky.includes(name)),
              finalCorrect: testCase.expected.includes(run.finalAnswer),
              ...withFinal(testCase, run.finalAnswer),
            };
          } catch (error) {
            return { caseId: testCase.id, runIndex, error: String(error?.message ?? error) };
          }
        });
      } catch (error) {
        if (error?.evidence) process.stderr.write(`${JSON.stringify(error.evidence)}\n`);
        throw error;
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    } else {
      const workDir = mkdtempSync(path.join(os.tmpdir(), "optimike-discovery-client-"));
      const jobs = [];
      for (let runIndex = 0; runIndex < options.runs; runIndex++) {
        // Held-out keyword queries are scored offline: the reproduction is
        // checked exact against the real client on every keyword search.
        for (const testCase of cases) {
          if (testCase.mode !== "holdout" || options.cases) jobs.push({ testCase, runIndex });
        }
      }
      try {
        rows = await mapLimit(jobs, options.concurrency, async ({ testCase, runIndex }, slot) => {
          try {
            const configPath = path.join(workDir, `claude-mcp-${slot}.json`);
            const run = await runClaudeCase(testCase, fixture.launchFor(slot), configPath, {
              ...options,
              knownTools: known,
              decoyLaunches: decoyLaunches(slot),
              decoyAliases: decoys?.aliases,
            });
            run.otherCalls.push(...fixture.refusedCalls(slot), ...decoyRefusals(slot));
            const failure =
              run.exitCode !== 0
                ? `claude exited with ${run.exitCode}`
                : run.model
                  ? undefined
                  : "claude init event missing";
            if (failure) return { caseId: testCase.id, runIndex, ...run, error: failure };
            // A keyword case measures one verbatim query; a rewritten or
            // repeated search measures the model instead and is reported apart.
            const queryDeviated =
              testCase.mode !== "request" &&
              !(
                run.searches.length === 1 &&
                run.searches[0].query?.trim() === testCase.request.trim() &&
                run.searches[0].results
              );
            for (const search of run.searches) {
              if (typeof search.query !== "string" || !search.results) continue;
              if (/^select:/iu.test(search.query.trim())) continue;
              search.simulated = simulate(search.query, search.maxResults);
              search.simulationAgrees = simulationAgrees(search.results, search.simulated, known);
            }
            const first = run.searches.find((search) => search.results) ?? null;
            const ranked = first?.results ?? [];
            const anyFound = run.searches.some((search) =>
              (search.results ?? []).slice(0, 3).some((n) => testCase.expected.includes(n)),
            );
            process.stderr.write(
              `${testCase.id}#${runIndex}: ${ranked.slice(0, 3).join(", ") || "(no search)"} -> ${run.finalAnswer}\n`,
            );
            return {
              caseId: testCase.id,
              runIndex,
              ...run,
              ranked: ranked.slice(0, 5),
              score: first ? scoreCase(testCase, ranked, decoys) : null,
              ...(queryDeviated ? { queryDeviated } : {}),
              anySearchTop3: anyFound,
              finalCorrect: testCase.expected.includes(run.finalAnswer),
              ...withFinal(testCase, run.finalAnswer),
            };
          } catch (error) {
            return { caseId: testCase.id, runIndex, error: String(error?.message ?? error) };
          }
        });
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
    const report = { ...header, summary: summarize(rows), rows };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) {
      mkdirSync(options.out, { recursive: true });
      const file = path.join(
        options.out,
        `${options.client}-${server.commit.slice(0, 12)}${server.dirtyWorktree ? "-dirty" : ""}-${Date.now()}.json`,
      );
      writeFileSync(file, json, "utf8");
      process.stderr.write(`wrote ${file}\n`);
    }
    process.stdout.write(`${JSON.stringify({ ...header, summary: report.summary }, null, 2)}\n`);
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

function codexInvocation() {
  if (process.platform !== "win32") return { command: "codex", prefixArgs: [] };
  const shim = execFileSync("where.exe", ["codex.cmd"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find(Boolean);
  const entrypoint = path.join(
    path.dirname(shim),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  return { command: process.execPath, prefixArgs: [entrypoint] };
}

function tomlInlineTable(record) {
  return `{${Object.entries(record)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

// Codex 0.160 runs its models in code mode: the model gets one `exec` tool
// (JavaScript) and finds tools by filtering ALL_TOOLS itself. There is no
// client search ranking to record, so the harness records the model's own
// code cells, what they printed and the tool it finally names.
//
// Isolation: user config, ChatGPT apps, plugins and user skills are off, so the
// only MCP server is the synthetic fixture. assertCodexIsolation() proves it
// from the session record before any case runs.
const CODEX_ISOLATION_ARGS = [
  "--ignore-user-config",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "remote_plugin",
  "--disable",
  "skill_search",
  "--enable",
  "skip_host_skill_discovery",
  "-c",
  "skills.include_instructions=false",
  "-c",
  "cloud.skills.enabled=false",
  "-c",
  "include_apps_instructions=false",
  "-c",
  "suppress_unstable_features_warning=true",
];

// Built-in Codex tools observed in an isolated session. The three MCP resource
// helpers appear once any MCP server is configured; here that is the fixture.
const CODEX_BUILTIN_TOOLS = new Set([
  "apply_patch",
  "clock__curr_time",
  "create_goal",
  "exec_command",
  "get_goal",
  "image_gen__imagegen",
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "read_mcp_resource",
  "update_goal",
  "view_image",
  "web__run",
  "write_stdin",
]);

const CODEX_FIXTURE_PREFIX = `${SERVER_NAME.replace(/[^A-Za-z0-9]/gu, "_")}__`;

function codexToolName(name) {
  if (typeof name !== "string") return name;
  for (const prefix of [CODEX_FIXTURE_PREFIX, `mcp__${CODEX_FIXTURE_PREFIX}`]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return stripServerPrefix(name);
}

function findCodexRollout(threadId) {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) return full;
    }
  }
  return undefined;
}

/** Reads this harness's own session record, then deletes it. */
function consumeCodexRollout(threadId) {
  const file = threadId ? findCodexRollout(threadId) : undefined;
  if (!file) return { cells: [], otherCalls: [], rolloutFound: false };
  const cells = [];
  const otherCalls = [];
  const byCall = new Map();
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const item = record.payload;
      if (record.type !== "response_item" || !item) continue;
      if (item.type === "custom_tool_call" && item.name === "exec") {
        const cell = { code: item.input ?? "", output: "" };
        byCall.set(item.call_id, cell);
        cells.push(cell);
      } else if (item.type === "custom_tool_call_output" && byCall.has(item.call_id)) {
        const parts = Array.isArray(item.output) ? item.output : [item.output];
        byCall.get(item.call_id).output = parts
          .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
          .join("\n");
      } else if (item.type === "function_call" || item.type === "custom_tool_call") {
        otherCalls.push(codexToolName(item.name));
      }
    }
  } finally {
    rmSync(file, { force: true });
  }
  return { cells, otherCalls, rolloutFound: true };
}

function codexArgs(launch, workDir, options) {
  const { prefixArgs } = codexInvocation();
  const prefix = `mcp_servers.${SERVER_NAME}`;
  const args = [
    ...prefixArgs,
    "exec",
    "--json",
    ...CODEX_ISOLATION_ARGS,
    "--skip-git-repo-check",
    "-C",
    workDir,
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    `${prefix}.command=${JSON.stringify(launch.command)}`,
    "-c",
    `${prefix}.args=${JSON.stringify(launch.args)}`,
    "-c",
    `${prefix}.env=${tomlInlineTable(launch.env)}`,
    "-c",
    `${prefix}.startup_timeout_sec=60`,
    // Required servers are awaited before the first turn; otherwise the
    // fixture's tools can be missing from ALL_TOOLS while it starts.
    "-c",
    `${prefix}.required=true`,
  ];
  for (const { server, launch: decoy } of options.decoyLaunches ?? []) {
    const key = `mcp_servers.${JSON.stringify(server)}`;
    args.push(
      "-c",
      `${key}.command=${JSON.stringify(decoy.command)}`,
      "-c",
      `${key}.args=${JSON.stringify(decoy.args)}`,
      "-c",
      `${key}.env=${tomlInlineTable(decoy.env)}`,
      "-c",
      `${key}.startup_timeout_sec=60`,
      "-c",
      `${key}.required=true`,
    );
  }
  if (options.model) args.push("-m", options.model);
  if (options.reasoning) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(options.reasoning)}`);
  }
  args.push("-");
  return args;
}

async function runCodex(prompt, launch, workDir, options) {
  const started = Date.now();
  const result = await runProcess(codexInvocation().command, codexArgs(launch, workDir, options), {
    cwd: workDir,
    input: prompt,
    env: childEnvironment(),
  });
  let threadId;
  let finalText = "";
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      finalText = event.item.text ?? finalText;
    }
  }
  return {
    exitCode: result.code,
    threadId,
    finalText,
    ...consumeCodexRollout(threadId),
    latencyMs: Date.now() - started,
    stderrTail: result.code === 0 ? undefined : result.stderr.slice(-600),
  };
}

const CODEX_ISOLATION_PROMPT = [
  "In one code cell, print JSON of the name of every entry in ALL_TOOLS.",
  "Do not call any of those tools. Then reply DONE.",
].join(" ");

/**
 * Refuses to measure unless the code-mode tool registry holds only Codex
 * built-ins and the fixture's tools. The evidence is the cell's own output in
 * the session record, not the model's reply.
 */
async function assertCodexIsolation(launch, workDir, options, fixtureTools) {
  const run = await runCodex(CODEX_ISOLATION_PROMPT, launch, workDir, options);
  const printed = run.cells.map((cell) => cell.output).join("\n");
  const match = printed.match(/\[[\s\S]*\]/u);
  if (!match) {
    throw Object.assign(new Error("Codex isolation check: no ALL_TOOLS listing in the session record."), {
      evidence: { rolloutFound: run.rolloutFound, cells: run.cells.length, exitCode: run.exitCode },
    });
  }
  const names = JSON.parse(match[0]);
  const fixtureNames = names.filter((name) => fixtureTools.has(codexToolName(name)));
  const decoyNames = options.decoyCodexNames ?? new Set();
  const isDecoy = (name) => decoyNames.has(name.replace(/^mcp__/u, ""));
  const decoysShown = names.filter(isDecoy);
  const foreign = names.filter(
    (name) =>
      !CODEX_BUILTIN_TOOLS.has(name) && !fixtureTools.has(codexToolName(name)) && !isDecoy(name),
  );
  const evidence = {
    visibleTools: names.length,
    fixtureTools: fixtureNames.length,
    builtinTools: names.filter((name) => CODEX_BUILTIN_TOOLS.has(name)),
    foreignTools: foreign,
    ...(decoyNames.size ? { decoyTools: decoysShown.length } : {}),
    fixtureNameSample: fixtureNames.slice(0, 3),
    nestedToolCalls: run.otherCalls,
  };
  if (
    foreign.length > 0 ||
    fixtureNames.length !== fixtureTools.size ||
    decoysShown.length !== decoyNames.size ||
    run.otherCalls.length > 0
  ) {
    throw Object.assign(new Error("Codex isolation check failed."), { evidence });
  }
  return evidence;
}

function codexPrompt(testCase, competing = false, context = "vault") {
  return [
    connectionSentence(competing, context),
    "The user asks:",
    "",
    `> ${testCase.request}`,
    "",
    "Find the single most appropriate tool for this request by inspecting ALL_TOOLS",
    "in code cells. Do not call any tool from ALL_TOOLS and do not perform the request.",
    "Then reply with only the tool name.",
  ].join("\n");
}

/**
 * Fixture tools whose ALL_TOOLS entry the model's own code cells printed, in
 * order. Only namespaced entry names count, not bare names quoted inside a
 * printed description.
 */
function codexShownTools(cells, fixtureTools) {
  const shown = [];
  for (const cell of cells) {
    for (const match of cell.output.matchAll(/(?:mcp__)?[A-Za-z][\w-]*/gu)) {
      if (!match[0].replace(/^mcp__/u, "").startsWith(CODEX_FIXTURE_PREFIX)) continue;
      const name = codexToolName(match[0]);
      if (fixtureTools.has(name) && !shown.includes(name)) shown.push(name);
    }
  }
  return shown;
}

/** Tool calls written in code cells: `tools.<name>(` or `tools["<name>"](`. */
function codexCellToolCalls(cells) {
  const calls = [];
  for (const cell of cells) {
    for (const match of cell.code.matchAll(
      /\btools\s*(?:\.\s*([\w$]+)|\[\s*["'`]([^"'`]+)["'`]\s*\])\s*\(/gu,
    )) {
      calls.push(codexToolName(match[1] ?? match[2]));
    }
  }
  return calls;
}

async function runCodexCase(testCase, launch, workDir, options, fixtureTools) {
  const competing = Boolean(options.decoyLaunches?.length);
  const run = await runCodex(
    codexPrompt(testCase, competing, options.context),
    launch,
    workDir,
    options,
  );
  return {
    exitCode: run.exitCode,
    model: options.model ?? "codex-default",
    rolloutFound: run.rolloutFound,
    cells: run.cells.map((cell) => ({ code: cell.code, outputChars: cell.output.length })),
    shownTools: codexShownTools(run.cells, fixtureTools),
    otherCalls: [...run.otherCalls, ...codexCellToolCalls(run.cells)],
    finalText: run.finalText.slice(0, 400),
    finalAnswer: namedTool(run.finalText, fixtureTools, options.decoyAliases),
    latencyMs: run.latencyMs,
    stderrTail: run.stderrTail,
  };
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  await main();
}
