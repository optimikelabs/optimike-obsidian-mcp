import assert from "node:assert/strict";
import test from "node:test";
import {
  projectNoteLinks,
  type NoteLinkReferenceInput,
  type NoteSubpathValidation,
} from "./noteLinks.js";

function parseLinktext(linkText: string): { path: string; subpath: string } {
  const hash = linkText.indexOf("#");
  return hash < 0
    ? { path: linkText, subpath: "" }
    : { path: linkText.slice(0, hash), subpath: linkText.slice(hash) };
}

const pos = (offset: number) => ({
  start: { line: 0, col: offset, offset },
  end: { line: 0, col: offset + 1, offset: offset + 1 },
});

test("projects GQM26 discriminants without conflating target and anchor validity", () => {
  const links: NoteLinkReferenceInput[] = [
    { link: "People/Ada#Life", original: "[[People/Ada#Life|Ada Lovelace]]", displayText: "Ada Lovelace", position: pos(20) },
    { link: "../Relative.md#Missing", original: "[relative](../Relative.md#Missing)", position: pos(40) },
    { link: "Alias Target", original: "[[Alias Target]]", position: pos(60) },
    { link: "Same Name", original: "[[Same Name]]", position: pos(80) },
    { link: "Missing Note", original: "[[Missing Note]]", position: pos(100) },
    { link: "Blocks#^abc123", original: "[[Blocks#^abc123]]", position: pos(120) },
  ];
  const embeds: NoteLinkReferenceInput[] = [
    { link: "Media/Image.png", original: "![[Media/Image.png]]", position: pos(30) },
  ];
  const frontmatterLinks: NoteLinkReferenceInput[] = [
    { link: "Projects/Alpha", original: "[[Projects/Alpha]]", key: "parent" },
  ];
  const resolutions: Record<string, string> = {
    "People/Ada": "People/Ada.md",
    "../Relative.md": "Relative.md",
    "Alias Target": "Canonical/Alias Owner.md",
    "Same Name": "Folder A/Same Name.md",
    Blocks: "Blocks.md",
    "Media/Image.png": "Media/Image.png",
    "Projects/Alpha": "Projects/Alpha.md",
  };
  const subpaths: Record<string, NoteSubpathValidation> = {
    "People/Ada.md#Life": { status: "valid", type: "heading" },
    "Relative.md#Missing": { status: "invalid" },
    "Blocks.md#^abc123": { status: "valid", type: "block" },
  };

  const result = projectNoteLinks({
    sourcePath: "Notes/Source.md",
    cacheAvailable: true,
    links,
    embeds,
    frontmatterLinks,
    resolvedLinks: {
      "Backlinks/One.md": { "Notes/Source.md": 1 },
      "Backlinks/Two.md": { "Notes/Source.md": 2 },
    },
    unresolvedLinks: { "Notes/Source.md": { "Missing Note": 1 } },
    limit: 50,
    parseLinktext,
    resolveLink: (linkPath, sourcePath) => {
      assert.equal(sourcePath, "Notes/Source.md");
      return resolutions[linkPath] ?? null;
    },
    validateSubpath: (targetPath, subpath) =>
      subpaths[targetPath + subpath] ?? {
        status: "unknown",
        reason: "target_cache_unavailable",
      },
  });

  assert.equal(result.outgoing.length, 8);
  assert.equal(result.outgoing[0].kind, "frontmatter");
  assert.equal(result.outgoing[0].frontmatterKey, "parent");
  assert.equal(
    result.outgoing.find((item) => item.linkText === "People/Ada#Life")?.displayText,
    "Ada Lovelace",
  );
  assert.deepEqual(
    result.outgoing.find((item) => item.linkText === "People/Ada#Life")?.subpathValidation,
    { status: "valid", type: "heading" },
  );
  assert.deepEqual(
    result.outgoing.find((item) => item.linkText === "../Relative.md#Missing")?.subpathValidation,
    { status: "invalid" },
  );
  assert.deepEqual(
    result.outgoing.find((item) => item.linkText === "Blocks#^abc123")?.subpathValidation,
    { status: "valid", type: "block" },
  );
  assert.deepEqual(
    result.outgoing.find((item) => item.linkText === "Alias Target")?.resolution,
    { status: "resolved", targetPath: "Canonical/Alias Owner.md" },
  );
  assert.deepEqual(
    result.outgoing.find((item) => item.linkText === "Same Name")?.resolution,
    { status: "resolved", targetPath: "Folder A/Same Name.md" },
  );
  assert.deepEqual(
    result.outgoing.find((item) => item.linkText === "Missing Note")?.resolution,
    { status: "unresolved" },
  );
  assert.equal(result.outgoing.find((item) => item.kind === "embed")?.original, "![[Media/Image.png]]");
  assert.deepEqual(result.unresolved, [{ linkText: "Missing Note", count: 1 }]);
  assert.deepEqual(result.backlinks, [
    { sourcePath: "Backlinks/One.md", count: 1 },
    { sourcePath: "Backlinks/Two.md", count: 2 },
  ]);
});

test("same-note subpaths and limits are deterministic and expensive resolution stops at the limit", () => {
  let resolvedCalls = 0;
  const result = projectNoteLinks({
    sourcePath: "Source.md",
    cacheAvailable: true,
    links: [
      { link: "#Heading", original: "[[#Heading]]", position: pos(1) },
      { link: "B", original: "[[B]]", position: pos(2) },
      { link: "C", original: "[[C]]", position: pos(3) },
    ],
    embeds: [],
    frontmatterLinks: [],
    resolvedLinks: { "Z.md": { "Source.md": 1 }, "A.md": { "Source.md": 1 } },
    unresolvedLinks: { "Source.md": { Zed: 1, Alpha: 2 } },
    limit: 1,
    parseLinktext,
    resolveLink: (linkPath) => {
      resolvedCalls += 1;
      return linkPath + ".md";
    },
    validateSubpath: (targetPath, subpath) => {
      assert.equal(targetPath, "Source.md");
      assert.equal(subpath, "#Heading");
      return { status: "valid", type: "heading" };
    },
  });
  assert.deepEqual(result.outgoing[0].resolution, { status: "resolved", targetPath: "Source.md" });
  assert.deepEqual(result.coverage.outgoing, {
    available: true,
    total: 3,
    returned: 1,
    truncated: true,
  });
  assert.deepEqual(result.unresolved, [{ linkText: "Alpha", count: 2 }]);
  assert.deepEqual(result.backlinks, [{ sourcePath: "A.md", count: 1 }]);
  assert.equal(result.coverage.unresolved.truncated, true);
  assert.equal(result.coverage.backlinks.truncated, true);
  assert.equal(
    resolvedCalls,
    0,
    "the retained same-note link must not resolve hidden outgoing references",
  );
});

test("missing source cache does not fabricate outgoing completeness", () => {
  const result = projectNoteLinks({
    sourcePath: "Source.md",
    cacheAvailable: false,
    links: [],
    embeds: [],
    frontmatterLinks: [],
    resolvedLinks: { "Back.md": { "Source.md": 1 } },
    unresolvedLinks: { "Source.md": { Missing: 1 } },
    limit: 20,
    parseLinktext,
    resolveLink: () => null,
    validateSubpath: () => ({ status: "unknown", reason: "target_cache_unavailable" }),
  });
  assert.deepEqual(result.outgoing, []);
  assert.deepEqual(result.coverage.outgoing, {
    available: false,
    total: null,
    returned: 0,
    truncated: false,
  });
  assert.deepEqual(result.backlinks, [{ sourcePath: "Back.md", count: 1 }]);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.coverage.unresolved, { available: false, total: null, returned: 0, truncated: false });
});


test("M2 code-unit ordering fixes limited subsets independently of host locale", () => {
  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = function () { throw new Error("host locale must not be consulted"); };
  try {
    const values = ["ä", "z", "A", "a", "é", "É"];
    const result = projectNoteLinks({
      sourcePath: "Source.md", cacheAvailable: true, limit: 3,
      links: values.map(link => ({ link, original: link })), embeds: [], frontmatterLinks: [],
      resolvedLinks: Object.fromEntries(values.map(value => [value + ".md", { "Source.md": 1 }])),
      unresolvedLinks: { "Source.md": Object.fromEntries(values.map(value => [value, 1])) },
      parseLinktext, resolveLink: () => null,
      validateSubpath: () => ({ status: "not_requested" }),
    });
    assert.deepEqual(result.outgoing.map(ref => ref.linkText), ["A", "a", "z"]);
    assert.deepEqual(result.unresolved.map(ref => ref.linkText), ["A", "a", "z"]);
    assert.deepEqual(result.backlinks.map(ref => ref.sourcePath), ["A.md", "a.md", "z.md"]);
    assert.equal(result.coverage.unresolved.total, 6);
    assert.equal(result.coverage.unresolved.truncated, true);
  } finally { String.prototype.localeCompare = originalLocaleCompare; }
});
