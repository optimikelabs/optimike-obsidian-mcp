import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCanonicalExternalReferenceRepair,
  buildCanonicalExternalReferenceRepairEdits,
  canonicalExternalReference,
  encodeCanonicalExternalReference,
  scanCanonicalExternalReferences,
} from "../dist/services/externalReferences/index.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(
  scriptDirectory,
  "fixtures",
  "external-references",
);

function assertExactRange(source, range, expected) {
  assert.equal(
    source.slice(range.start.offset, range.end.offset),
    expected,
    `Expected exact source range for ${expected}`,
  );
}

const active = await readFile(path.join(fixtureDirectory, "active.md"), "utf8");
const activeResult = scanCanonicalExternalReferences(active);

assert.equal(activeResult.reparable.length, 1);
assert.equal(activeResult.manualReview.length, 6);
assert.equal(activeResult.ignored.length, 0);

const canonical = activeResult.reparable[0];
assert.equal(canonical.reason, "canonical_pair");
assert.equal(canonical.token.rootId, "pilot.docs");
assert.equal(canonical.token.relativePath, "brief final.md");
assert.equal(canonical.token.encodedRelativePath, "brief%20final.md");
assert.ok(
  canonical.fileLink.localPath
    .replaceAll("\\", "/")
    .endsWith("Pilot/brief final.md"),
);
assertExactRange(
  active,
  canonical.token.range,
  "`external-ref:pilot.docs::brief%20final.md`",
);
assertExactRange(
  active,
  canonical.fileLink.range,
  "[Pilot brief](file:///C:/Pilot/brief%20final.md)",
);
assertExactRange(
  active,
  canonical.fileLink.destinationRange,
  "file:///C:/Pilot/brief%20final.md",
);
assert.equal(canonical.containerRange.start.line, 7);
assert.equal(canonical.containerRange.start.column, 3);

assert.equal(
  encodeCanonicalExternalReference("pilot.docs", "livrés/été final.md"),
  "external-ref:pilot.docs::livr%C3%A9s/%C3%A9t%C3%A9%20final.md",
);
const repairTarget = {
  rootId: "pilot.docs",
  relativePath: "archive/brief livré.md",
  fileUrl: "file:///C:/Pilot/archive/brief%20livr%C3%A9.md",
};
const edits = buildCanonicalExternalReferenceRepairEdits(
  active,
  canonical,
  repairTarget,
);
assert.equal(edits.length, 2);
assert.ok(edits[0].startOffset > edits[1].startOffset);
const repaired = applyCanonicalExternalReferenceRepair(
  active,
  canonical,
  repairTarget,
);
assert.ok(
  repaired.includes(
    "[Pilot brief](file:///C:/Pilot/archive/brief%20livr%C3%A9.md) — `external-ref:pilot.docs::archive/brief%20livr%C3%A9.md`",
  ),
);
const repairedResult = scanCanonicalExternalReferences(repaired);
assert.equal(repairedResult.reparable.length, 1);
assert.equal(
  repairedResult.reparable[0].token.relativePath,
  "archive/brief livré.md",
);

assert.deepEqual(
  activeResult.manualReview.map((occurrence) => occurrence.reason),
  [
    "missing_identity_token",
    "missing_file_link",
    "basename_mismatch",
    "invalid_file_uri",
    "multiple_file_links",
    "invalid_token",
  ],
);

const excluded = await readFile(
  path.join(fixtureDirectory, "excluded.md"),
  "utf8",
);
const excludedResult = scanCanonicalExternalReferences(excluded);
assert.equal(excludedResult.reparable.length, 1);
assert.equal(excludedResult.manualReview.length, 0);
assert.equal(excludedResult.ignored.length, 4);
assert.equal(
  excludedResult.occurrences.some((occurrence) =>
    excluded
      .slice(
        occurrence.containerRange.start.offset,
        occurrence.containerRange.end.offset,
      )
      .includes("Fenced"),
  ),
  false,
);
assert.equal(
  excludedResult.occurrences.some((occurrence) =>
    excluded
      .slice(
        occurrence.containerRange.start.offset,
        occurrence.containerRange.end.offset,
      )
      .includes("Commented"),
  ),
  false,
);

const unsafeTokens = [
  "external-ref:pilot.docs::../secret.txt",
  "external-ref:pilot.docs::%2e%2e/secret.txt",
  "external-ref:pilot.docs::folder%2Fsecret.txt",
  "external-ref:pilot.docs::folder%5Csecret.txt",
  "external-ref:pilot.docs::folder\\secret.txt",
  "external-ref:pilot.docs::nul%00byte.txt",
  "external-ref:pilot.docs::bad%2.txt",
  "external-ref:pilot.docs::caf%c3%a9.txt",
  "external-ref:pilot.docs::",
];
for (const token of unsafeTokens) {
  const source = `[Unsafe](file:///C:/Pilot/secret.txt) \`${token}\``;
  const result = scanCanonicalExternalReferences(source);
  assert.equal(result.reparable.length, 0, token);
  assert.equal(result.manualReview.length, 1, token);
  assert.equal(result.manualReview[0].reason, "invalid_token", token);
}

const unsafeUris = [
  "file://server/share/report.pdf",
  "file:////server/share/report.pdf",
  "file:/C:/Pilot/report.pdf",
  "file:///C:/Pilot/%2Freport.pdf",
  "file:///C:/Pilot/%5Creport.pdf",
  "file:///C:/Pilot/%00report.pdf",
  "file:///C:/Pilot/../report.pdf",
  "file:///C:/Pilot/report.pdf?download=1",
  "file:///C:/Pilot/report.pdf#page=2",
  "file:///C:/Pilot/folder/",
];
for (const uri of unsafeUris) {
  const source = `[Unsafe](${uri}) \`external-ref:pilot.docs::report.pdf\``;
  const result = scanCanonicalExternalReferences(source);
  assert.equal(result.reparable.length, 0, uri);
  assert.equal(result.manualReview.length, 1, uri);
  assert.equal(result.manualReview[0].reason, "invalid_file_uri", uri);
}

const crlf =
  "# Références\r\n\r\n- [Été](file:///C:/Pilot/%C3%A9t%C3%A9.txt) — `external-ref:pilot.docs::%C3%A9t%C3%A9.txt`\r\n";
const crlfResult = scanCanonicalExternalReferences(crlf);
assert.equal(crlfResult.reparable.length, 1);
assert.equal(crlfResult.reparable[0].containerRange.start.line, 3);
assertExactRange(
  crlf,
  crlfResult.reparable[0].token.range,
  "`external-ref:pilot.docs::%C3%A9t%C3%A9.txt`",
);

assert.ok(canonicalExternalReference.rootIdPattern.test("pilot.docs"));
assert.equal(
  canonicalExternalReference.rootIdPattern.test("Pilot.Docs"),
  false,
);

console.log("External reference parser tests passed.");
