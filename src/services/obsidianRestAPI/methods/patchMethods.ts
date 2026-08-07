/**
 * @module PatchMethods
 * @description
 * Methods for performing granular PATCH operations within notes via the Obsidian REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import {
  PatchDestination,
  PatchOptions,
  PatchPayload,
  RequestFunction,
} from "../types.js";
import { encodeVaultPath } from "../../../utils/obsidian/obsidianApiUtils.js";

function isHeadingAddress(value: unknown): value is string[] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.every((segment) => typeof segment === "string"))
  );
}

function isPatchDestination(value: unknown): value is PatchDestination {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const candidateKeys = Object.keys(candidate);
  if (
    candidateKeys.length !== 2 ||
    !candidateKeys.includes("parent") ||
    !candidateKeys.includes("place") ||
    !isHeadingAddress(candidate.parent)
  ) {
    return false;
  }
  if (candidate.place === "first" || candidate.place === "last") {
    return true;
  }
  if (
    typeof candidate.place !== "object" ||
    candidate.place === null ||
    Array.isArray(candidate.place)
  ) {
    return false;
  }

  const place = candidate.place as Record<string, unknown>;
  const keys = Object.keys(place);
  return (
    (keys.length === 1 &&
      keys[0] === "before" &&
      isHeadingAddress(place.before)) ||
    (keys.length === 1 && keys[0] === "after" && isHeadingAddress(place.after))
  );
}

/**
 * Builds a JSON-native markdown-patch 2.x instruction.
 */
function buildPatchInstruction(
  payload: PatchPayload,
  options: PatchOptions,
): Record<string, unknown> {
  if (options.operation === "delete" && payload !== undefined) {
    throw new TypeError(
      "A delete PATCH instruction must not include a payload.",
    );
  }
  if (options.operation !== "delete" && payload === undefined) {
    throw new TypeError(
      `A ${options.operation} PATCH instruction requires a payload.`,
    );
  }
  if (options.within !== undefined && options.createTargetIfMissing === true) {
    throw new TypeError(
      "A PATCH instruction cannot combine within with createTargetIfMissing.",
    );
  }
  if (
    options.scope === "parent" &&
    (options.targetType !== "heading" || options.operation !== "replace")
  ) {
    throw new TypeError(
      'The "parent" scope is valid only for a heading replace instruction.',
    );
  }
  if (options.scope === "parent" && !isPatchDestination(payload)) {
    throw new TypeError(
      'A heading "parent" scope instruction requires a valid destination payload.',
    );
  }
  if (
    options.scope === "marker" &&
    options.operation !== "delete" &&
    typeof payload !== "string"
  ) {
    throw new TypeError(
      'A non-delete "marker" scope instruction requires a string payload.',
    );
  }

  const instruction: Record<string, unknown> = {
    targetType: options.targetType,
    target: options.target,
    operation: options.operation,
  };

  if (options.within !== undefined) {
    instruction.within = options.within;
  }
  if (options.scope !== undefined) {
    instruction.scope = options.scope;
  }
  if (options.ifMatch !== undefined) {
    instruction.ifMatch = options.ifMatch;
  }
  if (options.createTargetIfMissing !== undefined) {
    instruction.createTargetIfMissing = options.createTargetIfMissing;
  }
  if (options.rejectIfContentPreexists !== undefined) {
    instruction.rejectIfContentPreexists = options.rejectIfContentPreexists;
  }

  if (options.operation === "delete") {
    return instruction;
  }

  if (options.scope === "parent") {
    instruction.destination = payload as PatchDestination;
  } else if (options.scope === "marker") {
    instruction.content = payload;
  } else if (options.targetType === "frontmatter") {
    // Frontmatter always uses the structured `value` carrier, including for
    // strings, numbers, booleans, arrays, objects, and null.
    instruction.value = payload;
  } else if (typeof payload === "string") {
    instruction.content = payload;
  } else {
    // Non-string block content represents structured table rows.
    instruction.value = payload;
  }

  return instruction;
}

/**
 * Patches a specific file in the vault.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param payload - The content, structured value, or move destination.
 * @param options - Patch operation details (operation, targetType, target, etc.).
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (200 OK).
 */
export async function patchFile(
  _request: RequestFunction,
  filePath: string,
  payload: PatchPayload,
  options: PatchOptions,
  context: RequestContext,
): Promise<void> {
  const instruction = buildPatchInstruction(payload, options);
  const encodedPath = encodeVaultPath(filePath);

  await _request<void>(
    {
      method: "PATCH",
      url: `/vault${encodedPath}`,
      headers: {
        "Content-Type": "application/json",
      },
      data: instruction,
    },
    context,
    "patchFile",
  );
}

/**
 * Patches the currently active file in Obsidian.
 * @param _request - The internal request function from the service instance.
 * @param payload - The content, structured value, or move destination.
 * @param options - Patch operation details.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (200 OK).
 */
export async function patchActiveFile(
  _request: RequestFunction,
  payload: PatchPayload,
  options: PatchOptions,
  context: RequestContext,
): Promise<void> {
  const instruction = buildPatchInstruction(payload, options);

  await _request<void>(
    {
      method: "PATCH",
      url: `/active/`,
      headers: {
        "Content-Type": "application/json",
      },
      data: instruction,
    },
    context,
    "patchActiveFile",
  );
}
