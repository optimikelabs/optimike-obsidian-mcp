import { createHash } from "node:crypto";
import { assertNoteName } from "./noteNameRules.js";
import { nativeVaultFilePath } from "./nativeNoteMoveContract.js";

/**
 * Governed exclusive creation of the native non-Markdown files (Base, Canvas).
 * Shared by the MCP and the Atomic Write Bridge; it reuses the note-creation
 * effect (O_CREAT | O_EXCL) without its Markdown date policy.
 */
export type VaultFileCreateKind = "base" | "canvas";
export const VAULT_FILE_CREATE_KINDS = ["base", "canvas"] as const satisfies readonly VaultFileCreateKind[];
export const VAULT_FILE_CREATE_MAX_BYTES = 2 * 1024 * 1024;

export const VAULT_FILE_CREATE_PROFILES = {
  base: {
    kind: "base",
    extension: ".base",
    label: "Base",
    operationKind: "obsidian.base.create",
    planRefPrefix: "obsidian-base-create:v1:",
    route: "base-create",
    statusField: "baseCreate",
    bindingDomain: "exclusive-base-create",
    tools: { plan: "bases_create_plan", apply: "bases_create_apply", status: "bases_create_status" },
  },
  canvas: {
    kind: "canvas",
    extension: ".canvas",
    label: "Canvas",
    operationKind: "obsidian.canvas.create",
    planRefPrefix: "obsidian-canvas-create:v1:",
    route: "canvas-create",
    statusField: "canvasCreate",
    bindingDomain: "exclusive-canvas-create",
    tools: { plan: "obsidian_canvas_create_plan", apply: "obsidian_canvas_create_apply", status: "obsidian_canvas_create_status" },
  },
} as const;

export type VaultFileCreateProfile = (typeof VAULT_FILE_CREATE_PROFILES)[VaultFileCreateKind];

export type VaultFileCreatePreflight = {
  contractVersion: 1; kind: VaultFileCreateKind; path: string; bindingFingerprint: string;
  vaultBindingFingerprint?: string; absent: true; enabled: true;
};
export type VaultFileCreateApply = {
  contractVersion: 1; operationId: string; path: string; content: string;
  contentSha256: string; bindingFingerprint: string;
  /** Effect fence token recorded by the MCP journal before dispatch. */
  fence?: { contractVersion: 1; epoch: string; attemptId: string };
};

export const vaultFileCreateHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Ordinary vault-relative path of this kind; lenient enough to observe an existing file. */
export function vaultFileCreatePath(kind: VaultFileCreateKind, value: unknown): string {
  return nativeVaultFilePath(value, VAULT_FILE_CREATE_PROFILES[kind].extension);
}

/** A creation is a NEW name: shared cross-platform rules with the kind's extension. */
export function assertNewVaultFileName(kind: VaultFileCreateKind, value: unknown): string {
  return assertNoteName(value, { extensions: [VAULT_FILE_CREATE_PROFILES[kind].extension] });
}

/** Exact UTF-8 bytes: no BOM, no lone CR, nonempty and bounded. */
export function validateVaultFileCreateContent(content: unknown): string {
  if (typeof content !== "string" || content.trim() === "" ||
      Buffer.byteLength(content, "utf8") > VAULT_FILE_CREATE_MAX_BYTES ||
      Buffer.from(content, "utf8").toString("utf8") !== content ||
      content.startsWith("﻿") || /\r(?!\n)/u.test(content)) {
    throw new Error("invalid_create_content");
  }
  return content;
}
