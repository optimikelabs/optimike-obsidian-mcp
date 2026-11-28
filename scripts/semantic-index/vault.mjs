import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { extractInlineTags } from "../../dist/services/markdownTags.js";
import { parse_markdown_blocks } from "./vendor/jsbrains-markdown.mjs";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const parserRevision = "9f6d2920f963ed227a69e7660a3d2a70c83068d5";

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(".." + path.sep));
}

async function resolveForCreation(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT" || target === path.dirname(target)) throw error;
    return path.join(await resolveForCreation(path.dirname(target)), path.basename(target));
  }
  return realpath(target);
}

export async function resolveRoots(vaultPath, indexPath) {
  const vault = await realpath(vaultPath);
  if (!(await lstat(vault)).isDirectory()) throw Error("Vault root must be a directory");
  const index = await resolveForCreation(path.resolve(indexPath));
  if (isInside(vault, index) || isInside(index, vault)) {
    throw Error("Vault and index directories must be disjoint");
  }
  for (const start of new Set([path.resolve(indexPath), index])) {
    for (let directory = start; ; directory = path.dirname(directory)) {
      const marker = await lstat(path.join(directory, ".obsidian")).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      if (marker) throw Error("Index directory must be outside any Obsidian vault");
      if (directory === path.dirname(directory)) break;
    }
  }
  return { vault, index };
}

function inode(stat) {
  return [stat.dev, stat.ino, stat.birthtimeNs].join(":");
}

function stamp(stat) {
  return [inode(stat), stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export async function inventory(vault, excludedPaths) {
  const root = await lstat(vault, { bigint: true });
  if (!root.isDirectory()) throw Error("Vault root is unavailable");
  const directories = new Map();
  const files = new Map();
  const unsafePaths = new Map();
  const excludes = new Set(excludedPaths);
  // Filter only known exclusions. A failed traversal of an included entry aborts.
  async function walk(relative) {
    const directory = path.join(vault, relative);
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== root.dev ||
        await realpath(directory) !== directory) {
      throw Error("Vault directory changed or is on another volume");
    }
    directories.set(relative, inode(stat));
    for (const name of (await readdir(directory)).sort()) {
      const child = relative ? relative + "/" + name : name;
      if (name.startsWith(".") || excludes.has(child)) continue;
      const entry = await lstat(path.join(vault, child), { bigint: true });
      if (entry.isSymbolicLink()) throw Error("Symbolic links require an explicit path exclusion");
      if (entry.isDirectory()) await walk(child);
      else if (/\.md$/iu.test(name)) {
        if (!entry.isFile() || entry.dev !== root.dev) throw Error("Unsafe Markdown source");
        // Match the strict Smart Env v3 reader's note-path constraints.
        const valid = !/[:\\\x00-\x1f]/u.test(child) &&
          child.split("/").every(segment => segment && segment !== "." && segment !== "..");
        (valid ? files : unsafePaths).set(child, stamp(entry));
      }
    }
  }
  await walk("");
  if (directories.get("") !== inode(root)) throw Error("Vault root was replaced during inventory");
  return { binding: sha256(vault + "\0" + inode(root)), files, directories, unsafePaths };
}

export async function readSource(vault, relative, expected) {
  const filename = path.join(vault, relative);
  if (await realpath(filename) !== filename) throw Error("Markdown source path changed");
  const handle = await open(filename, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || stamp(before) !== expected) throw Error("Markdown source changed during scan");
    const bytes = await handle.readFile();
    if (stamp(await handle.stat({ bigint: true })) !== expected) {
      throw Error("Markdown source changed during read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameEntries(left, right) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

export async function verifySources(vault, excludedPaths, initial, hashes) {
  function compare(current) {
    if (current.binding !== initial.binding ||
        !sameEntries(initial.files, current.files) ||
        !sameEntries(initial.unsafePaths, current.unsafePaths) ||
        !sameEntries(initial.directories, current.directories)) {
      throw Error("Vault inventory changed during build");
    }
  }
  compare(await inventory(vault, excludedPaths));
  for (const [relative, expected] of initial.files) {
    if (sha256(await readSource(vault, relative, expected)) !== hashes.get(relative)) {
      throw Error("Markdown content changed during build");
    }
  }
  // Catch entries changed after their hash was checked in the second pass.
  compare(await inventory(vault, excludedPaths));
}

const breadcrumbs = value => value.split("/").join(" > ").replace(".md", "");
export const noteInput = (relative, text) => breadcrumbs(relative) + ":\n" + text;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function readSourceParts(vault, relative, expected, chunking) {
  const bytes = await readSource(vault, relative, expected);
  const digest = sha256(bytes);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
    return { digest, parts: null, reason: "invalid_utf8" };
  }
  // SmartSource.should_embed compares the file's byte size to min_chars.
  if (bytes.length <= chunking.minNoteChars) {
    return { digest, parts: null, reason: "note_below_min_size" };
  }
  return { digest, parts: sourceParts(relative, text, chunking.excludedHeadings, chunking.minBlockChars) };
}

function tagsFrom(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/mu.exec(text);
  const hasFrontmatter = frontmatter?.index === 0;
  const tags = hasFrontmatter ? parseDocument(frontmatter[1]).get("tags") : undefined;
  const frontmatterTags = Array.isArray(tags?.items) ? tags.items.map(tag => tag?.value) : [tags];
  const body = hasFrontmatter ? text.slice(frontmatter[0].length) : text;
  return [...new Set([
    ...frontmatterTags.filter(tag => typeof tag === "string").map(tag => tag.trim().replace(/^#+/u, "")),
    ...extractInlineTags(body),
  ].filter(Boolean))];
}

export function sourceParts(relative, raw, excludedHeadings, minBlockChars) {
  const ranges = Object.entries(parse_markdown_blocks(raw).blocks);
  const lines = raw.split("\n");
  const mask = lines.map(() => false);
  for (const [, [start, end]] of ranges) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(lines[start - 1].trim())?.[1].trim();
    if (excludedHeadings.includes(heading)) {
      mask.fill(true, start - 1, end ?? lines.length);
    }
  }
  const text = mask.some(Boolean) ? lines.filter((line, index) => !mask[index] && line.length).join("\n") : raw;
  const textByKey = new Map(ranges.map(([key, [start, end]]) => [key, lines.slice(start - 1, end).join("\n")]));
  const rangeByKey = new Map(ranges);
  const descendants = new Map();
  for (const entry of ranges) {
    const [key] = entry;
    for (let split = key.indexOf("#", 1); split !== -1; split = key.indexOf("#", split + 1)) {
      const parent = key.slice(0, split);
      if (!rangeByKey.has(parent)) continue;
      if (!descendants.has(parent)) descendants.set(parent, []);
      descendants.get(parent).push(entry);
    }
  }
  const selection = new Map();
  // Adapted from jsbrains SmartBlock.should_embed at parserRevision (MIT).
  function shouldEmbed(key) {
    if (selection.has(key)) return selection.get(key);
    const [start, end] = rangeByKey.get(key);
    let embed = textByKey.get(key).length >= minBlockChars;
    if (embed) {
      let first;
      let last;
      for (const [child, [childStart, childEnd]] of descendants.get(key) ?? []) {
        if (childStart === start + 1) first = child;
        if (childEnd === end) last = child;
        if (first && last) break;
      }
      if (first && last && shouldEmbed(first) && shouldEmbed(last)) embed = false;
    }
    selection.set(key, embed);
    return embed;
  }
  const blocks = [];
  for (const [key, range] of ranges) {
    if (/^#+---frontmatter---/u.test(key) || mask.slice(range[0] - 1, range[1]).some(Boolean)) continue;
    const text = textByKey.get(key);
    if (!text.trim() || !shouldEmbed(key)) continue;
    const prefix = breadcrumbs((relative + key).split("#").slice(0, -1).join(" > "));
    blocks.push({ key, range, text, input: prefix + "\n" + text });
  }
  return { tags: tagsFrom(text), note: { text: raw, input: noteInput(relative, text) }, blocks };
}
