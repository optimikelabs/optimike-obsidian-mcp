/**
 * Reads one diagnostic field from an untrusted thrown value without allowing a
 * hostile getter or Proxy trap to escape an error/reporting boundary.
 *
 * This deliberately returns no fallback value: callers must fail closed when
 * the field cannot be observed safely.
 */
export function safelyReadUntrustedErrorField(
  error: unknown,
  field: "code" | "cause" | "errors",
): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    return (error as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/**
 * Snapshot an untrusted error aggregate without relying on Array methods.
 * Both Array.isArray and Array.prototype.some can throw for a revoked Proxy;
 * classification must treat that as an opaque application failure instead of
 * letting an error-reporting path crash.
 */
export function safelySnapshotUntrustedErrorArray(
  value: unknown,
): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = Reflect.get(value, "length");
    if (!Number.isSafeInteger(length) || length < 0 || length > 128) {
      return undefined;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      snapshot.push(Reflect.get(value, index));
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
