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
      node.expression.name.text === "tool"
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const registration = {
        file: path.relative(process.cwd(), file),
        line,
        argumentCount: node.arguments.length,
      };
      registrations.push(registration);
      if (node.arguments.length < 5) missingAnnotations.push(registration);
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

console.log(`PASS: ${registrations.length} MCP tool registrations include annotations`);
