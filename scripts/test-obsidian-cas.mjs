import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const logsRoot = path.join(process.cwd(), "logs");
await mkdir(logsRoot, { recursive: true });
const logsDir = await mkdtemp(path.join(logsRoot, "cas-test-"));
process.env.OBSIDIAN_API_KEY = "test-only-api-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:27123";
process.env.MCP_LOG_LEVEL = "error";
process.env.LOGS_DIR = logsDir;

const { BaseErrorCode, McpError } = await import(
  "../dist/types-global/errors.js"
);
const { getFileDocumentMap, replaceFileContentIfMatch, updateFileContent } =
  await import("../dist/services/obsidianRestAPI/methods/vaultMethods.js");
const { ObsidianRestApiService } = await import(
  "../dist/services/obsidianRestAPI/service.js"
);

const context = {
  requestId: "cas-test",
  timestamp: new Date(0).toISOString(),
  operation: "testObsidianCas",
};

try {
  const requests = [];
  const request = async (requestConfig, _context, operationName) => {
    requests.push({ requestConfig, operationName });
    if (operationName === "getFileDocumentMap") {
      return {
        headings: { Projet: {} },
        blocks: [],
        frontmatterFields: ["statut"],
        version: "version-123",
      };
    }
  };

  const documentMap = await getFileDocumentMap(
    request,
    "Dossier riche/Note ÉLYSIA.md",
    context,
  );
  assert.equal(documentMap.version, "version-123");
  assert.deepEqual(requests[0], {
    operationName: "getFileDocumentMap",
    requestConfig: {
      method: "GET",
      url: "/vault/Dossier%20riche/Note%20%C3%89LYSIA.md",
      headers: {
        Accept: "application/vnd.olrapi.document-map+json",
      },
    },
  });

  await replaceFileContentIfMatch(
    request,
    "Dossier riche/Note ÉLYSIA.md",
    "# Projet\n\nContenu réparé.\n",
    '  "version-123"  ',
    context,
  );
  assert.deepEqual(requests[1], {
    operationName: "replaceFileContentIfMatch",
    requestConfig: {
      method: "PATCH",
      url: "/vault/Dossier%20riche/Note%20%C3%89LYSIA.md",
      headers: {
        "Content-Type": "text/markdown",
        Operation: "replace",
        "If-Match": '"version-123"',
      },
      data: "# Projet\n\nContenu réparé.\n",
    },
  });

  await assert.rejects(
    () =>
      replaceFileContentIfMatch(request, "Note.md", "# Note\n", "   ", context),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.VALIDATION_ERROR,
  );
  await assert.rejects(
    () =>
      replaceFileContentIfMatch(request, "Note.md", "", "version-123", context),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.VALIDATION_ERROR,
  );

  await assert.rejects(
    () =>
      getFileDocumentMap(
        async () => ({
          headings: {},
          blocks: [],
          frontmatterFields: [],
        }),
        "Legacy.md",
        context,
      ),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.SERVICE_UNAVAILABLE,
  );

  const legacyRequests = [];
  await updateFileContent(
    async (requestConfig, _context, operationName) => {
      legacyRequests.push({ requestConfig, operationName });
    },
    "Note.md",
    "legacy behavior",
    context,
  );
  assert.deepEqual(legacyRequests[0], {
    operationName: "updateFileContent",
    requestConfig: {
      method: "PUT",
      url: "/vault/Note.md",
      headers: { "Content-Type": "text/markdown" },
      data: "legacy behavior",
    },
  });

  const service = new ObsidianRestApiService();
  service.axiosInstance = {
    request: async () => {
      const error = new Error("Request failed with status code 412");
      error.response = {
        status: 412,
        data: {
          errorCode: 41200,
          message: "Document version does not match",
        },
      };
      throw error;
    },
  };

  await assert.rejects(
    () =>
      service.replaceFileContentIfMatch(
        "Note.md",
        "# Concurrent edit\n",
        "stale-version",
        context,
      ),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.CONFLICT &&
      error.message ===
        "Obsidian API Precondition Failed: the note changed after it was read.",
  );

  console.log("Obsidian REST CAS tests passed.");
} finally {
  await rm(logsDir, { recursive: true, force: true });
}
