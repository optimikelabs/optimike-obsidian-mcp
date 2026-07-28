import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const logsRoot = path.join(process.cwd(), "logs");
await mkdir(logsRoot, { recursive: true });
const logsDir = await mkdtemp(path.join(logsRoot, "live-write-boundary-test-"));
process.env.OBSIDIAN_API_KEY = "test-only-api-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:27123";
process.env.MCP_LOG_LEVEL = "error";
process.env.LOGS_DIR = logsDir;

const { BaseErrorCode, McpError } = await import(
  "../dist/types-global/errors.js"
);
const { updateFileContent } = await import(
  "../dist/services/obsidianRestAPI/methods/vaultMethods.js"
);
const { ObsidianRestApiService } = await import(
  "../dist/services/obsidianRestAPI/service.js"
);

const context = {
  requestId: "live-write-boundary-test",
  timestamp: new Date(0).toISOString(),
  operation: "testLiveWriteBoundary",
};

try {
  const requests = [];
  await updateFileContent(
    async (requestConfig, _context, operationName) => {
      requests.push({ requestConfig, operationName });
    },
    "Dossier riche/Note ÉLYSIA.md",
    "# Note\n",
    context,
  );
  assert.deepEqual(requests[0], {
    operationName: "updateFileContent",
    requestConfig: {
      method: "PUT",
      url: "/vault/Dossier%20riche/Note%20%C3%89LYSIA.md",
      headers: { "Content-Type": "text/markdown" },
      data: "# Note\n",
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
          message: "Precondition failed",
        },
      };
      throw error;
    },
  };
  await assert.rejects(
    () => service.updateFileContent("Note.md", "# Concurrent edit\n", context),
    (error) =>
      error instanceof McpError &&
      error.code === BaseErrorCode.CONFLICT &&
      error.message ===
        "Obsidian API Precondition Failed: the note changed after it was read.",
  );

  console.log("Obsidian REST live-write boundary tests passed.");
} finally {
  await rm(logsDir, { recursive: true, force: true });
}
