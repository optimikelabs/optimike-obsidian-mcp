import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : "npm";
const args = npmCli
  ? [npmCli, "pack", "--dry-run", "--json"]
  : ["pack", "--dry-run", "--json"];
const output = execFileSync(command, args, {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

const report = JSON.parse(output);
const files = new Set(
  report.flatMap((entry) => entry.files.map((file) => file.path)),
);
const requiredFiles = [
  "dist/index.js",
  "dist/stdio-proxy.js",
  "README.md",
  "README.fr.md",
  "SECURITY.md",
  "SECURITY.fr.md",
  "docs/README.md",
  "docs/README.fr.md",
  "docs/governed-note-replacement.md",
  "docs/governed-note-replacement.fr.md",
  "docs/governed-frontmatter-p1.md",
  "docs/governed-frontmatter-p1.fr.md",
  "docs/adr/ADR-Governed-Frontmatter-P1.md",
  "docs/adr/README.md",
  "scripts/test-governed-note-replace-mcp.mjs",
  "scripts/test-governed-note-replace-http.mjs",
  "scripts/smoke-atomic-note-mcp-live.mjs",
  "scripts/test-frontmatter-p1-idempotency.mjs",
  "scripts/test-governed-frontmatter-mcp.mjs",
  "scripts/test-governed-frontmatter-http.mjs",
  "scripts/smoke-governed-frontmatter-live.mjs",
  "plugins/obsidian-bases-bridge/build/main.js",
  "plugins/obsidian-bases-bridge/build/manifest.json",
  "plugins/obsidian-atomic-write-bridge/build/main.js",
  "plugins/obsidian-atomic-write-bridge/build/manifest.json",
  "plugins/obsidian-operon-bridge/build/main.js",
  "plugins/obsidian-operon-bridge/build/manifest.json",
];

const missing = requiredFiles.filter((file) => !files.has(file));
if (missing.length > 0) {
  throw new Error(
    `Package is missing installable Bridge artifacts: ${missing.join(", ")}`,
  );
}

console.log(
  `PASS: package contains ${requiredFiles.length} runnable server, governed-operation, documentation and Bridge artifacts`,
);
