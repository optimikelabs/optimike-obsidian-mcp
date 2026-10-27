import { BaseErrorCode, McpError } from "../types-global/errors.js";

/** Only stable, well-formed bridge versions at or above the audited release qualify. */
export function supportedAtomicBridgeVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major > 0 || minor > 8 || (minor === 8 && patch >= 4);
}

export function requireAtomicBridgeVersion<T extends { plugin?: { version?: unknown } }>(status: T): T {
  if (!supportedAtomicBridgeVersion(status?.plugin?.version)) {
    throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Atomic Write Bridge 0.8.4 or later is required.", { reasonCode: "atomic_bridge_version_unsupported" });
  }
  return status;
}
