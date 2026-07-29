import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const assetsDir = path.join(repoRoot, "docs", "assets", "readme");

const slugs = [
  "overview",
  "documentation-hub",
  "operations",
  "security",
  "runtime-profiles",
  "routing-guide",
];
const languages = ["en", "fr"];
const expected = slugs.flatMap((slug) =>
  languages.map((language) => `${slug}.${language}.svg`),
);
const allowedPalette = new Set([
  "#F7F5F0",
  "#1A1A1A",
  "#EFEDE8",
  "#E0DCD4",
  "#B87333",
  "#2E5A7C",
  "#4A7C59",
  "#131316",
]);

const directoryEntries = await readdir(assetsDir);
const actualSvgFiles = directoryEntries
  .filter((name) => name.endsWith(".svg"))
  .sort();
assert.deepEqual(
  actualSvgFiles,
  [...expected].sort(),
  "SVG file set must be exact",
);

const manifest = JSON.parse(
  await readFile(path.join(assetsDir, "manifest.json"), "utf8"),
);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.files.length, expected.length);
assert.deepEqual(
  manifest.files.map((item) => item.filename).sort(),
  [...expected].sort(),
  "Manifest must list every expected SVG exactly once",
);

for (const slug of slugs) {
  for (const language of languages) {
    const filename = `${slug}.${language}.svg`;
    const svg = await readFile(path.join(assetsDir, filename), "utf8");

    assert.match(
      svg,
      /<svg\b[^>]*\bwidth="1200"/,
      `${filename}: width must be 1200`,
    );
    assert.match(
      svg,
      /<svg\b[^>]*\bheight="630"/,
      `${filename}: height must be 630`,
    );
    assert.match(
      svg,
      /<svg\b[^>]*\bviewBox="0 0 1200 630"/,
      `${filename}: viewBox must be 0 0 1200 630`,
    );
    assert.match(svg, /<title\b/, `${filename}: accessible title is required`);
    assert.match(
      svg,
      /<desc\b/,
      `${filename}: accessible description is required`,
    );
    assert.match(svg, /<text\b/, `${filename}: editable SVG text is required`);

    assert.doesNotMatch(
      svg,
      /<image\b/i,
      `${filename}: raster images are forbidden`,
    );
    assert.doesNotMatch(
      svg,
      /<script\b/i,
      `${filename}: scripts are forbidden`,
    );
    assert.doesNotMatch(
      svg,
      /\bdata:/i,
      `${filename}: data URLs are forbidden`,
    );
    assert.doesNotMatch(
      svg,
      /\bbase64\b/i,
      `${filename}: base64 content is forbidden`,
    );
    assert.doesNotMatch(
      svg,
      /\b(?:xlink:href|href)\s*=/i,
      `${filename}: href references are forbidden`,
    );

    const colors = new Set(svg.match(/#[0-9a-fA-F]{6}\b/g) ?? []);
    for (const color of colors) {
      assert.ok(
        allowedPalette.has(color.toUpperCase()),
        `${filename}: color ${color} is outside the allowed palette`,
      );
    }
    assert.ok(
      colors.size >= 5,
      `${filename}: visual should use the shared editorial palette`,
    );
  }
}

for (const slug of slugs) {
  const pair = expected.filter((filename) => filename.startsWith(`${slug}.`));
  assert.deepEqual(pair.sort(), [`${slug}.en.svg`, `${slug}.fr.svg`].sort());
}

const obsoleteAssets = [
  "hero-optimike-obsidian-mcp.png",
  "runtime-architecture-optimike-obsidian-mcp.png",
];
const assetEntries = await readdir(path.join(repoRoot, "docs", "assets"));
const repositoryTree = await readFile(
  path.join(repoRoot, "docs", "tree.md"),
  "utf8",
);
for (const filename of obsoleteAssets) {
  assert.ok(
    !assetEntries.includes(filename),
    `${filename}: obsolete generated raster must stay removed`,
  );
  assert.ok(
    !repositoryTree.includes(filename),
    `${filename}: docs/tree.md still references an obsolete asset`,
  );
}

const routingEn = await readFile(
  path.join(assetsDir, "routing-guide.en.svg"),
  "utf8",
);
const routingFr = await readFile(
  path.join(assetsDir, "routing-guide.fr.svg"),
  "utf8",
);
assert.match(
  routingEn,
  />List \/ read</,
  "External-root routing must promise listing and reading, not search",
);
assert.match(
  routingFr,
  />Lister \/ lire</,
  "Le routage external-root doit promettre liste et lecture, pas recherche",
);

console.log(
  `PASS: ${expected.length} README SVGs have complete EN/FR pairs, valid dimensions, editable text, a closed palette, and no raster, script, base64 or external href content.`,
);
