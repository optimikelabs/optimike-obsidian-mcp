import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const logsRoot = path.join(process.cwd(), "logs");
await mkdir(logsRoot, { recursive: true });
const logsDir = await mkdtemp(path.join(logsRoot, "search-replace-cas-test-"));

process.env.OBSIDIAN_API_KEY = "test-only-api-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:27123";
process.env.MCP_LOG_LEVEL = "error";
process.env.LOGS_DIR = logsDir;
process.env.MCP_WRITE_MODE = "full";

const { BaseErrorCode, McpError } = await import(
  "../dist/types-global/errors.js"
);
const { ObsidianSearchReplaceInputSchema, processObsidianSearchReplace } =
  await import("../dist/mcp-server/tools/obsidianSearchReplaceTool/logic.js");

const context = {
  requestId: "search-replace-cas-test",
  timestamp: new Date(0).toISOString(),
  operation: "testSearchReplaceCas",
};

const filePath = "Projet/Pilote.md";
const originalContent = "# Pilote\n\nLien ancien\n";
const modifiedContent = "# Pilote\n\nLien nouveau\n";
const originalSha256 = createHash("sha256")
  .update(originalContent, "utf8")
  .digest("hex");

function params(overrides = {}) {
  return ObsidianSearchReplaceInputSchema.parse({
    targetType: "filePath",
    targetIdentifier: filePath,
    replacements: [{ search: "Lien ancien", replace: "Lien nouveau" }],
    expectedSha256: originalSha256,
    ...overrides,
  });
}

function createService({
  documentVersions = ["version-1", "version-1"],
  markdownContent = originalContent,
} = {}) {
  const calls = [];
  let mapIndex = 0;

  const service = {
    async getFileDocumentMap(requestedPath) {
      calls.push({ method: "getFileDocumentMap", path: requestedPath });
      const version =
        documentVersions[Math.min(mapIndex, documentVersions.length - 1)];
      mapIndex += 1;
      return {
        headings: {},
        blocks: [],
        frontmatterFields: [],
        version,
      };
    },
    async getFileContent(requestedPath, format) {
      calls.push({ method: "getFileContent", path: requestedPath, format });
      if (format === "json") {
        return {
          content: modifiedContent,
          frontmatter: {},
          path: requestedPath,
          stat: null,
          tags: [],
        };
      }
      return markdownContent;
    },
    async replaceFileContentIfMatch(requestedPath, content, expectedVersion) {
      calls.push({
        method: "replaceFileContentIfMatch",
        path: requestedPath,
        content,
        expectedVersion,
      });
    },
    async updateFileContent(requestedPath, content) {
      calls.push({
        method: "updateFileContent",
        path: requestedPath,
        content,
      });
    },
    async getActiveFile(format) {
      calls.push({ method: "getActiveFile", format });
      return markdownContent;
    },
  };

  return { service, calls };
}

function writeCalls(calls) {
  return calls.filter((call) =>
    ["replaceFileContentIfMatch", "updateFileContent"].includes(call.method),
  );
}

try {
  {
    const { service, calls } = createService();
    const result = await processObsidianSearchReplace(
      params(),
      context,
      service,
      undefined,
    );

    assert.equal(result.success, true);
    assert.equal(result.totalReplacementsMade, 1);
    assert.deepEqual(
      calls.slice(0, 4).map((call) => call.method),
      [
        "getFileDocumentMap",
        "getFileContent",
        "getFileDocumentMap",
        "replaceFileContentIfMatch",
      ],
    );
    assert.deepEqual(writeCalls(calls), [
      {
        method: "replaceFileContentIfMatch",
        path: filePath,
        content: modifiedContent,
        expectedVersion: "version-1",
      },
    ]);
  }

  {
    const { service, calls } = createService();
    await assert.rejects(
      () =>
        processObsidianSearchReplace(
          params({ expectedSha256: "0".repeat(64) }),
          context,
          service,
          undefined,
        ),
      (error) =>
        error instanceof McpError &&
        error.code === BaseErrorCode.CONFLICT &&
        error.message === "The note content does not match expectedSha256.",
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["getFileDocumentMap", "getFileContent"],
    );
    assert.deepEqual(writeCalls(calls), []);
  }

  {
    const { service, calls } = createService({
      documentVersions: ["version-1", "version-2"],
    });
    await assert.rejects(
      () => processObsidianSearchReplace(params(), context, service, undefined),
      (error) =>
        error instanceof McpError &&
        error.code === BaseErrorCode.CONFLICT &&
        error.message ===
          "The note changed while the conditional replacement was being prepared.",
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["getFileDocumentMap", "getFileContent", "getFileDocumentMap"],
    );
    assert.deepEqual(writeCalls(calls), []);
  }

  {
    const { service, calls } = createService();
    await assert.rejects(
      () =>
        processObsidianSearchReplace(
          params({
            targetType: "activeFile",
            targetIdentifier: undefined,
          }),
          context,
          service,
          undefined,
        ),
      (error) =>
        error instanceof McpError &&
        error.code === BaseErrorCode.VALIDATION_ERROR &&
        error.message ===
          "expectedSha256 is supported only for an explicit filePath target.",
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["getActiveFile"],
    );
    assert.deepEqual(writeCalls(calls), []);
  }

  {
    const { service, calls } = createService();
    const result = await processObsidianSearchReplace(
      params({ expectedSha256: undefined }),
      context,
      service,
      undefined,
    );

    assert.equal(result.success, true);
    assert.equal(result.totalReplacementsMade, 1);
    assert.equal(
      calls.some((call) => call.method === "getFileDocumentMap"),
      false,
    );
    assert.deepEqual(writeCalls(calls), [
      {
        method: "updateFileContent",
        path: filePath,
        content: modifiedContent,
      },
    ]);
  }

  console.log("Obsidian search/replace expectedSha256 tests passed.");
} finally {
  await rm(logsDir, { recursive: true, force: true });
}
