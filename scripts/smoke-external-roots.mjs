import assert from "node:assert/strict";
import path from "node:path";
import { ExternalRootsService } from "../dist/services/externalRootsService.js";

const configPath =
  process.env.MCP_EXTERNAL_ROOTS_FILE || process.argv.slice(2)[0];
if (!configPath) {
  throw new Error(
    "Provide MCP_EXTERNAL_ROOTS_FILE or pass the machine-local config path.",
  );
}

const service = await ExternalRootsService.fromConfigFile(configPath);
const roots = await service.listRoots();
assert.ok(roots.length > 0, "At least one external root is required.");
assert.equal(
  JSON.stringify(roots).includes(path.dirname(configPath)),
  false,
  "Public root status must not disclose machine-local paths.",
);

const root = roots[0];
assert.equal(root.available, true, `Root '${root.id}' must be available.`);
const listing = await service.list(root.id, "", root.limits.maxDepth, 1000);
const files = listing.entries
  .filter((entry) => entry.type === "file")
  .sort((a, b) => a.path.localeCompare(b.path));
assert.ok(files.length > 0, `Root '${root.id}' must expose at least one file.`);

const textFile = files.find((entry) =>
  [".md", ".txt", ".csv", ".json"].includes(
    path.extname(entry.path).toLowerCase(),
  ),
);
assert.ok(textFile, `Root '${root.id}' must expose a UTF-8 pilot file.`);
const read = await service.readText(root.id, textFile.path, 2000);
assert.ok(read.chars > 0, "Pilot text read must return content.");
assert.equal("localPath" in read, false);

const documentFile =
  files.find((entry) =>
    [".pdf", ".docx", ".xlsx", ".pptx"].includes(
      path.extname(entry.path).toLowerCase(),
    ),
  ) ?? textFile;
const handoff = await service.handoff(root.id, documentFile.path, true);
assert.ok(path.isAbsolute(handoff.localPath));
assert.ok(handoff.sha256);

console.log(
  JSON.stringify(
    {
      rootId: root.id,
      available: root.available,
      listedFiles: files.length,
      listingTruncated: listing.truncated,
      textRead: {
        path: textFile.path,
        chars: read.chars,
        truncated: read.truncated,
        sha256: read.sha256,
      },
      handoff: {
        path: documentFile.path,
        size: handoff.size,
        sha256: handoff.sha256,
        localPathDisclosedByExplicitHandoff: true,
      },
    },
    null,
    2,
  ),
);
