#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Keep the released 2.9 runtime smoke as a broad behaviour fixture, but execute
// it against the public V3 entrypoint and the V3 semantic-name contract. The
// transformation is intentionally strict: any upstream fixture drift fails
// before the smoke can produce a misleading green result.
const fixturePath = path.resolve(
  "scripts/smoke-headless-readonly-2.9-fixture.mjs",
);
let source = await readFile(fixturePath, "utf8");

const entrypointNeedle = '    args: ["dist/index.js"],';
if (!source.includes(entrypointNeedle)) {
  throw new Error("V3 smoke fixture lost the expected 2.9 stdio entrypoint.");
}
source = source.replace(
  entrypointNeedle,
  '    args: ["dist/index-v3.js", "--tool-profile", "full"],',
);

const legacySemanticBlock =
  /    const semanticSearchAliases = new Set\(\[[\s\S]*?\n\n    const routingDescriptionContracts = \[/u;
if (!legacySemanticBlock.test(source)) {
  throw new Error(
    "V3 smoke fixture lost the expected 2.9 semantic-alias assertion block.",
  );
}
source = source.replace(
  legacySemanticBlock,
  `    const semanticSearchTool = toolsByName.get("smart_semantic_search");
    if (!semanticSearchTool) {
      throw new Error("Missing canonical V3 semantic-search tool: smart_semantic_search");
    }
    if (semanticSearchTool.annotations?.openWorldHint !== true) {
      throw new Error("smart_semantic_search must remain marked open-world.");
    }
    for (const removedAlias of ["smart_search", "smart-search"]) {
      if (toolsByName.has(removedAlias)) {
        throw new Error(
          \\`\${removedAlias} was removed in Optimike MCP 3.0 and must not appear in tools/list.\\`,
        );
      }
    }

    const routingDescriptionContracts = [`,
);

const tempDir = path.resolve(".tmp", "v3-runtime-smoke");
const generatedPath = path.join(
  tempDir,
  `smoke-${process.pid}-${Date.now()}.mjs`,
);
await mkdir(tempDir, { recursive: true });
await writeFile(generatedPath, source, "utf8");

try {
  await import(pathToFileURL(generatedPath).href);
} finally {
  await rm(generatedPath, { force: true }).catch(() => undefined);
}
