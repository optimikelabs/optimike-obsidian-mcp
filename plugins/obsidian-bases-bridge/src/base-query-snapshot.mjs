import { createHash } from "node:crypto";

/** Snapshot of the exact bytes already parsed by readBaseConfig; never reread. */
export function baseQuerySnapshot(path, yaml, bindingFingerprint) {
  if (typeof path !== "string" || !path.endsWith(".base") || typeof yaml !== "string" ||
      !/^[a-f0-9]{64}$/u.test(bindingFingerprint)) throw new Error("invalid_base_query_snapshot");
  return Object.freeze({ contractVersion: 1, path,
    sha256: createHash("sha256").update(yaml, "utf8").digest("hex"), bindingFingerprint });
}
