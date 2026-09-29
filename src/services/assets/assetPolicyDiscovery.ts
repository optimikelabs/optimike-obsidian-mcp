import fs from "node:fs";
import path from "node:path";
import { assetSegment } from "./windowsAssetFiles.js";

export const OBSIDIAN_ASSET_FOLDER_SENTINEL = "@obsidian" as const;

export type AssetFolderSelectionMode = "explicit" | "obsidian-fixed";

export type ObsidianAttachmentFolderObservation =
  | { kind: "fixed"; folder: string; exists: boolean }
  | { kind: "vault_root" }
  | { kind: "note_relative" }
  | { kind: "unavailable" };

function normalizeVaultRelativeFolder(value: string): string | null {
  if (!value || value.length > 800 || value.includes("\\")) return null;
  try {
    value.split("/").forEach(assetSegment);
    return value;
  } catch {
    return null;
  }
}

export function inspectObsidianAttachmentFolder(
  vaultRoot: string | undefined,
): ObsidianAttachmentFolderObservation {
  if (!vaultRoot) return { kind: "unavailable" };
  const appJson = path.join(vaultRoot, ".obsidian", "app.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(appJson, "utf8")) as {
      attachmentFolderPath?: unknown;
    };
    if (typeof parsed.attachmentFolderPath !== "string") {
      return { kind: "unavailable" };
    }
    const raw = parsed.attachmentFolderPath.trim().replace(/\\/gu, "/");
    if (raw === "/") return { kind: "vault_root" };
    if (raw === "." || raw === "./" || raw.startsWith("./")) {
      return { kind: "note_relative" };
    }
    const folder = normalizeVaultRelativeFolder(raw);
    if (!folder) return { kind: "unavailable" };
    const candidate = path.resolve(vaultRoot, ...folder.split("/"));
    const root = path.resolve(vaultRoot);
    const inside =
      candidate === root ||
      candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    const exists = inside && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    return { kind: "fixed", folder, exists };
  } catch {
    return { kind: "unavailable" };
  }
}

export function inspectAssetPolicy(input: {
  vaultRoot?: string;
  configuredFolder?: string;
  quality: number;
  enabled: boolean;
  externalRootsConfigured: boolean;
  chatgptFileIngressEnabled: boolean;
  chatgptFileHostCount: number;
}) {
  const attachment = inspectObsidianAttachmentFolder(input.vaultRoot);
  const configuredFolder = input.configuredFolder
    ? normalizeVaultRelativeFolder(input.configuredFolder)
    : null;
  let configuredExists = false;
  if (input.vaultRoot && configuredFolder) {
    try {
      const candidate = path.resolve(input.vaultRoot, ...configuredFolder.split("/"));
      const root = path.resolve(input.vaultRoot);
      const inside =
        candidate === root ||
        candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
      configuredExists =
        inside && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      configuredExists = false;
    }
  }

  const obsidianSuggestedFolder =
    attachment.kind === "fixed" ? attachment.folder : null;
  return {
    contractVersion: 1 as const,
    enabled: input.enabled,
    destination: {
      mode: "explicit" as const,
      folder: configuredFolder,
      exists: configuredExists,
      createsDirectory: false,
      obsidianAttachment: attachment,
      matchesObsidian:
        Boolean(configuredFolder) &&
        attachment.kind === "fixed" &&
        attachment.folder === configuredFolder,
      suggestedFolder: obsidianSuggestedFolder,
    },
    conversion: {
      rasterFormat: "webp" as const,
      quality: input.quality,
      resize: false,
      exifOrientation: true,
      alphaQuality: 100,
      preserveOriginalRequiresReason: true,
    },
    ingress: {
      externalRootConfigured: input.externalRootsConfigured,
      chatgptFileParam: input.chatgptFileIngressEnabled,
      chatgptFileHostCount: input.chatgptFileHostCount,
      chatgptFileParamField: "file" as const,
      modelBase64Accepted: false,
      arbitraryUrlAccepted: false,
    },
    noteInsertion: "separate_governed_operation" as const,
  };
}
