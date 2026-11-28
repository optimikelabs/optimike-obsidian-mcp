import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { glob_to_regex } from "./vendor/jsbrains-glob.mjs";

function exclusionList(value) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return entries.map(entry => entry.trim()).filter(entry => entry && !/^[/*\\]+$/u.test(entry));
}

export async function readSmartEnvSelection(directory) {
  const filename = path.join(directory, "smart_env.json");
  let settings;
  try {
    if (!(await lstat(filename)).isFile()) throw Error("Invalid settings path");
    settings = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw Error("Could not read Smart Environment settings for selection");
  }
  const sources = settings.smart_sources ?? {};
  const blocks = settings.smart_blocks ?? {};
  const minNoteChars = Number(sources.min_chars ?? 300);
  const minBlockChars = Number(blocks.min_chars ?? 300);
  if (![minNoteChars, minBlockChars].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw Error("Invalid Smart Environment selection thresholds");
  }
  const filePatterns = exclusionList(sources.file_exclusions_list ?? sources.file_exclusions)
    .map(file => file + "**");
  const folderPatterns = exclusionList(sources.folder_exclusions_list ?? sources.folder_exclusions)
    .map(folder => folder.endsWith("/**") ? folder : folder.replace(/\/$/u, "") + "/**");
  const gitignore = settings.skip_excluding_gitignore ? [] : settings.gitignore_exclusions ?? [];
  return {
    minNoteChars,
    minBlockChars,
    headings: [...new Set(exclusionList(sources.excluded_headings))].sort(),
    patterns: [...new Set([...gitignore, ...filePatterns, ...folderPatterns].map(value => value.trim()))].sort(),
    embedBlocks: blocks.embed_blocks !== false,
  };
}

export function exclusionMatcher(policy) {
  if (!policy) return () => false;
  const patterns = policy.patterns.map(pattern => glob_to_regex(pattern));
  return relative => relative.includes("#") || patterns.some(pattern => pattern.test(relative));
}

/**
 * A range tree models the Smart Environment v3 selection policy shipped by
 * Smart Connections 4.7.2. Selection compares retained content capacity
 * rather than checking for two descendants at the parent's line boundaries.
 */
export function selectSmartEnvBlocks(blocks, minimum, tokenBudget) {
  const capacity = Math.floor(tokenBudget * 3.7);
  const ordered = blocks.map(([key, [start, end], text, prefix]) => ({
    key, start, end, size: text.length, capacity: Math.max(0, capacity - prefix.length - 1), branches: [],
  })).sort((a, b) => a.start - b.start || b.end - a.end || a.key.length - b.key.length);
  const root = { branches: [] };
  const ancestors = [root];
  for (const block of ordered) {
    if (!Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end) ||
        block.start < 0 || block.end < block.start) continue;
    while (ancestors.length > 1 && ancestors.at(-1).end < block.end) {
      if (ancestors.pop().end >= block.start) return new Set();
    }
    ancestors.at(-1).branches.push(block);
    ancestors.push(block);
  }
  function choose(block) {
    const eligible = block.size >= minimum;
    const overflow = Math.max(0, block.size - block.capacity);
    const alternative = { keys: [], loss: 0 };
    let uncovered = block.size - (block.end - block.start + 1) + 1;
    for (const child of block.branches) {
      const result = choose(child);
      for (const key of result.keys) alternative.keys.push(key);
      alternative.loss += result.loss;
      uncovered -= child.size - (child.end - child.start);
    }
    if (block.key === "#") alternative.loss += Math.max(0, uncovered);
    if (eligible && (alternative.keys.length === 0 || overflow < alternative.loss)) {
      return { keys: [block.key], loss: overflow };
    }
    if (block.branches.length === 0) return { keys: [], loss: block.size };
    return alternative;
  }
  return new Set(root.branches.flatMap(branch => choose(branch).keys));
}
