import { load } from "js-yaml";
import { extractMarkdownTags } from "./vaultFileService.js";

export type ObsidianFormatKind = "markdown" | "base" | "canvas";

export type FormatIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
};

export type FormatValidationResult = {
  ok: boolean;
  kind: ObsidianFormatKind;
  errors: FormatIssue[];
  warnings: FormatIssue[];
  stats: Record<string, unknown>;
  limitations: string[];
};

const CALLOUT_TYPES = new Set([
  "abstract",
  "bug",
  "danger",
  "error",
  "example",
  "fail",
  "failure",
  "faq",
  "help",
  "hint",
  "important",
  "info",
  "missing",
  "note",
  "question",
  "quote",
  "success",
  "summary",
  "tip",
  "todo",
  "warning",
]);

const TAG_PATTERN = /^[A-Za-z_][A-Za-z0-9_/-]*$/u;
const CANVAS_NODE_TYPES = new Set(["text", "file", "link", "group"]);
const CANVAS_SIDES = new Set(["top", "right", "bottom", "left"]);

function splitIssues(issues: FormatIssue[]): {
  errors: FormatIssue[];
  warnings: FormatIssue[];
} {
  return {
    errors: issues.filter((issue) => issue.severity === "error"),
    warnings: issues.filter((issue) => issue.severity === "warning"),
  };
}

function addIssue(
  issues: FormatIssue[],
  severity: FormatIssue["severity"],
  code: string,
  message: string,
  path?: string,
): void {
  issues.push({ severity, code, message, path });
}

function readYamlFrontmatter(content: string): {
  frontmatter?: Record<string, unknown>;
  body: string;
  issues: FormatIssue[];
} {
  const issues: FormatIssue[] = [];
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!match) {
    return { body: content, issues };
  }
  try {
    const parsed = load(match[1]);
    if (parsed && (typeof parsed !== "object" || Array.isArray(parsed))) {
      addIssue(
        issues,
        "error",
        "frontmatter-not-object",
        "Frontmatter must be a YAML object.",
        "frontmatter",
      );
    }
    return {
      frontmatter:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      body: content.slice(match[0].length),
      issues,
    };
  } catch (error) {
    addIssue(
      issues,
      "error",
      "frontmatter-yaml-invalid",
      error instanceof Error ? error.message : String(error),
      "frontmatter",
    );
    return { body: content.slice(match[0].length), issues };
  }
}

function collectStringsAndKeys(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectStringsAndKeys(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.flatMap(([key, child]) => [
      key,
      ...collectStringsAndKeys(child, `${path}.${key}`),
    ]);
  }
  return [];
}

export function validateObsidianMarkdown(
  content: string,
): FormatValidationResult {
  const issues: FormatIssue[] = [];
  const {
    frontmatter,
    body,
    issues: frontmatterIssues,
  } = readYamlFrontmatter(content);
  issues.push(...frontmatterIssues);

  const tags = extractMarkdownTags(content);
  for (const tag of tags.allTags) {
    if (!TAG_PATTERN.test(tag)) {
      addIssue(
        issues,
        "warning",
        "tag-syntax",
        `Tag "${tag}" is outside the conservative Obsidian tag pattern.`,
        "tags",
      );
    }
  }

  if (frontmatter && "tags" in frontmatter) {
    const rawTags = frontmatter.tags;
    if (
      typeof rawTags !== "string" &&
      !Array.isArray(rawTags) &&
      rawTags !== null
    ) {
      addIssue(
        issues,
        "warning",
        "frontmatter-tags-shape",
        "Frontmatter tags should be a string or an array.",
        "frontmatter.tags",
      );
    }
  }

  const wikilinks = [...body.matchAll(/!?\[\[([^\]]*)\]\]/gu)].map(
    (match) => match[1],
  );
  for (const wikilink of wikilinks) {
    if (!wikilink.trim()) {
      addIssue(
        issues,
        "warning",
        "empty-wikilink",
        "Wikilink target is empty.",
        "body",
      );
    }
  }

  const openingLinks = (body.match(/\[\[/gu) ?? []).length;
  const closingLinks = (body.match(/\]\]/gu) ?? []).length;
  if (openingLinks !== closingLinks) {
    addIssue(
      issues,
      "error",
      "wikilink-unbalanced",
      "Wikilink delimiters are unbalanced.",
      "body",
    );
  }

  const fenceCount = (body.match(/```/gu) ?? []).length;
  if (fenceCount % 2 !== 0) {
    addIssue(
      issues,
      "error",
      "code-fence-unbalanced",
      "Markdown code fences are unbalanced.",
      "body",
    );
  }

  const callouts = [...body.matchAll(/^>\s*\[!([A-Za-z0-9_-]+)\]/gmu)].map(
    (match) => match[1].toLowerCase(),
  );
  for (const callout of callouts) {
    if (!CALLOUT_TYPES.has(callout)) {
      addIssue(
        issues,
        "warning",
        "unknown-callout",
        `Callout type "${callout}" is not in the common Obsidian callout set.`,
        "body",
      );
    }
  }

  const { errors, warnings } = splitIssues(issues);
  return {
    ok: errors.length === 0,
    kind: "markdown",
    errors,
    warnings,
    stats: {
      frontmatter: Boolean(frontmatter),
      frontmatterTags: tags.frontmatterTags.length,
      inlineTags: tags.inlineTags.length,
      wikilinks: wikilinks.length,
      embeds: (body.match(/!\[\[/gu) ?? []).length,
      callouts: callouts.length,
    },
    limitations: [
      "This validates conservative Obsidian Markdown syntax; it does not render the note or resolve links against the Obsidian index.",
    ],
  };
}

export function validateObsidianBase(content: string): FormatValidationResult {
  const issues: FormatIssue[] = [];
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch (error) {
    addIssue(
      issues,
      "error",
      "base-yaml-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  const root =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (!root && parsed !== undefined) {
    addIssue(
      issues,
      "error",
      "base-not-object",
      ".base content must be a YAML object.",
    );
  }

  const formulas =
    root?.formulas &&
    typeof root.formulas === "object" &&
    !Array.isArray(root.formulas)
      ? (root.formulas as Record<string, unknown>)
      : {};
  const formulaNames = new Set(Object.keys(formulas));
  const formulaRefs = new Set<string>();
  for (const value of collectStringsAndKeys(root ?? {})) {
    for (const match of value.matchAll(/formula\.([A-Za-z0-9_-]+)/gu)) {
      formulaRefs.add(match[1]);
    }
  }
  for (const ref of formulaRefs) {
    if (!formulaNames.has(ref)) {
      addIssue(
        issues,
        "warning",
        "base-undefined-formula",
        `formula.${ref} is referenced but not defined in formulas.`,
        "formulas",
      );
    }
  }

  const views = Array.isArray(root?.views) ? root.views : [];
  if (!Array.isArray(root?.views)) {
    addIssue(
      issues,
      "warning",
      "base-views-missing",
      ".base files should define a views array.",
      "views",
    );
  }
  for (const [index, view] of views.entries()) {
    if (!view || typeof view !== "object" || Array.isArray(view)) {
      addIssue(
        issues,
        "error",
        "base-view-not-object",
        "Each Base view must be an object.",
        `views[${index}]`,
      );
      continue;
    }
    const viewType = (view as Record<string, unknown>).type;
    if (
      typeof viewType !== "string" ||
      !["table", "cards", "list", "map"].includes(viewType)
    ) {
      addIssue(
        issues,
        "error",
        "base-view-type",
        "Base view type must be one of table, cards, list, or map.",
        `views[${index}].type`,
      );
    }
  }

  const { errors, warnings } = splitIssues(issues);
  return {
    ok: errors.length === 0,
    kind: "base",
    errors,
    warnings,
    stats: {
      views: views.length,
      formulas: formulaNames.size,
      formulaReferences: formulaRefs.size,
      hasFilters: Boolean(root?.filters),
      hasProperties: Boolean(root?.properties),
    },
    limitations: [
      "This validates YAML shape and common references; it does not evaluate Obsidian formulas, filters, summaries, or UI rendering.",
    ],
  };
}

export function validateJsonCanvas(content: string): FormatValidationResult {
  const issues: FormatIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    addIssue(
      issues,
      "error",
      "canvas-json-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  const root =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (!root && parsed !== undefined) {
    addIssue(
      issues,
      "error",
      "canvas-not-object",
      "Canvas content must be a JSON object.",
    );
  }

  const nodes = Array.isArray(root?.nodes) ? root.nodes : [];
  const edges = Array.isArray(root?.edges) ? root.edges : [];
  if (root && !Array.isArray(root.nodes)) {
    addIssue(
      issues,
      "warning",
      "canvas-nodes-missing",
      "Canvas should define a nodes array.",
      "nodes",
    );
  }
  if (root && !Array.isArray(root.edges)) {
    addIssue(
      issues,
      "warning",
      "canvas-edges-missing",
      "Canvas should define an edges array.",
      "edges",
    );
  }

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    const item = node as Record<string, unknown>;
    const nodePath = `nodes[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      addIssue(
        issues,
        "error",
        "canvas-node-not-object",
        "Canvas node must be an object.",
        nodePath,
      );
      continue;
    }
    const id = item.id;
    if (typeof id !== "string" || !id) {
      addIssue(
        issues,
        "error",
        "canvas-node-id",
        "Canvas node must have a non-empty string id.",
        `${nodePath}.id`,
      );
    } else {
      if (nodeIds.has(id)) {
        addIssue(
          issues,
          "error",
          "canvas-node-id-duplicate",
          `Duplicate node id "${id}".`,
          `${nodePath}.id`,
        );
      }
      if (!/^[a-f0-9]{16}$/iu.test(id)) {
        addIssue(
          issues,
          "warning",
          "canvas-node-id-shape",
          `Node id "${id}" is not a 16-character hex id.`,
          `${nodePath}.id`,
        );
      }
      nodeIds.add(id);
    }
    if (typeof item.type !== "string" || !CANVAS_NODE_TYPES.has(item.type)) {
      addIssue(
        issues,
        "error",
        "canvas-node-type",
        "Canvas node type must be text, file, link, or group.",
        `${nodePath}.type`,
      );
    }
    for (const field of ["x", "y", "width", "height"]) {
      if (typeof item[field] !== "number") {
        addIssue(
          issues,
          "error",
          "canvas-node-geometry",
          `Canvas node field ${field} must be a number.`,
          `${nodePath}.${field}`,
        );
      }
    }
    if (item.type === "text" && typeof item.text !== "string") {
      addIssue(
        issues,
        "error",
        "canvas-text-node-text",
        "Text nodes must include string text.",
        `${nodePath}.text`,
      );
    }
    if (item.type === "file" && typeof item.file !== "string") {
      addIssue(
        issues,
        "error",
        "canvas-file-node-file",
        "File nodes must include string file.",
        `${nodePath}.file`,
      );
    }
    if (item.type === "link" && typeof item.url !== "string") {
      addIssue(
        issues,
        "error",
        "canvas-link-node-url",
        "Link nodes must include string url.",
        `${nodePath}.url`,
      );
    }
  }

  for (const [index, edge] of edges.entries()) {
    const item = edge as Record<string, unknown>;
    const edgePath = `edges[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      addIssue(
        issues,
        "error",
        "canvas-edge-not-object",
        "Canvas edge must be an object.",
        edgePath,
      );
      continue;
    }
    const id = item.id;
    if (typeof id === "string" && id) {
      if (edgeIds.has(id)) {
        addIssue(
          issues,
          "error",
          "canvas-edge-id-duplicate",
          `Duplicate edge id "${id}".`,
          `${edgePath}.id`,
        );
      }
      edgeIds.add(id);
    }
    for (const field of ["fromNode", "toNode"]) {
      if (
        typeof item[field] !== "string" ||
        !nodeIds.has(String(item[field]))
      ) {
        addIssue(
          issues,
          "error",
          "canvas-edge-node-reference",
          `${field} must reference an existing node id.`,
          `${edgePath}.${field}`,
        );
      }
    }
    for (const field of ["fromSide", "toSide"]) {
      if (
        item[field] !== undefined &&
        (typeof item[field] !== "string" ||
          !CANVAS_SIDES.has(String(item[field])))
      ) {
        addIssue(
          issues,
          "warning",
          "canvas-edge-side",
          `${field} should be top, right, bottom, or left.`,
          `${edgePath}.${field}`,
        );
      }
    }
  }

  const { errors, warnings } = splitIssues(issues);
  return {
    ok: errors.length === 0,
    kind: "canvas",
    errors,
    warnings,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      groups: nodes.filter(
        (node) => (node as Record<string, unknown>).type === "group",
      ).length,
    },
    limitations: [
      "This validates JSON Canvas structure and references; it does not render layout or verify referenced vault files/URLs.",
    ],
  };
}

export function validateObsidianFormat(
  kind: ObsidianFormatKind,
  content: string,
): FormatValidationResult {
  if (kind === "markdown") return validateObsidianMarkdown(content);
  if (kind === "base") return validateObsidianBase(content);
  return validateJsonCanvas(content);
}
