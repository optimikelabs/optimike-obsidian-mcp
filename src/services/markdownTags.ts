/**
 * Shared inline-tag extraction following the Obsidian tag rules
 * (https://obsidian.md/help/tags): letters, digits, underscore, hyphen and
 * forward slash for nesting, plus Unicode letters and emoji; no spaces; and at
 * least one non-numerical character, so `#1984` (or a pull-request number such
 * as `#113/`) is never a tag while `#y1984` is.
 *
 * This module has no imports on purpose: the validator, the vault file service
 * and the note reader all share it without creating a cycle.
 */

/** Mask code without changing line breaks; unmatched inline delimiters remain prose. */
export function markdownWithoutCode(body: string): {
  text: string;
  unclosedFence: boolean;
} {
  let fence: { marker: string; length: number } | undefined;
  let text = "";
  for (const line of body.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (!line) continue;
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line);
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*\r?\n?$/u.exec(line);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      text += line.replace(/[^\r\n]/gu, " ");
    } else if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      text += line.replace(/[^\r\n]/gu, " ");
    } else text += line;
  }
  // Inline spans can cross lines; closing runs must have the exact same length.
  const chars = [...text];
  for (let i = 0; i < chars.length;) {
    if (chars[i] !== "`" || (i > 0 && chars[i - 1] === "\\")) { i++; continue; }
    let end = i;
    while (chars[end] === "`") end++;
    const length = end - i;
    let close = end;
    while (close < chars.length) {
      if (chars[close] !== "`") { close++; continue; }
      let after = close;
      while (chars[after] === "`") after++;
      if (after - close === length) {
        for (let j = i; j < after; j++) if (chars[j] !== "\n" && chars[j] !== "\r") chars[j] = " ";
        end = after;
        break;
      }
      close = after;
    }
    i = end;
  }
  text = chars.join("");
  return { text, unclosedFence: Boolean(fence) };
}

const TAG_CHARACTERS = String.raw`[\p{L}\p{N}\p{M}\p{Extended_Pictographic}_/-]`;

/** A tag candidate starts at the beginning of a line or after whitespace or an opening bracket. */
const INLINE_TAG_CANDIDATE = new RegExp(
  String.raw`(?<![^\s([{])#(${TAG_CHARACTERS}+)`,
  "gu",
);

/**
 * Returns the Obsidian-valid form of a tag candidate (without `#`), or
 * `undefined` when the candidate is not a tag. A trailing slash is punctuation,
 * not part of the tag; empty nesting segments and purely numerical candidates
 * are refused.
 */
export function normalizeInlineTagCandidate(
  candidate: string,
): string | undefined {
  const tag = candidate.replace(/\/+$/u, "");
  if (!tag || tag.split("/").some((segment) => segment === "")) {
    return undefined;
  }
  return /[^\p{N}/]/u.test(tag) ? tag : undefined;
}

/** Inline tags of a Markdown body, ignoring fenced code blocks and inline code spans. */
export function extractInlineTags(body: string): string[] {
  const { text } = markdownWithoutCode(body);
  const tags: string[] = [];
  for (const match of text.matchAll(INLINE_TAG_CANDIDATE)) {
    const tag = normalizeInlineTagCandidate(match[1]);
    if (tag) tags.push(tag);
  }
  return tags;
}
