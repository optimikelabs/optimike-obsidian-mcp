import assert from "node:assert/strict";
import test from "node:test";
import {
  ATOMIC_WRITE_CONTRACT_VERSION,
  assertBindingFingerprint,
  BindingConflictError,
  compareAndReplace,
  HashConflictError,
  parseCasRequest,
  parseReadRequest,
  sha256,
  validateVaultMarkdownPath,
} from "./contract.js";

test("validates bounded vault-relative Markdown paths", () => {
  assert.equal(validateVaultMarkdownPath("Notes/Test.md"), "Notes/Test.md");
  for (const value of [
    "../Test.md",
    "/Test.md",
    "Notes\\Test.md",
    "Test.txt",
    ".obsidian/Plugins.md",
  ]) {
    assert.throws(() => validateVaultMarkdownPath(value));
  }
});

test("read and CAS bodies are strict and versioned", () => {
  assert.deepEqual(parseReadRequest({ contractVersion: 1, path: "Test.md" }), {
    contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
    path: "Test.md",
  });
  assert.throws(() =>
    parseReadRequest({ contractVersion: 1, path: "Test.md", extra: true }),
  );
  const nextContent = "après";
  const bindingFingerprint = sha256("fixture-backend");
  const expectedSha256 = sha256("avant");
  assert.deepEqual(
    parseCasRequest({
      contractVersion: 1,
      path: "Test.md",
      bindingFingerprint,
      expectedSha256,
      nextContent,
    }),
    {
      contractVersion: 1,
      path: "Test.md",
      bindingFingerprint,
      expectedSha256,
      nextContent,
    },
  );
  assert.doesNotThrow(() =>
    assertBindingFingerprint(bindingFingerprint, bindingFingerprint),
  );
  assert.throws(
    () => assertBindingFingerprint(bindingFingerprint, sha256("other-backend")),
    BindingConflictError,
  );
});

test("SHA-256 is stable over UTF-8 content", () => {
  assert.equal(
    sha256("ÉLYSIA"),
    "9a5a69ce1a1a2173564d5e9b02ce92b6c8e347950ead69d2622c536e4f291fda",
  );
});

test("compare-and-replace never returns content after a hash conflict", () => {
  const expected = sha256("before");
  assert.deepEqual(compareAndReplace("before", expected, "after"), {
    beforeSha256: expected,
    content: "after",
  });
  assert.throws(
    () => compareAndReplace("concurrent", expected, "after"),
    HashConflictError,
  );
});
