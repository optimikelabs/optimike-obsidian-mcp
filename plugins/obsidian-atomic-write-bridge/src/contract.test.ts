import assert from "node:assert/strict";
import test from "node:test";
import {
  ATOMIC_WRITE_CONTRACT_VERSION,
  assertCanvasContentSize,
  assertBindingFingerprint,
  BindingConflictError,
  compareAndReplace,
  HashConflictError,
  parseCasRequest,
  parseCanvasCasRequest,
  parseCanvasReadRequest,
  parseReadRequest,
  sha256,
  validateVaultMarkdownPath,
  validateVaultCanvasPath,
  MAX_CANVAS_BYTES,
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

test("validates Canvas paths and graph-bound CAS bodies", () => {
  assert.equal(
    validateVaultCanvasPath("Canvases/Flow.canvas"),
    "Canvases/Flow.canvas",
  );
  assert.deepEqual(
    parseCanvasReadRequest({ contractVersion: 1, path: "Flow.canvas" }),
    { contractVersion: 1, path: "Flow.canvas" },
  );
  assert.throws(() =>
    parseCanvasReadRequest({ contractVersion: 1, path: " Flow.canvas " }),
  );
  const nextContent = JSON.stringify({
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100, text: "A" },
    ],
    edges: [],
  });
  assert.equal(
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent,
    }).nextContent,
    nextContent,
  );
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent: JSON.stringify({
        nodes: [{ id: "a" }],
        edges: [{ id: "e", fromNode: "a", toNode: "missing" }],
      }),
    }),
  );
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: " Flow.canvas ",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent,
    }),
  );
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent: JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "A",
            color: [],
          },
        ],
        edges: [],
      }),
    }),
  );
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent: JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "A",
          },
          {
            id: "b",
            type: "text",
            x: 200,
            y: 0,
            width: 100,
            height: 100,
            text: "B",
          },
        ],
        edges: [{ id: "ab", fromNode: "a", toNode: "b", fromSide: ["top"] }],
      }),
    }),
  );
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent: JSON.stringify({
        nodes: [
          {
            id: " padded ",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "A",
          },
        ],
        edges: [],
      }),
    }),
  );
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent: JSON.stringify({
        nodes: [
          {
            id: "a".repeat(257),
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "A",
          },
        ],
        edges: [],
      }),
    }),
  );
  for (const value of ["../Flow.canvas", "Flow.md", ".obsidian/Flow.canvas"]) {
    assert.throws(() => validateVaultCanvasPath(value));
  }
});

test("rejects oversized Canvas reads and writes before graph processing", () => {
  const oversized = "x".repeat(MAX_CANVAS_BYTES + 1);
  assert.throws(() => assertCanvasContentSize(oversized), /exceeds/u);
  assert.throws(() =>
    parseCanvasCasRequest({
      contractVersion: 1,
      path: "Flow.canvas",
      bindingFingerprint: sha256("backend"),
      expectedSha256: sha256("before"),
      nextContent: oversized,
    }),
  );
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
