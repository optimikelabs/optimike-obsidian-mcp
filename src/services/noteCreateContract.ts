import { createHash } from "node:crypto";
import { nativeNotePath } from "./nativeNoteMoveContract.js";
import { resolveModifiedTimeSettlement } from "./operations/modifiedTimeSettlement.js";

export const NOTE_CREATE_PREFIX = "obsidian-note-create:v1:";
export const NOTE_CREATE_MAX_BYTES = 2 * 1024 * 1024;
export type CreateDateField = {
  pluginId: "update-time-on-edit" | "frontmatter-date-manager" | "update-time";
  propertyName: string;
  role: "created" | "modified";
  delayMs: number;
};
export type NoteCreatePolicy = { version: 1; utcOffsetMinutes: number; fields: CreateDateField[] };
export type NoteCreatePreflight = {
  contractVersion: 1; path: string; bindingFingerprint: string;
  absent: true; enabled: true; policy: NoteCreatePolicy; policyDigest: string;
};
export type NoteCreateApply = {
  contractVersion: 1; operationId: string; path: string; content: string;
  contentSha256: string; bindingFingerprint: string; policyDigest: string;
};
export type NoteCreateInspection = {
  contractVersion: 1; path: string; bindingFingerprint: string;
  policyDigest: string; exists: boolean; content?: string; sha256?: string;
};
export const noteCreateHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function validateCreatePolicy(value: NoteCreatePolicy): NoteCreatePolicy {
  if (!value || value.version !== 1 || !Number.isInteger(value.utcOffsetMinutes) ||
      Math.abs(value.utcOffsetMinutes) > 840 || !Array.isArray(value.fields) || value.fields.length > 6) {
    throw new Error("invalid_create_date_policy");
  }
  const names = new Set<string>();
  const fields = value.fields.map(field => {
    if (!["update-time-on-edit", "frontmatter-date-manager", "update-time"].includes(field.pluginId) ||
        !["created", "modified"].includes(field.role) || typeof field.propertyName !== "string" ||
        !/^[\p{L}_](?:[\p{L}\p{M}\p{N}_. -]*[\p{L}\p{M}\p{N}_.-])?$/u.test(field.propertyName) ||
        field.propertyName.length > 128 || !Number.isInteger(field.delayMs) || field.delayMs < 0 || field.delayMs > 240000) {
      throw new Error("invalid_create_date_policy");
    }
    const normalized = field.propertyName.toLowerCase();
    if (names.has(normalized)) throw new Error("ambiguous_create_date_policy");
    names.add(normalized);
    return { pluginId: field.pluginId, propertyName: field.propertyName, role: field.role, delayMs: field.delayMs };
  }).sort((a, b) => ordinal(a.propertyName, b.propertyName));
  return { version: 1, utcOffsetMinutes: value.utcOffsetMinutes, fields };
}
export function createPolicyDigest(policy: NoteCreatePolicy): string {
  return noteCreateHash(JSON.stringify(validateCreatePolicy(policy)));
}
export function validateNoteCreate(path: string, content: string, policy: NoteCreatePolicy): void {
  nativeNotePath(path);
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > NOTE_CREATE_MAX_BYTES ||
      Buffer.from(content, "utf8").toString("utf8") !== content || content.startsWith("\uFEFF") || /\r(?!\n)/u.test(content)) {
    throw new Error("invalid_create_content");
  }
  validateCreatePolicy(policy);
  if (policy.fields.length && (!/^---\r?\n/u.test(content) || !/\r?\n---(?:\r?\n|$)/u.test(content))) {
    throw new Error("create_dates_require_frontmatter_envelope");
  }
}

/** Reuses the existing single-field timestamp verifier; no arbitrary YAML normalization. */
export function observeCreateContent(expected: string, observed: string, policy: NoteCreatePolicy,
  startedAt: number, observedAt: number): { kind: "exact" | "date-settled"; sha256: string } | undefined {
  validateCreatePolicy(policy);
  if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt) || observedAt < startedAt) return undefined;
  if (observedAt - startedAt < Math.max(0, ...policy.fields.map(field => field.delayMs))) return undefined;
  if (expected === observed) return { kind: "exact", sha256: noteCreateHash(observed) };
  let current = expected;
  const clean = (line: string) => line.endsWith("\r") ? line.slice(0, -1) : line;
  for (const field of policy.fields) {
    const before = current.split("\n"), after = observed.split("\n");
    const endBefore = before.findIndex((line, i) => i > 0 && clean(line) === "---");
    const endAfter = after.findIndex((line, i) => i > 0 && clean(line) === "---");
    if (clean(before[0]) !== "---" || clean(after[0]) !== "---" || endBefore < 0 || endAfter < 0) return undefined;
    const matches = (lines: string[], end: number) => lines.flatMap((line, i) =>
      i > 0 && i < end && clean(line).startsWith(field.propertyName + ":") ? [i] : []);
    const old = matches(before, endBefore), next = matches(after, endAfter);
    if (old.length > 1 || next.length > 1) return undefined;
    if (!old.length && !next.length) continue;
    if (!next.length) return undefined;
    if (old.length && before[old[0]] === after[next[0]]) continue;
    // Creation timestamps supplied in the sealed template are never silently replaced.
    if (field.role === "created" && old.length) return undefined;
    const intermediate = [...before];
    if (old.length) intermediate[old[0]] = after[next[0]];
    else intermediate.splice(endBefore, 0, after[next[0]]);
    const changed = intermediate.join("\n");
    if (!resolveModifiedTimeSettlement(current, changed, {
      contractVersion: 1, utcOffsetMinutes: policy.utcOffsetMinutes,
      integrations: [{ pluginId: field.pluginId, propertyName: field.propertyName, settlementObservationDelayMs: field.delayMs }],
    }, { applyStartedAtEpochMs: startedAt, settlementObservedAtEpochMs: observedAt })) return undefined;
    current = changed;
  }
  return current === observed ? { kind: "date-settled", sha256: noteCreateHash(observed) } : undefined;
}
