import { createHash } from "node:crypto";

export const ATOMIC_WRITE_CONTRACT_VERSION = 1 as const;
export const ATOMIC_WRITE_REST_PREFIX =
  "/extensions/obsidian-atomic-write-bridge" as const;
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;

export type NoteReadRequest = {
  contractVersion: typeof ATOMIC_WRITE_CONTRACT_VERSION;
  path: string;
};

export type NoteCasRequest = NoteReadRequest & {
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
  if (!value.toLowerCase().endsWith(".md")) {
    throw new Error("Only Markdown notes are supported.");
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
