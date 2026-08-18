import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve("src/mcp-server");

function listTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}

const registrations = [];
const missingAnnotations = [];

for (const file of listTypeScriptFiles(sourceRoot)) {
  const sourceText = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "tool" ||
        node.expression.name.text === "registerTool")
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const registration = {
        file: path.relative(process.cwd(), file),
        line,
        argumentCount: node.arguments.length,
        name:
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])
            ? node.arguments[0].text
            : undefined,
      };
      registrations.push(registration);
      if (
        node.expression.name.text === "tool" &&
        node.arguments.length < 5
      ) {
        missingAnnotations.push(registration);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (missingAnnotations.length > 0) {
  throw new Error(
    `MCP tools without annotations:\n${missingAnnotations
      .map((item) => `- ${item.file}:${item.line}`)
      .join("\n")}`,
  );
}

const governedToolNames = [
  "obsidian_note_replace_plan",
  "obsidian_note_replace_apply",
  "obsidian_note_replace_status",
  "obsidian_note_replace_recover",
  "obsidian_frontmatter_patch_plan",
  "obsidian_frontmatter_patch_apply",
  "obsidian_frontmatter_patch_status",
  "obsidian_frontmatter_patch_recover",
  "bases_formula_patch_plan",
  "bases_formula_patch_apply",
  "bases_formula_patch_status",
  "bases_formula_patch_recover",
  "obsidian_canvas_patch_plan",
  "obsidian_canvas_patch_apply",
  "obsidian_canvas_patch_status",
  "obsidian_canvas_patch_recover",
];
for (const name of governedToolNames) {
  const matches = registrations.filter((item) => item.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one public registration for ${name}, found ${matches.length}`,
    );
  }
}

const semanticMatches = registrations.filter(
  (item) => item.name === "smart_semantic_search",
);
if (semanticMatches.length !== 1) {
  throw new Error(
    `Expected exactly one smart_semantic_search registration, found ${semanticMatches.length}`,
  );
}
for (const removedAlias of ["smart_search", "smart-search"]) {
  if (registrations.some((item) => item.name === removedAlias)) {
    throw new Error(
      `Semantic-search alias must be physically absent in V3: ${removedAlias}`,
    );
  }
}

for (const name of [
  "operation_plan",
  "operation_apply",
  "operation_status",
  "operation_recover",
]) {
  if (registrations.some((item) => item.name === name)) {
    throw new Error(`Generic operation surface must remain internal: ${name}`);
  }
}

console.log(
  `PASS: ${registrations.length} MCP tool registrations include annotations; V3 semantic search is canonical-only; governed note/frontmatter/Base/Canvas tools are unique; generic operation tools remain internal`,
);
