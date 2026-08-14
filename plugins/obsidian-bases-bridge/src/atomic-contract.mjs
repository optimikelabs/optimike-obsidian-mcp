import { createHash } from "node:crypto";

export const BASE_ATOMIC_CONTRACT_VERSION = 1;
export const BASE_ATOMIC_REST_PREFIX =
  "/extensions/obsidian-bases-bridge/atomic";
export const MAX_BASE_BYTES = 5 * 1024 * 1024;

export class BaseHashConflictError extends Error {
  constructor(actualSha256) {
    super("The Base changed after the plan was sealed.");
    this.actualSha256 = actualSha256;
  }
}

export class BaseBindingConflictError extends Error {
  constructor() {
    super("The Bases Bridge backend does not match the sealed plan.");
  }
}

export function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function record(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Request body must be a JSON object.");
  }
  return input;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Body keys must be exactly: ${wanted.join(", ")}.`);
  }
}

function digest(input, field) {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  }
  return input;
}

function contractVersion(input) {
  if (input !== BASE_ATOMIC_CONTRACT_VERSION) {
    throw new Error("contractVersion must be 1.");
  }
  return BASE_ATOMIC_CONTRACT_VERSION;
}

export function validateBasePath(input) {
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
  if (!value.toLowerCase().endsWith(".base")) {
    throw new Error("Only Obsidian Base files are supported.");
  }
  return value;
}

export function parseBaseReadRequest(input) {
  const body = record(input);
  exactKeys(body, ["contractVersion", "path"]);
  return {
    contractVersion: contractVersion(body.contractVersion),
    path: validateBasePath(body.path),
  };
}

export function parseBaseCasRequest(input) {
  const body = record(input);
  exactKeys(body, [
    "bindingFingerprint",
    "contractVersion",
    "expectedSha256",
    "nextYaml",
    "path",
  ]);
  if (typeof body.nextYaml !== "string") {
    throw new Error("nextYaml must be a string.");
  }
  if (Buffer.byteLength(body.nextYaml, "utf8") > MAX_BASE_BYTES) {
    throw new Error(`nextYaml exceeds ${MAX_BASE_BYTES} UTF-8 bytes.`);
  }
  return {
    contractVersion: contractVersion(body.contractVersion),
    path: validateBasePath(body.path),
    bindingFingerprint: digest(body.bindingFingerprint, "bindingFingerprint"),
    expectedSha256: digest(body.expectedSha256, "expectedSha256"),
    nextYaml: body.nextYaml,
  };
}

export function assertBaseBinding(requested, current) {
  if (requested !== current) throw new BaseBindingConflictError();
}

export function compareAndReplaceBase(current, expectedSha256, nextYaml) {
  const beforeSha256 = sha256(current);
  if (beforeSha256 !== expectedSha256) {
    throw new BaseHashConflictError(beforeSha256);
  }
  return { beforeSha256, content: nextYaml };
}
