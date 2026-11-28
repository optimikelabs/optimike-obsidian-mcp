import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

export async function syncVaultBinding(vault: string): Promise<string> {
  return createHash("sha256").update(await realpath(vault), "utf8").digest("hex");
}
