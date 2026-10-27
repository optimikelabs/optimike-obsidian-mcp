/**
 * One shared rule for names of new vault files, valid on Windows, macOS, iOS,
 * Android and in Obsidian links. Pure and dependency-free: the Atomic Write
 * Bridge bundles it too. Sources and rationale: docs/note-name-rules.md.
 *
 * Applied to names that are CREATED (new note, move destination). Existing
 * files are never judged by it: a note whose name breaks the rule must stay
 * readable and movable, and moving it to a valid name is the repair path.
 */

export const NOTE_NAME_RULES_VERSION = 1 as const;
export const NOTE_NAME_MAX_SEGMENT_BYTES = 255;
/** 260 (MAX_PATH) minus drive, root folder and the terminating NUL of a typical vault root. */
export const NOTE_NAME_MAX_PATH_UNITS = 240;
const NOTE_NAME_MAX_INPUT = 1024;

export const NOTE_NAME_REASON_CODES = [
  "note_name_invalid_type",
  "note_name_empty",
  "note_name_empty_segment",
  "note_name_not_nfc",
  "note_name_control_character",
  "note_name_forbidden_character",
  "note_name_link_character",
  "note_name_invisible_character",
  "note_name_invalid_unicode",
  "note_name_leading_dot",
  "note_name_edge_space",
  "note_name_trailing_dot",
  "note_name_reserved_name",
  "note_name_extension",
  "note_name_segment_too_long",
  "note_name_too_long",
  "note_name_case_collision",
] as const;
export type NoteNameReasonCode = (typeof NOTE_NAME_REASON_CODES)[number];
const REASON_SET: ReadonlySet<string> = new Set(NOTE_NAME_REASON_CODES);
export const isNoteNameReasonCode = (value: unknown): value is NoteNameReasonCode =>
  typeof value === "string" && REASON_SET.has(value);

/** Two short sentences for tool descriptions, so an agent forms a valid name first time. */
export const NOTE_NAME_RULES_DESCRIPTION =
  "Names: no \ : * ? \" < > | # ^ [ ] anywhere, no leading dot or edge space, no invisible or no-break-space character, Unicode NFC, no Windows reserved name (CON, NUL, COM1-9...), at most 255 UTF-8 bytes per name and 240 characters per path; accents, em dashes, typographic apostrophes, middle dots and () are fine. " +
  "A refusal returns reasonCode, hint and a suggestedPath you may resubmit.";

export type NoteNameViolation = {
  reasonCode: NoteNameReasonCode;
  /** Closed vocabulary (see isNoteNameHint); never contains the submitted path. */
  hint: string;
  /** Deterministic valid proposal; absent when no safe automatic fix exists. Nothing is renamed or created. */
  suggestedPath?: string;
  suggestedName?: string;
};
export type NoteNameOptions = {
  /** Required extensions of the last segment; `null` = any. Default `[".md"]`. */
  extensions?: readonly string[] | null;
};
export type NoteNameCheck = { ok: true; path: string } | { ok: false; violation: NoteNameViolation };

export class NoteNameError extends Error {
  constructor(readonly violation: NoteNameViolation) { super(violation.reasonCode); this.name = "NoteNameError"; }
}

// ── Hints ───────────────────────────────────────────────────────────────────
const CHAR_HINTS: Readonly<Record<string, string>> = {
  "\\": "A backslash (\\) is a path separator on Windows and is not allowed in a name; use / between folders.",
  ":": "A colon (:) is not allowed in a name (Windows, macOS, iOS, Android, Obsidian).",
  "*": "An asterisk (*) is not allowed in a name (Windows, Android).",
  "?": "A question mark (?) is not allowed in a name (Windows, Android).",
  "\"": "A double quote (\") is not allowed in a name (Windows, Android).",
  "<": "A less-than sign (<) is not allowed in a name (Windows, Android).",
  ">": "A greater-than sign (>) is not allowed in a name (Windows, Android).",
  "|": "A vertical bar (|) is not allowed in a name (Windows, and it breaks wikilink aliases).",
  "#": "A hash (#) breaks Obsidian links ([[Note#Heading]]); remove it from the name.",
  "^": "A caret (^) breaks Obsidian links ([[Note^block]]); remove it from the name.",
  "[": "An opening bracket ([) breaks Obsidian links; use parentheses instead.",
  "]": "A closing bracket (]) breaks Obsidian links; use parentheses instead.",
  "%%": "A double percent (%%) is an Obsidian comment marker and may break links; remove it from the name.",
};
const FIXED_HINTS = {
  note_name_invalid_type: "The path must be a string.",
  note_name_empty: "The path is empty.",
  note_name_empty_segment: "The path has an empty segment: no leading, trailing or doubled slash.",
  note_name_not_nfc: "The name is not in Unicode NFC (decomposed accents, typical of macOS); use the composed form.",
  note_name_control_character: "A control character (tab, line break, NUL...) is not allowed in a name.",
  note_name_invisible_character: "An invisible or no-break space character (zero-width, direction mark, U+00A0, U+202F...) is not allowed; use a normal space or remove it.",
  note_name_invalid_unicode: "The name contains an invalid Unicode character (lone surrogate, noncharacter or replacement character).",
  note_name_leading_dot: "A name cannot start with a dot (hidden or reserved by Obsidian).",
  note_name_edge_space: "A name cannot start or end with a space (not supported by Windows, and links to it are fragile).",
  note_name_trailing_dot: "A folder name cannot end with a dot or a space (Windows).",
  note_name_reserved_name: "The name is reserved by Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without extension).",
  note_name_extension: "The file name does not end with the required extension.",
  note_name_segment_too_long: "A name is longer than 255 UTF-8 bytes (accents and emoji count for several bytes).",
  note_name_too_long: "The whole path is longer than 240 characters (Windows limit for the vault root included).",
  note_name_case_collision: "A sibling already exists whose name differs only by letter case or Unicode form (Windows and macOS treat them as the same file).",
} as const;
/** Fixed hint of a reason that carries no character detail (used by hosts that detect collisions themselves). */
export const noteNameFixedHint = (code: keyof typeof FIXED_HINTS): string => FIXED_HINTS[code];
const HINT_BASES: ReadonlySet<string> = new Set([...Object.values(CHAR_HINTS), ...Object.values(FIXED_HINTS)]);
const HINT_PATTERN = /^(.*?)(?: \[segment ([1-9][0-9]?)\])?(?: \[(U\+[0-9A-F]{4,6})\])?$/su;
/** True only for hints this module can generate: a fixed sentence plus an optional segment number and code point. */
export function isNoteNameHint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 400) return false;
  const match = HINT_PATTERN.exec(value);
  return !!match && HINT_BASES.has(match[1]);
}
const codePointHex = (cp: number) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
function hint(base: string, segment?: number, codePoint?: number): string {
  return base + (segment !== undefined && segment <= 99 ? ` [segment ${segment}]` : "") +
    (codePoint !== undefined ? ` [${codePointHex(codePoint)}]` : "");
}

// ── Character classes ───────────────────────────────────────────────────────
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const OS_FORBIDDEN = /[\\:*?"<>|]/u;
const LINK_CHARS = /[#^[\]]|%%/u;
const INVISIBLE = /[\p{Zs}\p{Zl}\p{Zp}\p{Cf}ᅟᅠ឴឵⠀ㅤﾠ]/u;
const NOT_PLAIN_SPACE = /[\p{Zs}\p{Zl}\p{Zp}]/u;
const INVALID_UNICODE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ufdd0-\ufdef\ufffe\uffff\ufffd]/;
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)[ ]*(?:\.|$)/iu;
const JOINER_CONTEXT = /[\p{L}\p{M}\p{Extended_Pictographic}️]/u;

/** First code point that is invisible and not a legitimate joiner (ZWNJ/ZWJ between letters, marks or emoji). */
function invisibleAt(segment: string): number | undefined {
  const points = Array.from(segment);
  for (let i = 0; i < points.length; i++) {
    const ch = points[i];
    if (!INVISIBLE.test(ch) || ch === " ") continue;
    const cp = ch.codePointAt(0)!;
    if ((cp === 0x200c || cp === 0x200d) && i > 0 && i < points.length - 1 &&
        JOINER_CONTEXT.test(points[i - 1]) && JOINER_CONTEXT.test(points[i + 1])) continue;
    return cp;
  }
  return undefined;
}
const bytes = (value: string): number => new TextEncoder().encode(value).length;
const normalizedExtensions = (options?: NoteNameOptions): readonly string[] | null =>
  options?.extensions === undefined ? [".md"] : options.extensions;
function extensionOf(segment: string, extensions: readonly string[] | null): string | undefined {
  if (!extensions) return undefined;
  const lower = segment.toLowerCase();
  return extensions.find((ext) => lower.endsWith(ext.toLowerCase()));
}

// ── Check ───────────────────────────────────────────────────────────────────
function violation(code: NoteNameReasonCode, base: string, segment?: number, cp?: number): NoteNameCheck {
  return { ok: false, violation: { reasonCode: code, hint: hint(base, segment, cp) } };
}

function checkRaw(value: unknown, options?: NoteNameOptions): NoteNameCheck {
  if (typeof value !== "string") return violation("note_name_invalid_type", FIXED_HINTS.note_name_invalid_type);
  if (!value) return violation("note_name_empty", FIXED_HINTS.note_name_empty);
  if (value.length > NOTE_NAME_MAX_INPUT) return violation("note_name_too_long", FIXED_HINTS.note_name_too_long);
  if (value !== value.trim()) return violation("note_name_edge_space", FIXED_HINTS.note_name_edge_space);
  if (value.normalize("NFC") !== value) return violation("note_name_not_nfc", FIXED_HINTS.note_name_not_nfc);
  const extensions = normalizedExtensions(options);
  const parts = value.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i], n = i + 1, last = i === parts.length - 1;
    if (!part) return violation("note_name_empty_segment", FIXED_HINTS.note_name_empty_segment, n);
    const control = CONTROL.exec(part);
    if (control) return violation("note_name_control_character", FIXED_HINTS.note_name_control_character, n);
    const forbidden = OS_FORBIDDEN.exec(part);
    if (forbidden) return violation("note_name_forbidden_character", CHAR_HINTS[forbidden[0]], n);
    const link = LINK_CHARS.exec(part);
    if (link) return violation("note_name_link_character", CHAR_HINTS[link[0]], n);
    if (INVALID_UNICODE.test(part)) return violation("note_name_invalid_unicode", FIXED_HINTS.note_name_invalid_unicode, n);
    const invisible = invisibleAt(part);
    if (invisible !== undefined) return violation("note_name_invisible_character", FIXED_HINTS.note_name_invisible_character, n, invisible);
    if (part.startsWith(".")) return violation("note_name_leading_dot", FIXED_HINTS.note_name_leading_dot, n);
    const ext = last ? extensionOf(part, extensions) : undefined;
    const stem = ext ? part.slice(0, part.length - ext.length) : part;
    if (stem.startsWith(" ") || stem.endsWith(" ")) return violation("note_name_edge_space", FIXED_HINTS.note_name_edge_space, n);
    if (/[. ]$/u.test(part)) return violation("note_name_trailing_dot", FIXED_HINTS.note_name_trailing_dot, n);
    if (RESERVED.test(part)) return violation("note_name_reserved_name", FIXED_HINTS.note_name_reserved_name, n);
    if (bytes(part) > NOTE_NAME_MAX_SEGMENT_BYTES) return violation("note_name_segment_too_long", FIXED_HINTS.note_name_segment_too_long, n);
    if (last && extensions && !ext) return violation("note_name_extension", FIXED_HINTS.note_name_extension, n);
  }
  if (value.length > NOTE_NAME_MAX_PATH_UNITS) return violation("note_name_too_long", FIXED_HINTS.note_name_too_long);
  return { ok: true, path: value };
}

// ── Suggestion ──────────────────────────────────────────────────────────────
const REPLACEMENTS: Readonly<Record<string, string>> = {
  ":": " — ", "|": "-", "\"": "'", "[": "(", "]": ")",
  "*": "", "?": "", "<": "", ">": "", "#": "", "^": "",
};

/** Rewrites one segment; spaces created or left next to a changed character are collapsed, untouched text is kept. */
function repairSegment(segment: string): string {
  const points = Array.from(segment.normalize("NFC").replace(/%%/gu, "%"));
  let out = "";
  const space = () => out.endsWith(" ") || out === "";
  for (let i = 0; i < points.length; i++) {
    const ch = points[i], next = points[i + 1];
    let piece: string | undefined;
    if (CONTROL.test(ch) || (NOT_PLAIN_SPACE.test(ch) && ch !== " ")) piece = " ";
    else if (INVALID_UNICODE.test(ch)) piece = "";
    else if (ch === ":" && /[0-9]/u.test(points[i - 1] ?? "") && /[0-9]/u.test(next ?? "")) piece = "-";
    else if (ch in REPLACEMENTS) piece = REPLACEMENTS[ch];
    else if (ch !== " " && INVISIBLE.test(ch)) {
      const cp = ch.codePointAt(0)!;
      const joiner = (cp === 0x200c || cp === 0x200d) && i > 0 && next !== undefined &&
        JOINER_CONTEXT.test(points[i - 1]) && JOINER_CONTEXT.test(next);
      piece = joiner ? undefined : "";
    }
    if (piece === undefined) { out += ch; continue; }
    // The replacement is a repair: do not leave double spaces around it.
    if (piece.startsWith(" ") && space()) piece = piece.slice(1);
    if (piece.endsWith(" ") && next === " ") piece = piece.slice(0, -1);
    if (piece === "" && out.endsWith(" ") && next === " ") { i++; }
    out += piece;
  }
  return out;
}

/**
 * Deterministic valid proposal for a submitted path, or `undefined` when no
 * safe automatic fix exists (empty result, over-long path or name: shortening
 * a title is a decision for the caller). Conforming input is returned as is.
 * Replacement table: `:` becomes " — " (a time `12:30` becomes `12-30`), `|`
 * becomes `-`, `"` becomes `'`, `[ ]` become `( )`, `* ? < > # ^` and `%%`
 * are dropped, `\` becomes `/`, control and no-break spaces become a space,
 * invisible characters are dropped, the result is NFC, edge spaces and
 * leading dots are trimmed, a reserved Windows name gets a `_` suffix and a
 * missing required extension is appended. It never renames or creates anything.
 */
export function suggestNoteName(value: unknown, options?: NoteNameOptions): string | undefined {
  if (typeof value !== "string") return undefined;
  const first = checkRaw(value, options);
  if (first.ok) return value;
  const extensions = normalizedExtensions(options);
  const segments = value.replace(/\\/gu, "/").split("/").map(repairSegment).filter((part) => part.trim() !== "");
  if (!segments.length) return undefined;
  const fixed: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const raw = segments[index], last = index === segments.length - 1;
    const found = last ? extensionOf(raw, extensions) : undefined;
    const ext = found ? raw.slice(raw.length - found.length) : last && extensions ? extensions[0] : "";
    let stem = (found ? raw.slice(0, raw.length - found.length) : raw).replace(/^[. ]+/u, "").trim();
    if (!found && !(last && extensions)) stem = stem.replace(/[. ]+$/u, "");
    if (RESERVED.test(stem + ext)) stem = stem.replace(/^([^. ]+)/u, "$1_");
    if (!stem) return undefined;
    fixed.push(stem + ext);
  }
  const candidate = fixed.join("/");
  const checked = checkRaw(candidate, options);
  return checked.ok ? candidate : undefined;
}

/** Full verdict, with the proposal attached when one exists. */
export function checkNoteName(value: unknown, options?: NoteNameOptions): NoteNameCheck {
  const result = checkRaw(value, options);
  if (result.ok) return result;
  const suggestedPath = suggestNoteName(value, options);
  if (suggestedPath === undefined || suggestedPath === value) return result;
  return { ok: false, violation: { ...result.violation, suggestedPath, suggestedName: suggestedPath.slice(suggestedPath.lastIndexOf("/") + 1) } };
}

/** Returns the path unchanged or throws NoteNameError (closed reason, hint, suggestion). */
export function assertNoteName(value: unknown, options?: NoteNameOptions): string {
  const result = checkNoteName(value, options);
  if (!result.ok) throw new NoteNameError(result.violation);
  return result.path;
}

// ── Collisions ──────────────────────────────────────────────────────────────
/** Key under which Windows (NTFS) and macOS (APFS default) consider two names the same file. */
export const noteNameFoldKey = (name: string): string => name.normalize("NFC").toLowerCase();
/** True when a sibling differs from `name` only by case or Unicode form (an exact twin is "exists", not a collision). */
export function hasFoldedNameCollision(name: string, siblings: Iterable<string>): boolean {
  const key = noteNameFoldKey(name);
  for (const sibling of siblings) if (sibling !== name && noteNameFoldKey(sibling) === key) return true;
  return false;
}
