import path from "node:path";
import type { MarkdownLinkReference } from "../obsidianRestAPI/vaultCache/markdownLinkReferences.js";
import { MarkdownLinkResolver } from "../obsidianRestAPI/vaultCache/markdownLinkResolver.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { sha256, type readVaultAppSettings } from "./headlessVaultFiles.js";

export type LinkEdit = { start: number; end: number; after: string };
type Settings = ReturnType<typeof readVaultAppSettings>;

function unsupported(): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, "A resolved link cannot be rewritten without changing its surrounding syntax.");
}

function linkSpelling(resolver: MarkdownLinkResolver, source: string, destination: string, format: Settings["format"], markdown: boolean) {
  const spelling = markdown ? destination : destination.replace(/\.md$/iu, "");
  const relative = path.posix.relative(path.posix.dirname(source), spelling);
  const fromSource = relative.startsWith("../") ? relative : "./" + relative;
  const valid = (value: string) => {
    const target = resolver.resolve(source, value);
    return target?.path === destination && !target.ambiguous;
  };
  const parts = spelling.slice(1).split("/");
  const candidates = format === "relative" ? [fromSource]
    : format === "absolute" ? [spelling]
    : [...parts.keys()].reverse().map(index => parts.slice(index).join("/")).concat(spelling);
  const chosen = candidates.find(valid);
  if (chosen) return chosen;
  // A same-name attachment may shadow an extensionless Markdown spelling.
  if (valid(destination)) return destination;
  return unsupported();
}

function encodePath(value: string) {
  return value.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/gu, ch => "%" + ch.charCodeAt(0).toString(16))).join("/");
}

/** Replace only destination bytes for existing inline Markdown and definitions. */
function markdownDestination(raw: string, ref: MarkdownLinkReference, destination: string): string {
  const prefix = ref.edit?.syntax === "definition" ? /\]:\s*/gu : /\]\(\s*/gu;
  for (const match of raw.matchAll(prefix)) {
    const start = match.index + match[0].length;
    const angle = raw[start] === "<";
    const token = angle ? /^<([^>\r\n]*)>/u.exec(raw.slice(start))?.[1]
      : /^(?:\\.|[^\s)])+/u.exec(raw.slice(start))?.[0];
    if (!token) continue;
    const [target, ...fragment] = token.split("#");
    try {
      if (decodeURIComponent(target.replace(/\\([!"#$%&'()*+,./:;<=>?@[\]\\^_`{|}~-])/gu, "$1")) !== ref.linkPath ||
          (fragment.length ? "#" + decodeURIComponent(fragment.join("#")) : "") !== ref.subpath) continue;
    } catch { continue; }
    const offset = start + Number(angle);
    return raw.slice(0, offset) + destination + raw.slice(offset + target.length);
  }
  return unsupported();
}

function replacement(content: string, ref: MarkdownLinkReference, resolver: MarkdownLinkResolver,
  source: string, destination: string, settings: Settings): LinkEdit | undefined {
  const edit = ref.edit;
  if (!edit) return unsupported();
  const raw = content.slice(edit.start, edit.end);
  if (!ref.linkPath) return undefined; // A bare self fragment follows the move.
  const wiki = edit.syntax === "wiki" || edit.syntax === "yaml";
  const spelling = linkSpelling(resolver, source, destination, settings.format, !wiki);
  let after: string;
  // Preserve existing link syntax. Markdown fragment conversion is not required for relocation.
  if (wiki) {
    const start = raw.indexOf("[[") + 2;
    const tail = raw.slice(start);
    const target = /^[^#|\]]+?(?=\\?\||#|\]\])/u.exec(tail)?.[0];
    if (!target || (edit.quote === "'" ? target.replace(/''/gu, "'") : target).trim() !== ref.linkPath || /[#|\[\]]/u.test(spelling)) return unsupported();
    const escaped = edit.quote === "'" ? spelling.replace(/'/gu, "''")
      : edit.quote === '"' ? spelling.replace(/["\\]/gu, "\\$&") : spelling;
    after = raw.slice(0, start) + target.replace(/\S(?:[\s\S]*\S)?/u, () => escaped) + tail.slice(target.length);
  } else {
    // Keep Markdown labels and titles intact for existing Markdown links.
    after = markdownDestination(raw, ref, encodePath(spelling));
  }
  return after === raw ? undefined : { start: edit.start, end: edit.end, after };
}

export function applyLinkEdits(content: string, edits: readonly LinkEdit[]) {
  let result = content;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
  return result;
}

export function rewriteIncoming(content: string, note: string, source: string, destination: string,
  before: MarkdownLinkResolver, after: MarkdownLinkResolver, settings: Settings,
  original: MarkdownLinkReference[], extract: (content: string) => MarkdownLinkReference[]) {
  const nextNote = note === source ? destination : note;
  const edits = new Map<number, LinkEdit>();
  const expected = new Map<string, number>();
  for (const ref of original) {
    const target = before.resolve(note, ref.linkPath)?.path;
    if (!target) continue;
    const wanted = target === source ? destination : target;
    const projected = after.resolve(nextNote, ref.linkPath);
    const identity = JSON.stringify([wanted, ref.subpath]);
    expected.set(identity, (expected.get(identity) ?? 0) + 1);
    if (note !== source && target !== source) {
      if (projected?.path !== wanted) {
        throw new McpError(BaseErrorCode.CONFLICT, "The move would change the target of an unrelated link.",
          { reasonCode: "headless_link_target_changed" });
      }
      continue;
    }
    if (!ref.linkPath || (target !== source && projected?.path === wanted)) continue;
    if (ref.frontmatterKey && /^(?:création|modification)$/iu.test(ref.frontmatterKey)) return unsupported();
    const style = note === source && target !== source && settings.format === "shortest" &&
      /^\.\.?\//u.test(ref.linkPath) ? { ...settings, format: "relative" as const } : settings;
    const edit = replacement(content, ref, after, nextNote, wanted, style);
    if (edit) edits.set(edit.start, edit);
  }
  const ordered = [...edits.values()].sort((a, b) => b.start - a.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].end > ordered[i - 1].start) return unsupported();
  }
  if (!ordered.length) return { references: original };
  const next = applyLinkEdits(content, ordered);
  const references = extract(next);
  for (const ref of references) {
    const target = after.resolve(nextNote, ref.linkPath)?.path;
    const identity = JSON.stringify([target, ref.subpath]);
    const remaining = expected.get(identity);
    if (remaining) expected.set(identity, remaining - 1);
  }
  if ([...expected.values()].some(count => count > 0)) return unsupported();
  const first = ordered.at(-1)!;
  return { references, rewrite: {
    edits: ordered, beforeText: content, afterHash: sha256(next), count: ordered.length,
    sample: { before: content.slice(first.start, first.end).slice(0, 240), after: first.after.slice(0, 240) },
  } };
}
