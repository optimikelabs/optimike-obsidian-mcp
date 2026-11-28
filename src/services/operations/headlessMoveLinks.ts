import path from "node:path";
import {
  extractMarkdownLinkReferences, type MarkdownLinkReference,
} from "../obsidianRestAPI/vaultCache/markdownLinkReferences.js";
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
  // Property wikilinks and reference definitions retain their container syntax.
  const toMarkdown = wiki && edit.syntax !== "yaml" && settings.useMarkdownLinks === true &&
    !(ref.kind === "embed" && ref.displayText);
  const format = settings.format;
  const spelling = linkSpelling(resolver, source, destination, format, !wiki || toMarkdown);
  let after: string;
  if (toMarkdown) {
    const label = (ref.displayText ?? path.posix.basename(destination).replace(/\.md$/iu, "")).replace(/[\\[\]]/gu, "\\$&");
    const fragment = ref.subpath ? "#" + encodeURIComponent(ref.subpath.slice(1)) : "";
    after = `${ref.kind === "embed" ? "!" : ""}[${label}](${encodePath(spelling)}${fragment})`;
  } else if (wiki) {
    const start = raw.indexOf("[[") + 2;
    const tail = raw.slice(start);
    const target = /^[^#|\]]+/u.exec(tail)?.[0];
    if (!target || target.trim() !== ref.linkPath || /[#|\[\]]/u.test(spelling)) return unsupported();
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
  before: MarkdownLinkResolver, after: MarkdownLinkResolver, settings: Settings) {
  const nextNote = note === source ? destination : note;
  const matches = extractMarkdownLinkReferences(content, true).filter(ref => before.resolve(note, ref.linkPath)?.path === source);
  const edits = new Map<number, LinkEdit>();
  for (const ref of matches) {
    if (!ref.linkPath) continue;
    if (ref.frontmatterKey && /^(?:création|modification)$/iu.test(ref.frontmatterKey)) return unsupported();
    const edit = replacement(content, ref, after, nextNote, destination, settings);
    if (edit) edits.set(edit.start, edit);
  }
  const ordered = [...edits.values()].sort((a, b) => b.start - a.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].end > ordered[i - 1].start) return unsupported();
  }
  if (!ordered.length) return undefined;
  const next = applyLinkEdits(content, ordered);
  const rewritten = extractMarkdownLinkReferences(next).filter(ref => after.resolve(nextNote, ref.linkPath)?.path === destination);
  // Reject a splice that makes an incoming link disappear or lose its fragment.
  const fragments = new Map<string, number>();
  for (const ref of rewritten) fragments.set(ref.subpath, (fragments.get(ref.subpath) ?? 0) + 1);
  for (const ref of matches) {
    const count = fragments.get(ref.subpath) ?? 0;
    if (!count) return unsupported();
    fragments.set(ref.subpath, count - 1);
  }
  const first = ordered.at(-1)!;
  return { edits: ordered, afterHash: sha256(next), count: ordered.length,
    sample: { before: content.slice(first.start, first.end).slice(0, 240), after: first.after.slice(0, 240) } };
}
