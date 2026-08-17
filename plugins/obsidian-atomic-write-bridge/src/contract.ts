import { createHash } from "node:crypto";

export const ATOMIC_WRITE_CONTRACT_VERSION = 1 as const;
export const ATOMIC_WRITE_REST_PREFIX =
  "/extensions/obsidian-atomic-write-bridge" as const;
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
export const MAX_CANVAS_BYTES = 5 * 1024 * 1024;

export type NoteReadRequest = {
  contractVersion: typeof ATOMIC_WRITE_CONTRACT_VERSION;
  path: string;
};

export type NoteCasRequest = NoteReadRequest & {
  bindingFingerprint: string;
  expectedSha256: string;
  nextContent: string;
};

export type CanvasReadRequest = {
  contractVersion: typeof ATOMIC_WRITE_CONTRACT_VERSION;
  path: string;
};

export type CanvasCasRequest = CanvasReadRequest & {
  bindingFingerprint: string;
  expectedSha256: string;
  nextContent: string;
};

export class HashConflictError extends Error {
  constructor(readonly actualSha256: string) {
    super("The note changed after the plan was created.");
  }
}

export class BindingConflictError extends Error {
  constructor() {
    super("The atomic-write backend instance does not match the sealed plan.");
  }
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function assertCanvasContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_CANVAS_BYTES) {
    throw new Error(`Canvas content exceeds ${MAX_CANVAS_BYTES} UTF-8 bytes.`);
  }
}

export function compareAndReplace(
  current: string,
  expectedSha256: string,
  nextContent: string,
): { beforeSha256: string; content: string } {
  const beforeSha256 = sha256(current);
  if (beforeSha256 !== expectedSha256) {
    throw new HashConflictError(beforeSha256);
  }
  return { beforeSha256, content: nextContent };
}

export function validateVaultMarkdownPath(input: unknown): string {
  return validateVaultPath(input, ".md", "Only Markdown notes are supported.");
}

export function validateVaultCanvasPath(input: unknown): string {
  return validateVaultPath(
    input,
    ".canvas",
    "Only JSON Canvas files are supported.",
  );
}

function validateVaultPath(
  input: unknown,
  extension: string,
  extensionError: string,
): string {
  if (typeof input !== "string") throw new Error("path must be a string.");
  const value = input.trim();
  if (!value || value.length > 1024) {
    throw new Error("path must contain between 1 and 1024 characters.");
  }
  if (value.startsWith("/") || value.includes("\\")) {
    throw new Error("path must be vault-relative and use forward slashes.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("path contains an invalid segment.");
  }
  if (parts[0]?.toLowerCase() === ".obsidian") {
    throw new Error("Obsidian configuration files are outside this bridge.");
  }
  if (!value.toLowerCase().endsWith(extension)) {
    throw new Error(extensionError);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Body keys must be exactly: ${wanted.join(", ")}.`);
  }
}

function bodyRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Request body must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function contractVersion(input: unknown): 1 {
  if (input !== ATOMIC_WRITE_CONTRACT_VERSION) {
    throw new Error("contractVersion must be 1.");
  }
  return ATOMIC_WRITE_CONTRACT_VERSION;
}

function sha256Digest(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  }
  return input;
}

export function assertBindingFingerprint(
  requested: string,
  current: string,
): void {
  if (requested !== current) throw new BindingConflictError();
}

export function parseReadRequest(input: unknown): NoteReadRequest {
  const body = bodyRecord(input);
  assertExactKeys(body, ["contractVersion", "path"]);
  return {
    contractVersion: contractVersion(body.contractVersion),
    path: validateVaultMarkdownPath(body.path),
  };
}

export function parseCasRequest(input: unknown): NoteCasRequest {
  const body = bodyRecord(input);
  assertExactKeys(body, [
    "bindingFingerprint",
    "contractVersion",
    "expectedSha256",
    "nextContent",
    "path",
  ]);
  if (typeof body.nextContent !== "string") {
    throw new Error("nextContent must be a string.");
  }
  if (Buffer.byteLength(body.nextContent, "utf8") > MAX_NOTE_BYTES) {
    throw new Error(`nextContent exceeds ${MAX_NOTE_BYTES} UTF-8 bytes.`);
  }
  return {
    contractVersion: contractVersion(body.contractVersion),
    path: validateVaultMarkdownPath(body.path),
    bindingFingerprint: sha256Digest(
      body.bindingFingerprint,
      "bindingFingerprint",
    ),
    expectedSha256: sha256Digest(body.expectedSha256, "expectedSha256"),
    nextContent: body.nextContent,
  };
}

export function parseCanvasReadRequest(input: unknown): CanvasReadRequest {
  const body = bodyRecord(input);
  assertExactKeys(body, ["contractVersion", "path"]);
  return {
    contractVersion: contractVersion(body.contractVersion),
    path: validateVaultCanvasPath(body.path),
  };
}

export function parseCanvasCasRequest(input: unknown): CanvasCasRequest {
  const body = bodyRecord(input);
  assertExactKeys(body, [
    "bindingFingerprint",
    "contractVersion",
    "expectedSha256",
    "nextContent",
    "path",
  ]);
  if (typeof body.nextContent !== "string") {
    throw new Error("nextContent must be a string.");
  }
  assertCanvasContentSize(body.nextContent);
  validateCanvasGraph(body.nextContent);
  return {
    contractVersion: contractVersion(body.contractVersion),
    path: validateVaultCanvasPath(body.path),
    bindingFingerprint: sha256Digest(
      body.bindingFingerprint,
      "bindingFingerprint",
    ),
    expectedSha256: sha256Digest(body.expectedSha256, "expectedSha256"),
    nextContent: body.nextContent,
  };
}

export function validateCanvasGraph(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Canvas content must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Canvas content must be a JSON object.");
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.nodes) || !Array.isArray(root.edges)) {
    throw new Error("Canvas content must contain nodes and edges arrays.");
  }
  const nodeIds = new Set<string>();
  const validId = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    isWellFormedUnicode(value);
  for (const node of root.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error("Every Canvas node must be an object.");
    }
    const id = (node as Record<string, unknown>).id;
    if (!validId(id) || nodeIds.has(id)) {
      throw new Error(
        "Canvas node IDs must be non-empty, unique, unpadded, well-formed, and at most 256 characters.",
      );
    }
    nodeIds.add(id);
    const value = node as Record<string, unknown>;
    if (
      typeof value.type !== "string" ||
      !["text", "file", "link", "group"].includes(value.type)
    ) {
      throw new Error("Canvas node types must be text, file, link, or group.");
    }
    for (const field of ["x", "y", "width", "height"] as const) {
      if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
        throw new Error(`Canvas node ${field} must be a finite number.`);
      }
    }
    if ((value.width as number) <= 0 || (value.height as number) <= 0) {
      throw new Error("Canvas node width and height must be positive.");
    }
    if (value.type === "text" && typeof value.text !== "string") {
      throw new Error("Canvas text nodes must contain text.");
    }
    if (value.type === "file" && typeof value.file !== "string") {
      throw new Error("Canvas file nodes must contain a file path.");
    }
    if (value.type === "link" && typeof value.url !== "string") {
      throw new Error("Canvas link nodes must contain a URL.");
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of root.edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      throw new Error("Every Canvas edge must be an object.");
    }
    const value = edge as Record<string, unknown>;
    if (!validId(value.id) || edgeIds.has(value.id)) {
      throw new Error(
        "Canvas edge IDs must be non-empty, unique, unpadded, well-formed, and at most 256 characters.",
      );
    }
    if (
      typeof value.fromNode !== "string" ||
      typeof value.toNode !== "string" ||
      !nodeIds.has(value.fromNode) ||
      !nodeIds.has(value.toNode)
    ) {
      throw new Error("Canvas edges must reference existing nodes.");
    }
    for (const side of ["fromSide", "toSide"] as const) {
      if (
        value[side] !== undefined &&
        (typeof value[side] !== "string" ||
          !["top", "right", "bottom", "left"].includes(value[side]))
      ) {
        throw new Error(`Canvas edge ${side} is invalid.`);
      }
    }
    edgeIds.add(value.id);
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
