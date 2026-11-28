#!/usr/bin/env node

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createVaultExclusionMatcher,
  isVaultPathExcluded,
  normalizeVaultRelativePath,
  parseVaultExcludePatterns,
} from "../dist/services/vaultExclusions.js";

async function walk(root, directory, matcher, counters, samples) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalizeVaultRelativePath(path.relative(root, absolutePath));
    const excluded = isVaultPathExcluded(relativePath, matcher, entry.isDirectory());
    if (excluded) {
      counters.excluded += 1;
      if (samples.excluded.length < 20) samples.excluded.push(relativePath);
      if (entry.isDirectory()) continue;
    }

    if (entry.isDirectory()) {
      await walk(root, absolutePath, matcher, counters, samples);
      continue;
    }

    if (!entry.isFile()) continue;
    counters.files += 1;
    if (relativePath.toLowerCase().endsWith(".md")) {
      counters.markdown += 1;
      if (!excluded) counters.includedMarkdown += 1;
    }
    if (!excluded && samples.included.length < 20) {
      samples.included.push(relativePath);
    }
  }
}

async function main() {
  const vaultRoot =
    process.env.OBSIDIAN_VAULT ||
    process.argv.find((arg) => arg.startsWith("--vault="))?.slice("--vault=".length);
  if (!vaultRoot) {
    throw new Error("Set OBSIDIAN_VAULT or pass --vault=<path>.");
  }

  const resolvedVault = path.resolve(vaultRoot);
  const vaultStats = await stat(resolvedVault);
  if (!vaultStats.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${resolvedVault}`);
  }

  const patterns = parseVaultExcludePatterns(process.env.OBSIDIAN_VAULT_EXCLUDE_PATTERNS);
  const matcher = createVaultExclusionMatcher(patterns);
  const counters = {
    files: 0,
    markdown: 0,
    includedMarkdown: 0,
    excluded: 0,
  };
  const samples = {
    excluded: [],
    included: [],
  };

  await walk(resolvedVault, resolvedVault, matcher, counters, samples);

  console.log(
    JSON.stringify(
      {
        ok: true,
        vaultRoot: resolvedVault,
        patternCount: patterns.length,
        counters,
        samples,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exit(1);
});
