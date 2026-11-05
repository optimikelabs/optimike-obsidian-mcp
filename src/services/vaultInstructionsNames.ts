/**
 * Pure helpers shared by the configuration and the vault-instructions gate.
 * This module must not import the configuration (the configuration imports it).
 */

export const VAULT_INSTRUCTIONS_MODES = ["off", "advise", "enforce"] as const;
export type VaultInstructionsMode = (typeof VAULT_INSTRUCTIONS_MODES)[number];

const MODE_RANK: Record<VaultInstructionsMode, number> = {
  off: 0,
  advise: 1,
  enforce: 2,
};

export const MAX_VAULT_INSTRUCTION_FILE_NAMES = 8;

/** Parses a closed mode value; anything else is `undefined`. */
export function parseVaultInstructionsMode(
  value: unknown,
): VaultInstructionsMode | undefined {
  return typeof value === "string" &&
    (VAULT_INSTRUCTIONS_MODES as readonly string[]).includes(value)
    ? (value as VaultInstructionsMode)
    : undefined;
}

/** The stricter of two modes. */
export function stricterVaultInstructionsMode(
  a: VaultInstructionsMode,
  b: VaultInstructionsMode,
): VaultInstructionsMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

/**
 * Parses `MCP_VAULT_INSTRUCTIONS_FILES`: 1 to 8 plain file names (no folder,
 * no `.`/`..`, no characters that are invalid in a vault file name), separated
 * by commas or new lines. Duplicates are dropped, order is kept. Returns
 * `undefined` for an invalid value, never the rejected text.
 */
export function parseVaultInstructionFileNames(
  raw: string,
): string[] | undefined {
  const names: string[] = [];
  for (const part of raw.split(/[\r\n,]+/u)) {
    const name = part.trim().normalize("NFC");
    if (!name) continue;
    if (
      name.length > 128 ||
      name === "." ||
      name === ".." ||
      // Folder separators and characters Obsidian or Windows reject in names.
      /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(name)
    ) {
      return undefined;
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0 || names.length > MAX_VAULT_INSTRUCTION_FILE_NAMES) {
    return undefined;
  }
  return names;
}
