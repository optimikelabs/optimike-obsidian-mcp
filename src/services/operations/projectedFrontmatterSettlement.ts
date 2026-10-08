import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import {
  compileFrontmatterPatch,
  type FrontmatterPatchOperation,
  type FrontmatterJsonValue,
} from "../frontmatterPatchCompiler.js";
import type { ObsidianNoteReplaceProjection } from "./obsidianNoteReplaceJournal.js";
import {
  resolveModifiedTimeSettlement,
  type ModifiedTimeSettlementPolicy,
  type ModifiedTimeSettlementWindow,
  type ModifiedTimeSettlementEvidence,
} from "./modifiedTimeSettlement.js";

/** Permit representation drift ONLY inside already-authorized YAML key ranges.
 * The normal compiler restores those ranges to their sealed spelling; the
 * original exact date-only resolver must then accept everything else.
 * No whole-frontmatter semantic equivalence, inferred success, or new writes.
 */
export function resolveProjectedFrontmatterSettlement(
  expected: string,
  observed: string,
  policy: ModifiedTimeSettlementPolicy | undefined,
  window: ModifiedTimeSettlementWindow,
  projection: ObsidianNoteReplaceProjection | undefined,
): ModifiedTimeSettlementEvidence | undefined {
  const proof =
    projection?.kind === "obsidian.frontmatter.patch"
      ? projection.proof
      : projection?.kind === "obsidian.text.patch"
        ? (
            projection as unknown as {
              frontmatterProof?: Record<string, unknown>;
            }
          ).frontmatterProof
        : undefined;
  const keys = proof?.changedKeys;
  const protectedKeys = projection?.normalizationProtectedFrontmatterKeys;
  if (
    !Array.isArray(protectedKeys) ||
    protectedKeys.some((key) => typeof key !== "string")
  )
    return undefined;
  const protectedSet = new Set(
    [
      ...protectedKeys,
      ...(policy?.integrations.map((item) => item.propertyName) ?? []),
    ].map((key) => key.trim().toLowerCase()),
  );

  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 64 ||
    keys.some(
      (key) =>
        typeof key !== "string" || protectedSet.has(key.trim().toLowerCase()),
    ) ||
    !policy?.integrations.some(
      (item) => item.pluginId === "frontmatter-date-manager",
    )
  )
    return undefined;
  try {
    const parse = (content: string): Record<string, unknown> | undefined => {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
      const value = match ? load(match[1]) : undefined;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    };
    const before = parse(expected),
      after = parse(observed);
    if (!before || !after) return undefined;
    const operations: FrontmatterPatchOperation[] = [];
    for (const key of keys as string[]) {
      // Deleted keys must remain absent, including null-valued reintroductions.
      const beforeHas = Object.hasOwn(before, key),
        afterHas = Object.hasOwn(after, key);
      if (beforeHas !== afterHas || !isDeepStrictEqual(before[key], after[key]))
        return undefined;
      if (beforeHas)
        operations.push({
          op: "set",
          key,
          value: before[key] as FrontmatterJsonValue,
        });
    }
    if (!operations.length) return undefined;
    const restored = compileFrontmatterPatch(observed, operations);
    if (restored.nextContent === observed) return undefined;
    const accepted = resolveModifiedTimeSettlement(
      expected,
      restored.nextContent,
      policy,
      window,
    );
    if (!accepted || accepted.pluginId !== "frontmatter-date-manager")
      return undefined;
    return {
      ...accepted,
      observedSha256: createHash("sha256")
        .update(observed, "utf8")
        .digest("hex"),
      authorizedFrontmatterFormatKeys: keys as string[],
    };
  } catch {
    return undefined;
  }
}
