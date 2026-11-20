/**
 * Vault-aware inspection of candidate Markdown, computed inside Obsidian.
 *
 * Read-only and bounded: it parses the candidate (and the current file, when
 * one exists) itself, then asks the public metadata cache about link targets.
 * It never walks the object graph, never returns the vault's callout or type
 * lists, and reports only problems the candidate introduces.
 */

export const NOTE_INSPECT_CONTRACT_VERSION = 1 as const;
/** Wikilinks/embeds/frontmatter links checked per document; the rest is reported as truncated. */
export const NOTE_INSPECT_MAX_REFERENCES = 2000;
export const NOTE_INSPECT_MAX_FINDINGS = 100;
export const NOTE_INSPECT_MAX_SUGGESTIONS = 3;
/** Upper bound on CSS rules visited when the callout catalog is rebuilt. */
export const CALLOUT_SCAN_MAX_RULES = 200_000;
const CALLOUT_SCAN_MAX_DEPTH = 16;

/** Callout types Obsidian defines in core, kept as a floor if a stylesheet is unreadable. */
export const CORE_CALLOUT_TYPES = [
  "abstract", "attention", "bug", "caution", "check", "cite", "danger", "done",
  "error", "example", "fail", "failure", "faq", "help", "hint", "important",
  "info", "missing", "note", "question", "quote", "success", "summary", "tip",
  "tldr", "todo", "warning",
] as const;

export type NoteInspectFindingCode =
  | "link-unresolved"
  | "embed-unresolved"
  | "link-heading-missing"
  | "link-block-missing"
  | "unknown-callout"
  | "property-type-mismatch";

export type NoteInspectFinding = {
  code: NoteInspectFindingCode;
  severity: "error" | "warning";
  location: "body" | "frontmatter";
  /** 1-based line in the candidate content. */
  line: number;
  /** Link text as written (no alias), callout type, or property key. Never a property value. */
  target: string;
  declaredType?: string;
  suggestions?: string[];
};

export type NoteInspectResult = {
  findings: NoteInspectFinding[];
  coverage: {
    references: { checked: number; truncated: boolean };
    findings: { total: number; returned: number; truncated: boolean };
    callouts: { source: "stylesheets"; partialSelectors: boolean };
    properties: { source: "metadataTypeManager" | "types.json" | "unavailable" };
  };
};

type SubpathResultLike = { type: string } | null;
type CacheLike = unknown;
type FileLike = { path: string };

export type NoteInspectApp = {
  metadataCache: {
    getFirstLinkpathDest(linkpath: string, sourcePath: string): FileLike | null;
    getFileCache(file: FileLike): CacheLike | null;
  };
  vault: {
    configDir: string;
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: FileLike): Promise<string>;
    adapter: { read(path: string): Promise<string> };
  };
  metadataTypeManager?: { getAssignedWidget?: (key: string) => unknown };
};

type CssRuleLike = {
  selectorText?: unknown;
  cssRules?: ArrayLike<CssRuleLike> | null;
  styleSheet?: StyleSheetLike | null;
};
export type StyleSheetLike = { readonly cssRules: ArrayLike<CssRuleLike> };

export type NoteInspectDeps = {
  app: NoteInspectApp;
  styleSheets(): ArrayLike<StyleSheetLike>;
  isFile(value: unknown): value is FileLike;
  parseLinktext(linktext: string): { path: string; subpath: string };
  parseYaml(yaml: string): unknown;
  resolveSubpath(cache: CacheLike, subpath: string): SubpathResultLike;
};

export type NoteInspectInput = {
  path?: string;
  content: string;
  baseline: "current_file" | "none";
};

export type CalloutCatalog = {
  exact: Set<string>;
  contains: string[];
  prefixes: string[];
  suffixes: string[];
  partial: boolean;
};

const SELECTOR_PATTERN =
  /\[\s*data-callout\s*([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))\s*(?:[iIsS]\s*)?\]/gu;

/** Collect `data-callout` attribute selectors from loaded stylesheets, bounded. */
export function scanCalloutStylesheets(
  sheets: ArrayLike<StyleSheetLike>,
  maxRules = CALLOUT_SCAN_MAX_RULES,
): CalloutCatalog {
  const catalog: CalloutCatalog = {
    exact: new Set(CORE_CALLOUT_TYPES),
    contains: [],
    prefixes: [],
    suffixes: [],
    partial: false,
  };
  let visited = 0;
  const visit = (rules: ArrayLike<CssRuleLike> | null | undefined, depth: number) => {
    if (!rules || depth > CALLOUT_SCAN_MAX_DEPTH) return;
    for (let index = 0; index < rules.length; index += 1) {
      if (visited >= maxRules) return;
      visited += 1;
      const rule = rules[index];
      if (!rule) continue;
      if (typeof rule.selectorText === "string" && rule.selectorText.includes("data-callout")) {
        for (const match of rule.selectorText.matchAll(SELECTOR_PATTERN)) {
          const value = (match[2] ?? match[3] ?? match[4] ?? "").trim().toLowerCase();
          if (!value) continue;
          const operator = match[1];
          if (operator === "*=") catalog.contains.push(value);
          else if (operator === "^=") catalog.prefixes.push(value);
          else if (operator === "$=") catalog.suffixes.push(value);
          else {
            catalog.exact.add(value);
            if (operator === "|=") catalog.prefixes.push(`${value}-`);
          }
        }
      }
      if (rule.cssRules) visit(rule.cssRules, depth + 1);
      if (rule.styleSheet) visit(readRules(rule.styleSheet), depth + 1);
    }
  };
  for (let index = 0; index < sheets.length && visited < maxRules; index += 1) {
    visit(readRules(sheets[index]), 0);
  }
  catalog.contains = [...new Set(catalog.contains)];
  catalog.prefixes = [...new Set(catalog.prefixes)];
  catalog.suffixes = [...new Set(catalog.suffixes)];
  catalog.partial = catalog.contains.length + catalog.prefixes.length + catalog.suffixes.length > 0;
  return catalog;
}

function readRules(sheet: StyleSheetLike | null | undefined): ArrayLike<CssRuleLike> | null {
  try {
    // Cross-origin sheets throw on access; they cannot define vault callouts.
    return sheet?.cssRules ?? null;
  } catch {
    return null;
  }
}

function calloutKnown(catalog: CalloutCatalog, type: string): boolean {
  return (
    catalog.exact.has(type) ||
    catalog.contains.some((part) => type.includes(part)) ||
    catalog.prefixes.some((part) => type.startsWith(part)) ||
    catalog.suffixes.some((part) => type.endsWith(part))
  );
}

function editDistance(left: string, right: string, ceiling: number): number {
  if (Math.abs(left.length - right.length) > ceiling) return ceiling + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > ceiling) return ceiling + 1;
    previous = current;
  }
  return previous[right.length];
}

export function suggestCalloutTypes(catalog: CalloutCatalog, type: string): string[] {
  const ceiling = Math.max(2, Math.floor(type.length / 3));
  return [...catalog.exact]
    .map((candidate) => ({ candidate, distance: editDistance(type, candidate, ceiling) }))
    .filter((entry) => entry.distance <= ceiling)
    .sort((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0))
    .slice(0, NOTE_INSPECT_MAX_SUGGESTIONS)
    .map((entry) => entry.candidate);
}

type PropertyTypes = {
  source: NoteInspectResult["coverage"]["properties"]["source"];
  lookup(key: string): string | null;
};

/** Declared property types: the live type manager, else `.obsidian/types.json`. */
export async function loadPropertyTypes(app: NoteInspectApp): Promise<PropertyTypes> {
  const manager = app.metadataTypeManager;
  if (manager && typeof manager.getAssignedWidget === "function") {
    const getAssignedWidget = manager.getAssignedWidget.bind(manager);
    return {
      source: "metadataTypeManager",
      lookup: (key) => {
        const type = getAssignedWidget(key);
        return typeof type === "string" && type ? type.toLowerCase() : null;
      },
    };
  }
  try {
    const raw = JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/types.json`)) as {
      types?: Record<string, unknown>;
    };
    const declared = new Map<string, string>();
    for (const [key, type] of Object.entries(raw?.types ?? {})) {
      if (typeof type === "string" && type) declared.set(key.toLowerCase(), type.toLowerCase());
    }
    return { source: "types.json", lookup: (key) => declared.get(key.toLowerCase()) ?? null };
  } catch {
    return { source: "unavailable", lookup: () => null };
  }
}

function validDate(year: string, month: string, day: string, hour = "0", minute = "0", second = "0"): boolean {
  const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  return (
    date.getUTCFullYear() === +year && date.getUTCMonth() === +month - 1 && date.getUTCDate() === +day &&
    date.getUTCHours() === +hour && date.getUTCMinutes() === +minute && date.getUTCSeconds() === +second
  );
}

/** Whether a value fits a declared type. Empty values and text-like types always fit. */
export function valueFitsType(type: string, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (value instanceof Date) return type !== "number" && type !== "checkbox" && !Number.isNaN(value.getTime());
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "date": {
      const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value) : null;
      return !!match && validDate(match[1], match[2], match[3]);
    }
    case "datetime": {
      const match = typeof value === "string"
        ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/u.exec(value)
        : null;
      return !!match && validDate(match[1], match[2], match[3], match[4], match[5], match[6]);
    }
    case "multitext":
    case "tags":
    case "aliases":
      // Obsidian reads a single string as a one-item list.
      return typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
    default:
      return true;
  }
}

type Document = {
  frontmatter: Record<string, unknown> | null;
  frontmatterLines: string[];
  body: string;
  bodyStartLine: number;
  bodyStartOffset: number;
  headings: Array<{ heading: string; level: number; line: number; offset: number; length: number }>;
  blocks: Array<{ id: string; line: number; offset: number; length: number }>;
};

function maskCode(text: string): string {
  const lines = text.split("\n");
  let fence: { char: string; size: number } | null = null;
  const masked = lines.map((line) => {
    const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence.char && opener[1].length >= fence.size && line.trim() === opener[1].trim()) {
        fence = null;
      }
      return " ".repeat(line.length);
    }
    if (opener) {
      fence = { char: opener[1][0], size: opener[1].length };
      return " ".repeat(line.length);
    }
    return line.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, (span) => " ".repeat(span.length));
  });
  return masked
    .join("\n")
    .replace(/%%[\s\S]*?%%/gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function parseDocument(content: string, parseYaml: NoteInspectDeps["parseYaml"]): Document {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterLines: string[] = [];
  if (match) {
    frontmatterLines = match[1].split(/\r?\n/u);
    try {
      const parsed = parseYaml(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      // The static validator reports invalid YAML; vault checks skip it.
    }
  }
  const bodyStartOffset = match ? match[0].length : 0;
  const bodyStartLine = (content.slice(0, bodyStartOffset).match(/\n/gu)?.length ?? 0) + 1;
  const body = content.slice(bodyStartOffset);
  const masked = maskCode(body);
  const headings: Document["headings"] = [];
  const blocks: Document["blocks"] = [];
  let offset = bodyStartOffset;
  masked.split("\n").forEach((line, index) => {
    const lineNumber = bodyStartLine + index;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line.replace(/\r$/u, ""));
    if (heading) {
      headings.push({ heading: heading[2].trim(), level: heading[1].length, line: lineNumber, offset, length: line.length });
    }
    const block = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/u.exec(line);
    if (block) blocks.push({ id: block[1].toLowerCase(), line: lineNumber, offset, length: line.length });
    offset += line.length + 1;
  });
  return { frontmatter, frontmatterLines, body: masked, bodyStartLine, bodyStartOffset, headings, blocks };
}

/** A metadata-cache-shaped view of the candidate, so self links use Obsidian's own subpath rules. */
function documentCache(document: Document): CacheLike {
  const position = (line: number, offset: number, length: number) => ({
    start: { line: line - 1, col: 0, offset },
    end: { line: line - 1, col: length, offset: offset + length },
  });
  return {
    headings: document.headings.map((item) => ({
      heading: item.heading,
      level: item.level,
      position: position(item.line, item.offset, item.length),
    })),
    blocks: Object.fromEntries(
      document.blocks.map((item) => [item.id, { id: item.id, position: position(item.line, item.offset, item.length) }]),
    ),
  };
}

type Reference = { kind: "link" | "embed" | "frontmatter"; text: string; line: number };

function referencesOf(document: Document): Reference[] {
  const references: Reference[] = [];
  const lines = document.body.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/gu)) {
      references.push({ kind: match[1] ? "embed" : "link", text: match[2], line: document.bodyStartLine + index });
    }
  });
  if (document.frontmatter) {
    for (const [key, value] of Object.entries(document.frontmatter)) {
      const line = frontmatterLine(document, key);
      for (const text of collectStrings(value)) {
        for (const match of text.matchAll(/\[\[([^[\]\n]+?)\]\]/gu)) {
          references.push({ kind: "frontmatter", text: match[1], line });
        }
      }
    }
  }
  return references;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  return [];
}

function frontmatterLine(document: Document, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^(["']?)${escaped}\\1\\s*:`, "u");
  const index = document.frontmatterLines.findIndex((line) => pattern.test(line));
  return index < 0 ? 1 : index + 2;
}

type Check = { finding: NoteInspectFinding; identity: string };

function analyse(
  deps: NoteInspectDeps,
  content: string,
  sourcePath: string,
  callouts: CalloutCatalog,
  types: PropertyTypes,
): { checks: Check[]; referencesChecked: number; truncated: boolean } {
  const document = parseDocument(content, deps.parseYaml);
  const checks: Check[] = [];
  const references = referencesOf(document);
  const truncated = references.length > NOTE_INSPECT_MAX_REFERENCES;
  const selfCache = documentCache(document);
  const { metadataCache } = deps.app;
  const resolved = new Map<string, { path: string | null; cache: CacheLike | null }>();

  for (const reference of references.slice(0, NOTE_INSPECT_MAX_REFERENCES)) {
    const linktext = reference.text.split("|")[0].replace(/\\$/u, "").trim();
    if (!linktext) continue;
    const parsed = deps.parseLinktext(linktext);
    const location = reference.kind === "frontmatter" ? "frontmatter" : "body";
    let target = resolved.get(parsed.path);
    if (!target) {
      if (!parsed.path) {
        target = { path: sourcePath, cache: selfCache };
      } else {
        const file = metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
        target = file
          ? { path: file.path, cache: file.path === sourcePath ? selfCache : metadataCache.getFileCache(file) }
          : { path: null, cache: null };
      }
      resolved.set(parsed.path, target);
    }
    if (target.path === null) {
      const code = reference.kind === "embed" ? "embed-unresolved" : "link-unresolved";
      checks.push({
        identity: `${code}\0${parsed.path.toLowerCase()}`,
        finding: { code, severity: code === "embed-unresolved" ? "error" : "warning", location, line: reference.line, target: linktext },
      });
      continue;
    }
    const subpath = parsed.subpath.replace(/^#/u, "");
    if (!subpath || !target.cache) continue;
    if (deps.resolveSubpath(target.cache, parsed.subpath)) continue;
    const code = subpath.startsWith("^") ? "link-block-missing" : "link-heading-missing";
    checks.push({
      identity: `${code}\0${target.path.toLowerCase()}\0${subpath.toLowerCase()}`,
      finding: { code, severity: "error", location, line: reference.line, target: linktext },
    });
  }

  document.body.split("\n").forEach((line, index) => {
    const match = /^(?:[ \t]*>[ \t]?)+[ \t]*\[!([^\]\s]+)\]/u.exec(line);
    if (!match) return;
    const type = match[1].toLowerCase();
    if (calloutKnown(callouts, type)) return;
    const suggestions = suggestCalloutTypes(callouts, type);
    checks.push({
      identity: `unknown-callout\0${type}`,
      finding: {
        code: "unknown-callout",
        severity: "warning",
        location: "body",
        line: document.bodyStartLine + index,
        target: type,
        ...(suggestions.length ? { suggestions } : {}),
      },
    });
  });

  for (const [key, value] of Object.entries(document.frontmatter ?? {})) {
    const declaredType = types.lookup(key);
    if (!declaredType || valueFitsType(declaredType, value)) continue;
    checks.push({
      identity: `property-type-mismatch\0${key.toLowerCase()}\0${declaredType}\0${fingerprint(value)}`,
      finding: {
        code: "property-type-mismatch",
        severity: "error",
        location: "frontmatter",
        line: frontmatterLine(document, key),
        target: key,
        declaredType,
      },
    });
  }

  return { checks, referencesChecked: Math.min(references.length, NOTE_INSPECT_MAX_REFERENCES), truncated };
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function createNoteInspector(deps: NoteInspectDeps) {
  let callouts: CalloutCatalog | null = null;
  return {
    /** Drop the cached callout catalog; call on Obsidian `css-change`. */
    invalidateCallouts(): void {
      callouts = null;
    },
    async inspect(input: NoteInspectInput): Promise<NoteInspectResult & { baseline: "current_file" | "none" }> {
      callouts ??= scanCalloutStylesheets(deps.styleSheets());
      const types = await loadPropertyTypes(deps.app);
      const sourcePath = input.path ?? "";
      let baselineContent: string | null = null;
      if (input.path && input.baseline === "current_file") {
        const existing = deps.app.vault.getAbstractFileByPath(input.path);
        if (deps.isFile(existing)) baselineContent = await deps.app.vault.cachedRead(existing);
      }
      const candidate = analyse(deps, input.content, sourcePath, callouts, types);
      const known = new Map<string, number>();
      if (baselineContent !== null) {
        for (const check of analyse(deps, baselineContent, sourcePath, callouts, types).checks) {
          known.set(check.identity, (known.get(check.identity) ?? 0) + 1);
        }
      }
      const introduced: NoteInspectFinding[] = [];
      for (const check of candidate.checks) {
        const remaining = known.get(check.identity) ?? 0;
        if (remaining > 0) {
          known.set(check.identity, remaining - 1);
          continue;
        }
        introduced.push(check.finding);
      }
      const findings = introduced.slice(0, NOTE_INSPECT_MAX_FINDINGS);
      return {
        baseline: baselineContent === null ? "none" : "current_file",
        findings,
        coverage: {
          references: { checked: candidate.referencesChecked, truncated: candidate.truncated },
          findings: { total: introduced.length, returned: findings.length, truncated: introduced.length > findings.length },
          callouts: { source: "stylesheets", partialSelectors: callouts.partial },
          properties: { source: types.source },
        },
      };
    },
  };
}
