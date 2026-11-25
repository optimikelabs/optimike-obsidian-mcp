/**
 * Transport-independent core of the governed apply confirmation (opt-in
 * MCP_APPLY_CONFIRMATION=elicit). It builds the yes/no question for one
 * sealed plan and reads the answer. It never seals, authorizes or applies:
 * plan → apply → status → recover, CAS, idempotency and effect fences stay
 * the authority. An "accept" only confirms the plan named by its digest, and
 * it may come from a host hook or an automatic policy, so receipts say
 * "elicited", never that a human approved.
 *
 * The MCP adapter (mcp-server/applyConfirmation.ts) carries this request as
 * an input_required round (2026-07-28) or, through the SDK shim, as a
 * classic elicitation/create (2025-11-25). A future task-based apply can
 * reuse the same message, schema and response reading.
 */
import { BaseErrorCode, McpError } from "../types-global/errors.js";

/** Key of the single embedded input request of a confirmation round. */
export const APPLY_CONFIRMATION_INPUT_KEY = "apply_confirmation";

/** Receipt marker: the client answered "accept" to an elicitation. */
export const APPLY_CONFIRMATION_RECEIPT_VALUE = "elicited";

export type ApplyConfirmationSubject = {
  /** Public plan reference, as passed to the apply tool. */
  planRef: string;
  /** Public plan digest of the sealed plan the question names. */
  planDigest: string;
  /** Vault-relative target, already known to the caller. */
  target: string;
  /** Short, content-free lines (operation kinds, frontmatter key names). */
  changes: readonly string[];
};

/** What an apply runtime gives the gate after its own seal/policy checks. */
export type ApplyConfirmationTarget = ApplyConfirmationSubject & {
  /** False when apply would only replay or reconcile an existing outcome. */
  pending: boolean;
  /** Read-only check of the sealed before state (the CAS predicate). */
  beforeStateMatches(): Promise<boolean>;
};

export type ApplyConfirmationAnswer = "accept" | "decline" | "cancel";

export const APPLY_CONFIRMATION_REFUSAL_MESSAGES = {
  apply_confirmation_declined:
    "The confirmation was declined. Nothing was written. The sealed plan is unchanged; applying it again asks again.",
  apply_confirmation_cancelled:
    "The confirmation was dismissed without an answer. Nothing was written. The sealed plan is unchanged; applying it again asks again.",
  apply_confirmation_invalid:
    "The confirmation answer was missing, expired or did not match this sealed plan. Nothing was written. Apply the same plan again to be asked again.",
  apply_confirmation_unavailable:
    "The confirmation could not be shown or answered (client error, relay error or timeout). Nothing was written. The sealed plan is unchanged; applying it again asks again.",
  apply_confirmation_target_changed:
    "The note changed since planning, so no confirmation was requested and nothing was written. Call the matching status tool, then plan again from the current note.",
} as const;

export type ApplyConfirmationRefusalCode =
  keyof typeof APPLY_CONFIRMATION_REFUSAL_MESSAGES;

export const APPLY_CONFIRMATION_REFUSAL_CODES = Object.freeze(
  Object.keys(
    APPLY_CONFIRMATION_REFUSAL_MESSAGES,
  ) as ApplyConfirmationRefusalCode[],
);

export function isApplyConfirmationRefusalCode(
  value: unknown,
): value is ApplyConfirmationRefusalCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      APPLY_CONFIRMATION_REFUSAL_MESSAGES,
      value,
    )
  );
}

/**
 * The question names the target, the plan reference and a digest prefix. A
 * host that remembers "always allow" per message (T3 does) therefore only
 * re-accepts this exact plan, never later plans.
 */
export function applyConfirmationMessage(
  subject: ApplyConfirmationSubject,
): string {
  return [
    `Apply this sealed plan to “${subject.target}”?`,
    ...subject.changes.map((line) => `• ${line}`),
    `Plan ${subject.planRef} (digest ${subject.planDigest.slice(0, 12)}).`,
    "Accept writes exactly this plan. Decline writes nothing.",
  ].join("\n");
}

/** A form with no field: the answer is the elicitation action itself. */
export function applyConfirmationRequest(subject: ApplyConfirmationSubject) {
  return {
    mode: "form" as const,
    message: applyConfirmationMessage(subject),
    requestedSchema: {
      type: "object" as const,
      properties: {},
    },
  };
}

/** Reads one untrusted elicitation result; anything else is undefined. */
export function readApplyConfirmationAnswer(
  value: unknown,
): ApplyConfirmationAnswer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const action = (value as { action?: unknown }).action;
  return action === "accept" || action === "decline" || action === "cancel"
    ? action
    : undefined;
}

/** Closed public refusal; the caller already holds the plan reference. */
export function applyConfirmationRefusal(
  code: ApplyConfirmationRefusalCode,
): McpError {
  return new McpError(
    code === "apply_confirmation_target_changed"
      ? BaseErrorCode.CONFLICT
      : code === "apply_confirmation_invalid"
        ? BaseErrorCode.VALIDATION_ERROR
        : code === "apply_confirmation_unavailable"
          ? BaseErrorCode.SERVICE_UNAVAILABLE
          : BaseErrorCode.FORBIDDEN,
    APPLY_CONFIRMATION_REFUSAL_MESSAGES[code],
    {
      reason: code,
      mutationMayHaveApplied: false,
      applyAllowed: code !== "apply_confirmation_target_changed",
    },
  );
}
