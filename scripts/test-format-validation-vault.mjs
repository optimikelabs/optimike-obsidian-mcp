#!/usr/bin/env node
// obsidian_validate_format merges the Atomic Write Bridge /notes/inspect
// findings into its static Markdown result, and keeps the static result,
// marked "not checked against the vault", when the Bridge cannot answer.
// The Bridge is a loopback HTTP fixture; the REST client, transport error
// mapping and merge run for real.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const tempParent = path.join(process.cwd(), ".tmp");
await mkdir(tempParent, { recursive: true });
const root = await mkdtemp(path.join(tempParent, "format-vault-"));

const requests = [];
let reply = () => ({ status: 404, body: { error: { reasonCode: "not_found" } } });
const sockets = new Set();
const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : undefined });
    const { status, body } = reply(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OBSIDIAN_API_KEY = "format-vault-fixture";
process.env.OBSIDIAN_VERIFY_SSL = "false";
process.env.OBSIDIAN_ENABLE_CACHE = "false";
process.env.OBSIDIAN_VAULT = root;
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = path.join(root, "cache.sqlite");
process.env.LOGS_DIR = path.join(root, "logs");
await mkdir(process.env.LOGS_DIR, { recursive: true });
process.env.MCP_LOG_LEVEL = "error";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { ObsidianRestApiService } = await import("../dist/services/obsidianRestAPI/service.js");
const { validateObsidianMarkdown } = await import("../dist/services/obsidianFormatService.js");
const { checkMarkdownAgainstVault } = await import("../dist/services/vaultFormatCheck.js");

const context = { requestId: "format-vault", timestamp: new Date(0).toISOString(), operation: "formatVault" };
const rest = new ObsidianRestApiService();
const content = "---\ncréation: pas une date\ntags: 5\n---\n[[AGENTS#Nope]]\n> [!recipe] Theme callout\n> [!recipy] Typo\n";
const staticResult = validateObsidianMarkdown(content);
assert.ok(staticResult.warnings.some((issue) => issue.code === "unknown-callout"), "fixture needs a static callout warning");
assert.ok(staticResult.warnings.some((issue) => issue.code === "frontmatter-tags-shape"), "fixture needs a non-callout static warning");
assert.equal(staticResult.ok, true);

const inspectResponse = {
  ok: true,
  contractVersion: 1,
  path: "Inbox/Draft.md",
  bindingFingerprint: "a".repeat(64),
  baseline: "current_file",
  findings: [
    { code: "link-heading-missing", severity: "error", location: "body", line: 4, target: "AGENTS#Nope" },
    { code: "property-type-mismatch", severity: "error", location: "frontmatter", line: 2, target: "création", declaredType: "datetime" },
    { code: "unknown-callout", severity: "warning", location: "body", line: 6, target: "recipy", suggestions: ["recipe"] },
    { code: "future-check", severity: "error", location: "body", line: 1, target: "x" },
  ],
  coverage: {
    references: { checked: 1, truncated: false },
    findings: { total: 4, returned: 4, truncated: false },
    callouts: { source: "stylesheets", partialSelectors: false },
    properties: { source: "metadataTypeManager" },
  },
};

try {
  // Merge: vault findings join the static ones; the fixed-list callout warning
  // is replaced by the vault-aware one, so the theme callout is not flagged.
  reply = (request) =>
    request.url === "/extensions/obsidian-atomic-write-bridge/notes/inspect"
      ? { status: 200, body: inspectResponse }
      : { status: 404, body: {} };
  const merged = await checkMarkdownAgainstVault(
    staticResult,
    { content, filePath: "Inbox\\Draft.md", source: "content" },
    rest,
    context,
  );
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    url: "/extensions/obsidian-atomic-write-bridge/notes/inspect",
    body: { contractVersion: 1, path: "Inbox/Draft.md", content, baseline: "current_file" },
  });
  assert.equal(merged.ok, false);
  assert.deepEqual(merged.vaultCheck, { status: "checked", baseline: "current_file", propertyTypes: "metadataTypeManager" });
  assert.deepEqual(merged.errors.map((issue) => issue.code), ["link-heading-missing", "property-type-mismatch"]);
  assert.deepEqual(merged.errors[1], {
    severity: "error",
    code: "property-type-mismatch",
    message: "Property value does not fit the type declared in the vault.",
    path: "frontmatter",
    line: 2,
    target: "création",
    declaredType: "datetime",
  });
  assert.deepEqual(merged.warnings.map((issue) => `${issue.code}:${issue.target ?? ""}`), ["frontmatter-tags-shape:", "unknown-callout:recipy"]);
  assert.deepEqual(merged.warnings[1].suggestions, ["recipe"]);
  assert.ok(merged.limitations.some((item) => item.startsWith("Checked against the open vault")));
  assert.ok(!merged.limitations.some((item) => /resolve links against the Obsidian index/u.test(item)));
  assert.doesNotMatch(JSON.stringify(merged), /pas une date/u);

  // Validating a file by path inspects the whole file, not a diff with itself.
  await checkMarkdownAgainstVault(staticResult, { content, filePath: "Inbox/Draft.md", source: "filePath" }, rest, context);
  assert.equal(requests.at(-1).body.baseline, "none");
  // Content with no Markdown path is inspected without a source file.
  await checkMarkdownAgainstVault(staticResult, { content, source: "content" }, rest, context);
  assert.deepEqual(Object.keys(requests.at(-1).body).sort(), ["baseline", "content", "contractVersion"]);

  // An older Bridge without the route: static checks stand, marked unchecked.
  reply = () => ({ status: 404, body: { message: "Not Found" } });
  const old = await checkMarkdownAgainstVault(staticResult, { content, source: "content" }, rest, context);
  assert.deepEqual(old.vaultCheck, { status: "not_checked", reason: "bridge_route_missing" });
  assert.deepEqual(old.errors, staticResult.errors);
  assert.deepEqual(old.warnings, staticResult.warnings);
  assert.equal(old.ok, staticResult.ok);
  assert.ok(old.limitations.some((item) => item.includes("not checked against the vault")));

  // A malformed success is not trusted as a vault check.
  reply = () => ({ status: 200, body: { ok: true } });
  const malformed = await checkMarkdownAgainstVault(staticResult, { content, source: "content" }, rest, context);
  assert.deepEqual(malformed.vaultCheck, { status: "not_checked", reason: "bridge_response_invalid" });
  assert.deepEqual(malformed.warnings, staticResult.warnings);

  // No REST connection in this runtime mode.
  const headless = await checkMarkdownAgainstVault(staticResult, { content, source: "content" }, undefined, context);
  assert.deepEqual(headless.vaultCheck, { status: "not_checked", reason: "bridge_not_configured" });
  assert.deepEqual(headless.warnings, staticResult.warnings);
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  });
}

// Obsidian closed: the port no longer answers.
const closed = await checkMarkdownAgainstVault(staticResult, { content, source: "content" }, rest, context);
assert.deepEqual(closed.vaultCheck, { status: "not_checked", reason: "bridge_unavailable" });
assert.deepEqual(closed.warnings, staticResult.warnings);
assert.ok(closed.limitations.some((item) => item.includes("not checked against the vault")));

await rm(root, { recursive: true, force: true });
console.log("PASS: obsidian_validate_format merges vault findings and degrades to static checks when the Bridge cannot answer");
