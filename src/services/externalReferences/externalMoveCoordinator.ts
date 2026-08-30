import { createHash } from "node:crypto";
import path from "node:path";
import {
  ExternalRootError,
  type ExternalMoveSnapshot,
  type ExternalRootErrorCode,
  ExternalRootsService,
} from "../externalRootsService.js";
import { assertWriteAllowed } from "../writePolicy.js";
import { config } from "../../config/index.js";
import {
  BackendVaultAdapter,
  normalizeBackendVaultRelativePath,
  BackendVaultSessionChangedError,
  type BackendVaultDestructiveSession,
  sha256Text,
} from "./backendVaultAdapter.js";
import {
  ExternalMoveJournal,
  ExternalMoveJournalConcurrencyError,
  ExternalMoveJournalIdempotencyConflictError,
  isExternalMoveJournalObservationConsistent,
  type ExternalMovePlan,
  type ExternalMoveJournalObservation,
  type ExternalNoteRepair,
} from "./externalMoveJournal.js";
import {
  encodeCanonicalExternalReference,
  scanCanonicalExternalReferences,
  type ExternalReferenceOccurrence,
} from "./canonicalReferenceParser.js";

export function externalReferenceToken(
  rootId: string,
  relativePath: string,
): string {
  return encodeCanonicalExternalReference(rootId, relativePath);
}

function samePhysicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function occurrenceMentionsSource(
  occurrence: ExternalReferenceOccurrence,
  rootId: string,
  relativePath: string,
  oldFileUri: string,
  sourceAbsolutePath: string,
): boolean {
  const physicalPathMatches =
    occurrence.fileLink &&
    samePhysicalPath(occurrence.fileLink.localPath, sourceAbsolutePath);
  return (
    (occurrence.token?.rootId === rootId &&
      occurrence.token.relativePath === relativePath) ||
    occurrence.fileLink?.url === oldFileUri ||
    Boolean(physicalPathMatches)
  );
}

function replaceOccurrence(
  content: string,
  occurrence: ExternalReferenceOccurrence,
  sourceToken: string,
  targetToken: string,
  _oldFileUri: string,
  newFileUri: string,
): string {
  const start = occurrence.containerRange.start.offset;
  const end = occurrence.containerRange.end.offset;
  const original = content.slice(start, end);
  const sourceFileUri = occurrence.fileLink?.url;
  if (!sourceFileUri) {
    throw new ExternalRootError(
      "non_verifiable",
      "A canonical external reference no longer has a file locator.",
    );
  }
  const uriCount = original.split(sourceFileUri).length - 1;
  const tokenCount = original.split(sourceToken).length - 1;
  if (uriCount !== 1 || tokenCount !== 1) {
    throw new ExternalRootError(
      "non_verifiable",
      "A canonical external reference is no longer uniquely repairable.",
    );
  }
  const replacement = original
    .replace(sourceFileUri, newFileUri)
    .replace(sourceToken, targetToken);
  return content.slice(0, start) + replacement + content.slice(end);
}

export function projectExternalMovePlanForStatus(
  plan: ExternalMovePlan,
  options: {
    destructiveSessionUnavailable?: boolean;
    destructiveBindingUnavailable?: boolean;
  } = {},
): Record<string, unknown> {
  if (!isStoredPlanSafeForProjection(plan)) {
    return projectUnsafeStoredPlan(plan);
  }
  // Older journals may contain free-form diagnostic text. It remains
  // inspectable only through this value-safe incident projection; an unknown
  // code can never be silently discarded and thereby make recovery retryable.
  if (!hasRecognizedStoredFailureTaxonomy(plan)) {
    return projectStoredFailureTaxonomyIncident(plan);
  }
  let recoveryErrors = safeRecoveryCodes(plan.recoveryErrors);
  const destructiveBindingUnavailable =
    options.destructiveBindingUnavailable === true ||
    !hasCurrentDestructiveBinding(plan);
  const destructiveSessionUnavailable =
    options.destructiveSessionUnavailable === true &&
    nextActionRequiresOriginalDestructiveSession(plan.status);
  if (
    destructiveSessionUnavailable &&
    !destructiveBindingUnavailable &&
    !recoveryErrors.includes("backend_session_changed")
  ) {
    recoveryErrors = [
      ...new Set<ExternalMoveFailureCode>([
        ...recoveryErrors,
        "backend_session_changed",
      ]),
    ].sort((left, right) => left.localeCompare(right));
  }
  const automaticRecoveryBlocked =
    destructiveBindingUnavailable ||
    destructiveSessionUnavailable ||
    recoveryErrors.includes("backend_session_changed");
  // A retry is only meaningful for a bounded set of transient failures. A
  // changed file/note, invalid capability or non-verifiable placement needs a
  // human decision first; advertising rollback for those receipts would invite
  // an LLM to repeat an operation that has already failed closed.
  const manualIncidentRequired = recoveryErrors.some(
    recoveryErrorRequiresManualIncidentReview,
  );
  const manualReviewRequired =
    plan.manualReview.length > 0 || manualIncidentRequired;
  const applyActionAvailable =
    plan.status === "planned" || plan.status === "rolled_back";
  const failureCode = destructiveBindingUnavailable
    ? "external_root_non_verifiable"
    : automaticRecoveryBlocked
      ? "backend_session_changed"
      : safeStoredFailureCode(plan.failure);
  const recoveryRequired =
    automaticRecoveryBlocked ||
    plan.status === "recovery_required" ||
    recoveryErrors.length > 0;
  return {
    planId: plan.planId,
    idempotencyKey: plan.idempotencyKey,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    status: automaticRecoveryBlocked ? "recovery_required" : plan.status,
    rootId: plan.snapshot.rootId,
    sourceRelativePath: plan.snapshot.sourceRelativePath,
    targetRelativePath: plan.snapshot.targetRelativePath,
    sourceSha256: plan.snapshot.sha256,
    sourceSize: plan.snapshot.size,
    inventoryDigest: plan.inventoryDigest,
    bindingVerifiable: hasCurrentDestructiveBinding(plan),
    legacyBinding: !hasCurrentDestructiveBinding(plan),
    repairs: plan.repairs.map((repair) => ({
      filePath: repair.filePath,
      expectedSha256: repair.expectedSha256,
    })),
    manualReview: plan.manualReview,
    readyToApply:
      !automaticRecoveryBlocked &&
      !manualReviewRequired &&
      applyActionAvailable,
    recoveryRequired,
    recoveryErrors,
    appliedRepairCount: plan.appliedRepairPaths?.length ?? 0,
    restoredRepairCount: plan.restoredRepairPaths?.length ?? 0,
    nextAction:
      automaticRecoveryBlocked || manualReviewRequired
        ? "manual_review"
        : plan.status === "planned" || plan.status === "rolled_back"
          ? "apply"
          : plan.status === "applied"
            ? "rollback"
            : plan.status === "failed_compensated"
              ? "rollback"
              : recoveryRequired ||
                  [
                    "applying",
                    "applying_file",
                    "file_moved",
                    "applying_repairs",
                    "rolling_back",
                    "rolling_back_repairs",
                    "rolling_back_file",
                    "failed",
                  ].includes(plan.status)
                ? "rollback"
                : "none",
    ...(failureCode
      ? {
          failureCode,
          failure: publicFailureMessage(failureCode),
        }
      : {}),
  };
}

const MANUAL_REVIEW_REASON_PHYSICAL_PATH =
  "Legacy or unsupported occurrence contains the physical path.";
const MANUAL_REVIEW_REASON_AMBIGUOUS =
  "Reference is ambiguous, historical, or not an exact canonical pair.";
const MANUAL_REVIEW_REASONS = new Set([
  MANUAL_REVIEW_REASON_PHYSICAL_PATH,
  MANUAL_REVIEW_REASON_AMBIGUOUS,
]);
const EXTERNAL_MOVE_PLAN_STATUSES = new Set<ExternalMovePlan["status"]>([
  "planned",
  "applying_file",
  "file_moved",
  "applying_repairs",
  "applied",
  "rolling_back_repairs",
  "rolling_back_file",
  "rolled_back",
  "failed_compensated",
  "recovery_required",
  "applying",
  "rolling_back",
  "failed",
]);

/**
 * SQLite receipts are durable but not a trust boundary. A malformed legacy or
 * locally-tampered row is readable only as a redacted incident, never as an
 * instruction carrying a backend path into a later read/write operation.
 */
function projectUnsafeStoredPlan(
  plan: ExternalMovePlan,
): Record<string, unknown> {
  const recoveryErrors = [
    ...new Set<ExternalMoveFailureCode>([
      ...safeRecoveryCodes(plan.recoveryErrors),
      "external_root_non_verifiable",
    ]),
  ].sort((left, right) => left.localeCompare(right));
  return {
    // A malformed journal is untrusted as a whole: even identifiers and
    // timestamps may be attacker-controlled values, so the incident view is
    // deliberately value-free rather than selectively echoing strings.
    planId: "[redacted]",
    idempotencyKey: "[redacted]",
    createdAt: undefined,
    updatedAt: undefined,
    status: "recovery_required",
    rootId: "[redacted]",
    sourceRelativePath: "[redacted]",
    targetRelativePath: "[redacted]",
    bindingVerifiable: false,
    legacyBinding: true,
    repairs: [],
    manualReview: [
      {
        filePath: "[redacted]",
        reason: "Stored journal data requires manual review.",
      },
    ],
    readyToApply: false,
    recoveryRequired: true,
    recoveryErrors,
    appliedRepairCount: 0,
    restoredRepairCount: 0,
    nextAction: "manual_review",
    failureCode: "external_root_non_verifiable",
    failure: publicFailureMessage("external_root_non_verifiable"),
  };
}

/**
 * Preserve structurally safe legacy receipts while redacting any unknown
 * diagnostic value. This must stay separate from a malformed-path incident:
 * the former can identify its safe target for human review but never grants a
 * continuation, while the latter cannot safely expose any stored value.
 */
function projectStoredFailureTaxonomyIncident(
  plan: ExternalMovePlan,
): Record<string, unknown> {
  return projectExternalMovePlanForStatus({
    ...plan,
    status: "recovery_required",
    failure: "external_root_non_verifiable",
    recoveryErrors: ["external_root_non_verifiable"],
  });
}

function isSafeSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function isSafeUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isSafeIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\p{Cc}]/u.test(value)
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    // Journal receipts must already be canonical. Silently normalizing a
    // legacy backslash path would make two persisted spellings reach one vault
    // entry and would weaken the binding/inventory proof.
    return normalizeBackendVaultRelativePath(value) === value;
  } catch {
    return false;
  }
}

function isSafeTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isStoredPlanSafeForProjection(plan: ExternalMovePlan): boolean {
  const snapshot = plan.snapshot;
  if (
    !isSafeUuid(plan.planId) ||
    !isSafeIdempotencyKey(plan.idempotencyKey) ||
    !isSafeTimestamp(plan.createdAt) ||
    !isSafeTimestamp(plan.updatedAt) ||
    !EXTERNAL_MOVE_PLAN_STATUSES.has(plan.status) ||
    !snapshot ||
    typeof snapshot.rootId !== "string" ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(snapshot.rootId) ||
    !isSafeRelativePath(snapshot.sourceRelativePath) ||
    !isSafeRelativePath(snapshot.targetRelativePath) ||
    snapshot.sourceRelativePath === snapshot.targetRelativePath ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size < 0 ||
    !isSafeTimestamp(snapshot.modifiedAt) ||
    !isSafeSha256(snapshot.sha256) ||
    !isSafeSha256(plan.inventoryDigest) ||
    plan.sourceToken !==
      externalReferenceToken(snapshot.rootId, snapshot.sourceRelativePath) ||
    plan.targetToken !==
      externalReferenceToken(snapshot.rootId, snapshot.targetRelativePath)
  ) {
    return false;
  }
  if (
    !Array.isArray(plan.repairs) ||
    !plan.repairs.every(
      (repair) =>
        repair &&
        isSafeRelativePath(repair.filePath) &&
        isSafeSha256(repair.expectedSha256) &&
        typeof repair.before === "string" &&
        typeof repair.after === "string" &&
        repair.expectedSha256 === sha256Text(repair.before),
    ) ||
    !Array.isArray(plan.manualReview) ||
    !plan.manualReview.every(
      (item) =>
        item &&
        isSafeRelativePath(item.filePath) &&
        typeof item.reason === "string" &&
        MANUAL_REVIEW_REASONS.has(item.reason),
    ) ||
    !Array.isArray(plan.appliedRepairPaths) ||
    !plan.appliedRepairPaths.every(isSafeRelativePath) ||
    !Array.isArray(plan.restoredRepairPaths) ||
    !plan.restoredRepairPaths.every(isSafeRelativePath)
  ) {
    return false;
  }
  const repairPaths = new Set(plan.repairs.map((repair) => repair.filePath));
  if (
    !plan.appliedRepairPaths.every((filePath) => repairPaths.has(filePath)) ||
    !plan.restoredRepairPaths.every((filePath) => repairPaths.has(filePath))
  ) {
    return false;
  }
  return true;
}

function assertStoredPlanSafeForBackend(plan: ExternalMovePlan): void {
  if (
    !isStoredPlanSafeForProjection(plan) ||
    !hasRecognizedStoredFailureTaxonomy(plan) ||
    !hasCurrentDestructiveBinding(plan)
  ) {
    throw new ExternalRootError(
      "non_verifiable",
      "Stored external move data cannot be safely verified for a backend operation.",
    );
  }
}

function isSafeObservedPlan(observed: ExternalMoveJournalObservation): boolean {
  return (
    isExternalMoveJournalObservationConsistent(observed) &&
    isStoredPlanSafeForProjection(observed.plan) &&
    isSafeUuid(observed.plan.planId) &&
    isSafeIdempotencyKey(observed.plan.idempotencyKey)
  );
}

function assertObservedPlanSafeForBackend(
  observed: ExternalMoveJournalObservation,
): void {
  if (
    !isSafeObservedPlan(observed) ||
    !hasRecognizedStoredFailureTaxonomy(observed.plan) ||
    !hasCurrentDestructiveBinding(observed.plan)
  ) {
    throw new ExternalRootError(
      "non_verifiable",
      "Stored external move data cannot be safely verified for a backend operation.",
    );
  }
}

/**
 * A journal can remain inspectable when its originating backend cannot be
 * authenticated, but it must never advertise an apply, rollback, or recovery
 * continuation against a replacement session. This is projection-only: status
 * reads must not mutate a durable receipt merely because they lack authority
 * to continue it.
 */
export function projectExternalMovePlanForUnavailableDestructiveSession(
  plan: ExternalMovePlan,
): Record<string, unknown> {
  return projectExternalMovePlanForStatus(plan, {
    destructiveSessionUnavailable: true,
  });
}

/**
 * Journals written before backend vault attestation are intentionally
 * inspectable for incident recovery, but must never acquire a new target by
 * virtue of an upgrade. Destructive continuations require this exact schema.
 */
function hasCurrentDestructiveBinding(plan: ExternalMovePlan): boolean {
  return (
    plan.bindingIdentity?.schemaVersion === 2 &&
    isSafeSha256(plan.bindingIdentity.backendFingerprint) &&
    isSafeSha256(plan.bindingIdentity.vaultFingerprint) &&
    isSafeSha256(plan.bindingIdentity.rootConfigFingerprint) &&
    isSafeSha256(plan.bindingIdentity.bindingFingerprint) &&
    plan.bindingIdentity.vaultIdentitySource ===
      "backend_destructive_vault_attestation" &&
    plan.bindingIdentity.verifiable === true &&
    isSafeUuid(plan.destructiveSession?.sessionId) &&
    Number.isSafeInteger(plan.destructiveSession.generation) &&
    plan.destructiveSession.generation >= 0 &&
    plan.destructiveSession.bindingFingerprint ===
      plan.bindingIdentity.bindingFingerprint
  );
}

/**
 * A file-backed proxy snapshot may have been admitted only because its binding
 * matched this coordinator. If the writable journal reload returns another
 * structurally-valid receipt, it is still not this sealed operation: never let
 * that replacement receipt inherit the snapshot's authority just because it
 * uses the same plan ID, binding, or session.
 */
function hasSameSealedOperationIdentity(
  expected: ExternalMovePlan,
  candidate: ExternalMovePlan,
): boolean {
  const sameRepairs =
    expected.repairs.length === candidate.repairs.length &&
    expected.repairs.every((repair, index) => {
      const other = candidate.repairs[index];
      return (
        other !== undefined &&
        repair.filePath === other.filePath &&
        repair.expectedSha256 === other.expectedSha256 &&
        repair.before === other.before &&
        repair.after === other.after
      );
    });
  const sameManualReview =
    expected.manualReview.length === candidate.manualReview.length &&
    expected.manualReview.every((item, index) => {
      const other = candidate.manualReview[index];
      return (
        other !== undefined &&
        item.filePath === other.filePath &&
        item.reason === other.reason
      );
    });
  return (
    // Every persisted field is either sealed here or is an explicit mutable
    // execution outcome: status, updatedAt, failure, recoveryErrors,
    // appliedRepairPaths, and restoredRepairPaths. Do not make a new durable
    // reconciliation from a receipt whose original intent changed.
    expected.planId === candidate.planId &&
    expected.idempotencyKey === candidate.idempotencyKey &&
    expected.createdAt === candidate.createdAt &&
    snapshotsMatch(expected.snapshot, candidate.snapshot) &&
    expected.bindingIdentity.schemaVersion ===
      candidate.bindingIdentity.schemaVersion &&
    expected.bindingIdentity.backendFingerprint ===
      candidate.bindingIdentity.backendFingerprint &&
    expected.bindingIdentity.vaultFingerprint ===
      candidate.bindingIdentity.vaultFingerprint &&
    expected.bindingIdentity.rootConfigFingerprint ===
      candidate.bindingIdentity.rootConfigFingerprint &&
    expected.bindingIdentity.bindingFingerprint ===
      candidate.bindingIdentity.bindingFingerprint &&
    expected.bindingIdentity.vaultIdentitySource ===
      candidate.bindingIdentity.vaultIdentitySource &&
    expected.bindingIdentity.verifiable ===
      candidate.bindingIdentity.verifiable &&
    expected.destructiveSession.generation ===
      candidate.destructiveSession.generation &&
    expected.destructiveSession.sessionId ===
      candidate.destructiveSession.sessionId &&
    expected.destructiveSession.bindingFingerprint ===
      candidate.destructiveSession.bindingFingerprint &&
    expected.sourceToken === candidate.sourceToken &&
    expected.targetToken === candidate.targetToken &&
    expected.oldFileUri === candidate.oldFileUri &&
    expected.newFileUri === candidate.newFileUri &&
    expected.inventoryDigest === candidate.inventoryDigest &&
    sameRepairs &&
    sameManualReview
  );
}

type Inventory = {
  repairs: ExternalNoteRepair[];
  manualReview: Array<{ filePath: string; reason: string }>;
  candidatePaths: string[];
};

type FilePlacement = "source" | "target" | "both" | "missing_or_changed";

function inventoryDigest(inventory: Inventory): string {
  const payload = {
    candidatePaths: [...inventory.candidatePaths].sort((left, right) =>
      left.localeCompare(right),
    ),
    repairs: inventory.repairs
      .map((repair) => ({
        filePath: repair.filePath,
        expectedSha256: repair.expectedSha256,
        afterSha256: sha256Text(repair.after),
      }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath)),
    manualReview: inventory.manualReview
      .map((item) => ({ filePath: item.filePath, reason: item.reason }))
      .sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) ||
          left.reason.localeCompare(right.reason),
      ),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function snapshotsMatch(
  left: ExternalMoveSnapshot,
  right: ExternalMoveSnapshot,
): boolean {
  return (
    left.rootId === right.rootId &&
    left.sourceRelativePath === right.sourceRelativePath &&
    left.targetRelativePath === right.targetRelativePath &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.sha256 === right.sha256
  );
}

type ExternalMoveFailureCode =
  | "backend_session_changed"
  | "backend_failure"
  | "compensation_failed"
  | "journal_missing"
  | `external_root_${ExternalRootErrorCode}`;

const EXTERNAL_ROOT_ERROR_CODES = [
  "configuration_invalid",
  "root_unknown",
  "root_unavailable",
  "capability_denied",
  "path_invalid",
  "path_outside_root",
  "path_not_allowed",
  "path_link_unsupported",
  "not_found",
  "not_a_file",
  "not_a_directory",
  "target_exists",
  "precondition_failed",
  "too_large",
  "unsupported",
  "encrypted",
  "inaccessible",
  "non_verifiable",
  "timeout",
] as const satisfies readonly ExternalRootErrorCode[];

type MissingExternalRootErrorCode = Exclude<
  ExternalRootErrorCode,
  (typeof EXTERNAL_ROOT_ERROR_CODES)[number]
>;
const EXTERNAL_ROOT_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  EXTERNAL_ROOT_ERROR_CODES.map((code) => `external_root_${code}`),
);
const EXTERNAL_ROOT_ERROR_CODES_ARE_EXHAUSTIVE: MissingExternalRootErrorCode extends never
  ? true
  : never = true;
void EXTERNAL_ROOT_ERROR_CODES_ARE_EXHAUSTIVE;

function failureCode(error: unknown): ExternalMoveFailureCode {
  if (error instanceof BackendVaultSessionChangedError) {
    return "backend_session_changed";
  }
  if (error instanceof ExternalRootError) {
    return `external_root_${error.code}`;
  }
  return "backend_failure";
}

function safeStoredFailureCode(
  value: unknown,
): ExternalMoveFailureCode | undefined {
  if (value === "backend_session_changed") return value;
  if (
    value === "backend_failure" ||
    value === "compensation_failed" ||
    value === "journal_missing"
  ) {
    return value;
  }
  if (typeof value === "string" && EXTERNAL_ROOT_ERROR_CODE_SET.has(value)) {
    return value as ExternalMoveFailureCode;
  }
  return undefined;
}

// Journal contents are untrusted input. Keep an attacker-controlled array from
// becoming an unbounded status/read amplification even on the status-only path.
const MAX_STORED_RECOVERY_ERRORS = 32;

function hasRecognizedStoredFailureTaxonomy(plan: ExternalMovePlan): boolean {
  return (
    (plan.failure === undefined ||
      safeStoredFailureCode(plan.failure) !== undefined) &&
    Array.isArray(plan.recoveryErrors) &&
    plan.recoveryErrors.length <= MAX_STORED_RECOVERY_ERRORS &&
    plan.recoveryErrors.every(
      (recoveryError) => safeStoredFailureCode(recoveryError) !== undefined,
    )
  );
}

function safeRecoveryCodes(values: unknown): ExternalMoveFailureCode[] {
  if (!Array.isArray(values) || values.length > MAX_STORED_RECOVERY_ERRORS)
    return [];
  const codes = values.map((value) => safeStoredFailureCode(value));
  return [
    ...new Set(
      codes.filter((value): value is ExternalMoveFailureCode => Boolean(value)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

const RETRYABLE_RECOVERY_FAILURE_CODES = new Set<ExternalMoveFailureCode>([
  "backend_failure",
  "external_root_root_unavailable",
  "external_root_inaccessible",
  "external_root_timeout",
]);

/**
 * Only transport/availability failures can be retried as a governed recovery.
 * Every other code means an external invariant, policy, identity or content
 * precondition changed and therefore requires a human incident decision.
 */
function recoveryErrorRequiresManualIncidentReview(
  code: ExternalMoveFailureCode,
): boolean {
  return !RETRYABLE_RECOVERY_FAILURE_CODES.has(code);
}

function publicFailureMessage(code: ExternalMoveFailureCode): string {
  if (code === "backend_session_changed") {
    return "The backend session changed after this move began. Automatic recovery is disabled; retain the plan for manual incident review.";
  }
  return "The external move did not complete. Review the stable failure code before retrying.";
}

function externalFailure(error: unknown): ExternalRootError {
  const code =
    error instanceof ExternalRootError ? error.code : "non_verifiable";
  return new ExternalRootError(
    code,
    "The external move did not complete. Review its durable status before retrying.",
  );
}

function isExternalMoveConcurrentStateChange(error: unknown): boolean {
  return (
    error instanceof ExternalMoveJournalConcurrencyError ||
    (error instanceof Error &&
      error.message === "External move plan state changed concurrently.")
  );
}

/** States whose public nextAction would require the sealed session. */
function nextActionRequiresOriginalDestructiveSession(
  status: ExternalMovePlan["status"],
): boolean {
  return [
    "planned",
    "rolled_back",
    "applied",
    "failed_compensated",
    "applying",
    "applying_file",
    "file_moved",
    "applying_repairs",
    "rolling_back",
    "rolling_back_repairs",
    "rolling_back_file",
    "failed",
    "recovery_required",
  ].includes(status);
}

/** States that may already need a durable manual-recovery receipt. */
function needsSessionFence(status: ExternalMovePlan["status"]): boolean {
  return [
    "applying",
    "applying_file",
    "file_moved",
    "applying_repairs",
    "rolling_back",
    "rolling_back_repairs",
    "rolling_back_file",
    "failed",
  ].includes(status);
}

function needsDurableSessionFailureReconciliation(
  status: ExternalMovePlan["status"],
): boolean {
  return needsSessionFence(status) || status === "recovery_required";
}

function protectedFrontmatterLines(content: string): Map<string, string> {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return new Map();
  const result = new Map<string, string>();
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") break;
    const match = /^(création|modification):(.*)$/u.exec(lines[index]);
    if (match) result.set(match[1], lines[index]);
  }
  return result;
}

function normalizeProtectedFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return content;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") break;
    if (/^(création|modification):/u.test(lines[index])) {
      lines.splice(index, 1);
      index -= 1;
    }
  }
  return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
}

function preserveCurrentProtectedFrontmatter(
  template: string,
  current: string,
): string {
  const currentLines = protectedFrontmatterLines(current);
  if (currentLines.size === 0) return template;
  const lines = template.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return template;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      for (const [key, value] of currentLines) {
        if (!lines.some((line) => line.startsWith(`${key}:`))) {
          lines.splice(index, 0, value);
          index += 1;
        }
      }
      break;
    }
    const match = /^(création|modification):/u.exec(lines[index]);
    if (match && currentLines.has(match[1])) {
      lines[index] = currentLines.get(match[1])!;
    }
  }
  return lines.join(template.includes("\r\n") ? "\r\n" : "\n");
}

export class ExternalMoveCoordinator {
  private journalInstance: ExternalMoveJournal | undefined;
  private readonly journalFactory: () => ExternalMoveJournal;

  constructor(
    private readonly roots: ExternalRootsService,
    private readonly vault: BackendVaultAdapter,
    journal: ExternalMoveJournal | (() => ExternalMoveJournal),
  ) {
    if (typeof journal === "function") {
      this.journalFactory = journal;
    } else {
      this.journalInstance = journal;
      this.journalFactory = () => journal;
    }
  }

  private get journal(): ExternalMoveJournal {
    this.journalInstance ??= this.journalFactory();
    return this.journalInstance;
  }

  async scan(
    rootId: string,
    relativePath: string,
  ): Promise<Record<string, unknown>> {
    await this.vault.refreshInventory();
    const snapshot = await this.roots.inspectMoveSource(rootId, relativePath);
    return this.inventory(snapshot);
  }

  async plan(input: {
    rootId: string;
    sourceRelativePath: string;
    targetRelativePath: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const existing = this.journal.observeByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (!isSafeObservedPlan(existing)) {
        // Do not dereference a hostile snapshot just because its idempotency
        // key collides. The existing receipt remains an incident read only.
        return projectUnsafeStoredPlan(existing.plan);
      }
      const sameRequest =
        existing.plan.snapshot.rootId === input.rootId &&
        existing.plan.snapshot.sourceRelativePath ===
          input.sourceRelativePath &&
        existing.plan.snapshot.targetRelativePath === input.targetRelativePath;
      if (!sameRequest) {
        throw new ExternalRootError(
          "precondition_failed",
          "The idempotency key is already bound to another external move.",
        );
      }
      return this.status(existing.plan.planId, existing.plan);
    }

    // Re-attest before we inspect either mutable surface. A same-endpoint
    // backend swap must not be able to seal a new plan against Proxy A's root.
    const bindingIdentity = await this.vault.getBindingIdentity(true);
    if (!bindingIdentity.verifiable) {
      throw new ExternalRootError(
        "non_verifiable",
        "External move planning requires a verifiable backend vault target.",
      );
    }
    const destructiveSession =
      await this.vault.captureDestructiveSession(bindingIdentity);
    const snapshot = await this.roots.planMove(
      input.rootId,
      input.sourceRelativePath,
      input.targetRelativePath,
    );
    const locations = await this.roots.getPrivateMoveLocations(snapshot);
    const sourceToken = externalReferenceToken(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const targetToken = externalReferenceToken(
      snapshot.rootId,
      snapshot.targetRelativePath,
    );
    await this.vault.refreshInventory(destructiveSession);
    const inventory = await this.inventoryInternal(
      snapshot,
      locations.sourceFileUri,
      locations.targetFileUri,
      sourceToken,
      targetToken,
      destructiveSession,
    );
    const digest = inventoryDigest(inventory);
    // No backend observation after capture may escape the session fence. A
    // reconnect between the final read and durable create rejects the plan
    // instead of sealing a mixed-generation inventory.
    this.vault.assertDestructiveSession(destructiveSession);
    try {
      const created = this.journal.createOrLoad(
        {
          idempotencyKey: input.idempotencyKey,
          snapshot,
          bindingIdentity,
          destructiveSession,
          sourceToken,
          targetToken,
          oldFileUri: locations.sourceFileUri,
          newFileUri: locations.targetFileUri,
          repairs: inventory.repairs,
          manualReview: inventory.manualReview,
          inventoryDigest: digest,
          appliedRepairPaths: [],
          restoredRepairPaths: [],
          recoveryErrors: [],
        },
        {
          // Identical public inputs replay the durable winner even when its
          // sealing read observed an earlier source revision. A different
          // logical move under the same key is never adopted.
          isCompatible: (winner) =>
            isStoredPlanSafeForProjection(winner) &&
            winner.snapshot.rootId === input.rootId &&
            winner.snapshot.sourceRelativePath === input.sourceRelativePath &&
            winner.snapshot.targetRelativePath === input.targetRelativePath,
        },
      );
      return created.created
        ? projectExternalMovePlanForStatus(created.plan)
        : this.status(created.plan.planId, created.plan);
    } catch (error) {
      if (error instanceof ExternalMoveJournalIdempotencyConflictError) {
        throw new ExternalRootError(
          "precondition_failed",
          "The idempotency key is already bound to another external move.",
        );
      }
      throw error;
    }
  }

  status(
    planId: string,
    preloadedPlan?: ExternalMovePlan,
  ): Record<string, unknown> {
    let observed = preloadedPlan ? undefined : this.requireObservation(planId);
    let plan = preloadedPlan ?? observed!.plan;
    // Do not even consult a stored session when the receipt itself contains
    // untrusted paths or metadata. This is a no-write incident projection.
    if (
      (preloadedPlan && preloadedPlan.planId !== planId) ||
      !isStoredPlanSafeForProjection(plan) ||
      (observed && !isSafeObservedPlan(observed))
    ) {
      return projectUnsafeStoredPlan(plan);
    }
    if (!hasCurrentDestructiveBinding(plan)) {
      return projectExternalMovePlanForStatus(plan, {
        destructiveBindingUnavailable: true,
      });
    }
    // A plan may survive a proxy restart in SQLite, but its private session
    // fence may not. Never advertise a continuation against a replacement
    // backend. Partial receipts are durably marked for manual incident review;
    // non-partial receipts remain immutable and receive an ephemeral status
    // projection only.
    if (
      nextActionRequiresOriginalDestructiveSession(plan.status) &&
      !this.vault.isDestructiveSessionCurrent(plan.destructiveSession)
    ) {
      return this.projectStaleSessionStatus(planId, plan, observed);
    }
    return projectExternalMovePlanForStatus(plan);
  }

  private projectStaleSessionStatus(
    planId: string,
    validatedPlan: ExternalMovePlan,
    observed?: ExternalMoveJournalObservation,
  ): Record<string, unknown> {
    let plan = validatedPlan;
    if (needsDurableSessionFailureReconciliation(plan.status)) {
      // A preloaded file-backed receipt came from a read-only SQLite handle.
      // Re-read the writable journal before guarded durable reconciliation.
      if (!observed) observed = this.requireObservation(planId);
      plan = observed.plan;
      if (
        !isSafeObservedPlan(observed) ||
        !hasCurrentDestructiveBinding(plan)
      ) {
        return projectUnsafeStoredPlan(plan);
      }
      // The preloaded receipt was admitted against this coordinator binding by
      // the stdio proxy. A later writable reload is not entitled to that
      // authority merely because the plan ID still matches: another process or
      // a tampered journal could have replaced its binding, session, or sealed
      // operation intent. This is deliberately projection-only, before any
      // durable CAS or backend call.
      if (!hasSameSealedOperationIdentity(validatedPlan, plan)) {
        return projectExternalMovePlanForUnavailableDestructiveSession(
          validatedPlan,
        );
      }
      if (needsDurableSessionFailureReconciliation(plan.status)) {
        try {
          observed = this.markRecoveryRequired(
            observed,
            "backend_session_changed",
          );
          plan = observed.plan;
        } catch (error) {
          if (!isExternalMoveConcurrentStateChange(error)) throw error;
          // Another status/recovery executor won the guarded transition. Its
          // fresh durable state is authoritative; never retry a stale update.
          observed = this.requireObservation(planId);
          plan = observed.plan;
          if (
            !isSafeObservedPlan(observed) ||
            !hasCurrentDestructiveBinding(plan)
          ) {
            return projectUnsafeStoredPlan(plan);
          }
          // The loser must apply the same authority fence after its reload. A
          // concurrent status/recovery process can replace the row between the
          // failed observed-CAS and this read; do not project or mutate that
          // other receipt under the original snapshot's authority.
          if (!hasSameSealedOperationIdentity(validatedPlan, plan)) {
            return projectExternalMovePlanForUnavailableDestructiveSession(
              validatedPlan,
            );
          }
        }
      }
    }
    // The plan may have terminalized while a read-only snapshot was being
    // reloaded or while another executor reconciled it. Re-evaluate after
    // every durable read/attempt: a stale process must never re-advertise
    // apply, rollback, or recovery for that newer terminal receipt.
    if (
      nextActionRequiresOriginalDestructiveSession(plan.status) &&
      !this.vault.isDestructiveSessionCurrent(plan.destructiveSession)
    ) {
      return projectExternalMovePlanForUnavailableDestructiveSession(plan);
    }
    return projectExternalMovePlanForStatus(plan);
  }

  private requireObservation(planId: string): ExternalMoveJournalObservation {
    const observed = this.journal.observe(planId);
    if (!observed || observed.plan.planId !== planId) {
      throw new ExternalRootError("not_found", "Unknown external move plan.");
    }
    return observed;
  }

  async apply(
    planId: string,
    idempotencyKey: string,
    options: { allowCompensatedReapply?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let observed = this.requireObservedPlan(planId, idempotencyKey);
    let plan = observed.plan;
    if (plan.status === "applied") return this.status(planId, plan);
    const applicableStatuses: ExternalMovePlan["status"][] =
      options.allowCompensatedReapply === false
        ? ["planned"]
        : ["planned", "rolled_back"];
    if (!applicableStatuses.includes(plan.status)) {
      throw new ExternalRootError(
        "precondition_failed",
        `External move plan is ${plan.status}, not applicable.`,
      );
    }
    if (!config.externalMoveEnabled) {
      throw new ExternalRootError(
        "capability_denied",
        "External move apply is disabled by MCP_EXTERNAL_MOVE_ENABLED.",
      );
    }
    assertWriteAllowed({
      operation: "external_move_apply",
      action: "apply",
      destructive: true,
    });
    if (plan.manualReview.length > 0) {
      throw new ExternalRootError(
        "precondition_failed",
        "Ambiguous or historical references require manual review before apply.",
      );
    }

    if (!plan.inventoryDigest) {
      throw new ExternalRootError(
        "precondition_failed",
        "This plan predates inventory digests. Create a new plan with a new idempotency key.",
      );
    }
    const session = await this.openDestructiveSession(plan, observed);

    const currentSnapshot = await this.roots.planMove(
      plan.snapshot.rootId,
      plan.snapshot.sourceRelativePath,
      plan.snapshot.targetRelativePath,
    );
    if (!snapshotsMatch(currentSnapshot, plan.snapshot)) {
      throw new ExternalRootError(
        "precondition_failed",
        "The external source changed after planning.",
      );
    }
    const locations = await this.roots.getPrivateMoveLocations(currentSnapshot);
    await this.vault.refreshInventory(session);
    const currentInventory = await this.inventoryInternal(
      currentSnapshot,
      locations.sourceFileUri,
      locations.targetFileUri,
      plan.sourceToken,
      plan.targetToken,
      session,
    );
    if (inventoryDigest(currentInventory) !== plan.inventoryDigest) {
      throw new ExternalRootError(
        "precondition_failed",
        "The complete ÉLYSIA reference inventory changed after planning.",
      );
    }
    await this.vault.assertConditionalWritesSupported(session);

    observed = this.journal.transitionObserved(
      observed,
      applicableStatuses,
      "applying_file",
      {
        appliedRepairPaths: [],
        restoredRepairPaths: [],
        recoveryErrors: [],
      },
    );
    plan = observed.plan;
    assertStoredPlanSafeForBackend(plan);
    try {
      this.vault.assertDestructiveSession(session);
      await this.roots.applyMove(plan.snapshot);
      observed = this.journal.transitionObserved(
        observed,
        ["applying_file"],
        "file_moved",
      );
      plan = observed.plan;
      assertStoredPlanSafeForBackend(plan);
      observed = this.journal.transitionObserved(
        observed,
        ["file_moved"],
        "applying_repairs",
      );
      plan = observed.plan;
      assertStoredPlanSafeForBackend(plan);
      for (const repair of plan.repairs) {
        await this.vault.conditionalReplace(
          repair.filePath,
          repair.before,
          repair.after,
          repair.expectedSha256,
          session,
        );
        observed = this.journal.recordAppliedRepairObserved(
          observed,
          repair.filePath,
        );
        plan = observed.plan;
        assertStoredPlanSafeForBackend(plan);
      }
      const committed = this.journal.updateObserved(observed, "applied");
      return projectExternalMovePlanForStatus(committed.plan);
    } catch (error) {
      const compensation = await this.compensateApply(observed, error, session);
      if (compensation.length > 0) {
        throw new ExternalRootError(
          "non_verifiable",
          "The external move requires manual incident review; automatic compensation was not completed.",
        );
      }
      throw externalFailure(error);
    }
  }

  async rollback(
    planId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    let observed = this.requireObservedPlan(planId, idempotencyKey);
    let plan = observed.plan;
    if (plan.status === "rolled_back") return this.status(planId, plan);
    const recoverableStatuses: ExternalMovePlan["status"][] = [
      "planned",
      "failed_compensated",
      "applied",
      "applying",
      "applying_file",
      "file_moved",
      "applying_repairs",
      "rolling_back",
      "rolling_back_repairs",
      "rolling_back_file",
      "failed",
      "recovery_required",
    ];
    if (!recoverableStatuses.includes(plan.status)) {
      throw new ExternalRootError(
        "precondition_failed",
        `External move plan is ${plan.status}, not rollbackable.`,
      );
    }
    if (
      safeRecoveryCodes(plan.recoveryErrors).some(
        recoveryErrorRequiresManualIncidentReview,
      )
    ) {
      throw new ExternalRootError(
        "precondition_failed",
        "This external move incident requires manual review before recovery can continue.",
      );
    }
    if (!config.externalMoveEnabled) {
      throw new ExternalRootError(
        "capability_denied",
        "External move rollback is disabled by MCP_EXTERNAL_MOVE_ENABLED.",
      );
    }
    assertWriteAllowed({
      operation: "external_move_rollback",
      action: "rollback",
      destructive: true,
    });
    const session = await this.openDestructiveSession(plan, observed);
    // This is a non-mutating capability check. Run it before claiming the
    // durable receipt so an unavailable CAS backend does not turn an otherwise
    // untouched rollback into an in-flight incident.
    await this.vault.assertConditionalWritesSupported(session);
    if (plan.status === "planned" || plan.status === "failed_compensated") {
      return projectExternalMovePlanForStatus(
        this.journal.transitionObserved(
          observed,
          [plan.status],
          "rolled_back",
          {
            recoveryErrors: [],
          },
        ).plan,
      );
    }
    try {
      // Claim the rollback from the exact checked receipt before any backend
      // read or filesystem recovery. A concurrent executor must win by CAS,
      // never be silently adopted by this rollback path.
      observed = this.journal.transitionObserved(
        observed,
        recoverableStatuses,
        "rolling_back_repairs",
        { recoveryErrors: [] },
      );
      plan = observed.plan;
      assertObservedPlanSafeForBackend(observed);
      // From this point this executor owns the exact receipt. No filesystem
      // observation or mutation may precede the guarded claim above.
      let placement = await this.inspectFilePlacement(plan.snapshot);
      if (placement === "both") {
        this.vault.assertDestructiveSession(session);
        await this.roots.recoverMoveToSource(plan.snapshot);
        placement = await this.inspectFilePlacement(plan.snapshot);
      }
      if (placement === "missing_or_changed" || placement === "both") {
        throw new ExternalRootError(
          "non_verifiable",
          `External file placement is ${placement}; automatic rollback is unsafe.`,
        );
      }
      const rollbackContents = await this.prepareRollbackContents(
        plan,
        session,
      );
      for (const repair of [...plan.repairs].reverse()) {
        const rollback = rollbackContents.get(repair.filePath);
        if (rollback) {
          await this.vault.conditionalReplace(
            repair.filePath,
            rollback.current,
            rollback.restored,
            sha256Text(rollback.current),
            session,
          );
        }
        observed = this.journal.recordRestoredRepairObserved(
          observed,
          repair.filePath,
        );
        plan = observed.plan;
        assertStoredPlanSafeForBackend(plan);
      }
      observed = this.journal.transitionObserved(
        observed,
        ["rolling_back_repairs"],
        "rolling_back_file",
      );
      plan = observed.plan;
      assertStoredPlanSafeForBackend(plan);
      this.vault.assertDestructiveSession(session);
      if ((await this.inspectFilePlacement(plan.snapshot)) === "target") {
        await this.roots.rollbackMove(plan.snapshot);
      }
      return projectExternalMovePlanForStatus(
        this.journal.updateObserved(observed, "rolled_back").plan,
      );
    } catch (error) {
      const code = failureCode(error);
      if (isSafeObservedPlan(observed)) {
        try {
          this.journal.updateObserved(observed, "recovery_required", code, {
            recoveryErrors: [code],
          });
        } catch {
          // The winner is not ours to reload or overwrite.
        }
      }
      throw externalFailure(error);
    }
  }

  private requirePlan(
    planId: string,
    idempotencyKey: string,
  ): ExternalMovePlan {
    return this.requireObservedPlan(planId, idempotencyKey).plan;
  }

  private requireObservedPlan(
    planId: string,
    idempotencyKey: string,
  ): ExternalMoveJournalObservation {
    const observed = this.journal.observe(planId);
    if (
      !observed ||
      observed.plan.planId !== planId ||
      observed.plan.idempotencyKey !== idempotencyKey
    ) {
      throw new ExternalRootError(
        "precondition_failed",
        "External move plan and idempotency key do not match.",
      );
    }
    assertObservedPlanSafeForBackend(observed);
    return observed;
  }

  private async openDestructiveSession(
    plan: ExternalMovePlan,
    observed?: ExternalMoveJournalObservation,
  ): Promise<BackendVaultDestructiveSession> {
    if (!hasCurrentDestructiveBinding(plan)) {
      throw new ExternalRootError(
        "non_verifiable",
        "This move plan predates authenticated backend vault binding. It remains available for status only; create a new plan instead of applying or rolling it back.",
      );
    }
    try {
      return await this.vault.openDestructiveSession(
        plan.bindingIdentity,
        plan.destructiveSession,
      );
    } catch (error) {
      if (error instanceof BackendVaultSessionChangedError) {
        const partial =
          needsSessionFence(plan.status) || plan.status === "recovery_required";
        if (needsSessionFence(plan.status)) {
          if (observed) {
            this.markRecoveryRequired(observed, "backend_session_changed");
          }
        }
        throw new ExternalRootError(
          partial ? "non_verifiable" : "precondition_failed",
          "The backend session changed after planning. Automatic recovery is disabled; use the durable receipt for manual incident review.",
        );
      }
      if (error instanceof ExternalRootError) throw error;
      throw new ExternalRootError(
        "precondition_failed",
        "The backend session, vault, or external-root configuration changed after planning.",
      );
    }
  }

  private markRecoveryRequired(
    observed: ExternalMoveJournalObservation,
    code: ExternalMoveFailureCode,
  ): ExternalMoveJournalObservation {
    const current = observed.plan;
    // A row can change after status validated its snapshot. Do not turn a
    // malformed replacement payload into a durable transition; the caller
    // will render the redacted no-write incident projection instead.
    if (!isStoredPlanSafeForProjection(current)) return observed;
    const recoveryErrors = [...safeRecoveryCodes(current.recoveryErrors), code];
    const mergedRecoveryErrors = [
      ...new Set<ExternalMoveFailureCode>(recoveryErrors),
    ].sort((left, right) => left.localeCompare(right));
    if (
      current.status === "recovery_required" &&
      current.failure === code &&
      mergedRecoveryErrors.length ===
        safeRecoveryCodes(current.recoveryErrors).length
    ) {
      return observed;
    }
    if (!needsDurableSessionFailureReconciliation(current.status))
      return observed;
    return this.journal.updateObserved(observed, "recovery_required", code, {
      recoveryErrors: mergedRecoveryErrors,
    });
  }

  private async inspectFilePlacement(
    snapshot: ExternalMoveSnapshot,
  ): Promise<FilePlacement> {
    const matches = async (
      relativePath: string,
      targetRelativePath: string,
    ): Promise<boolean> => {
      try {
        const current = await this.roots.inspectMoveSource(
          snapshot.rootId,
          relativePath,
          targetRelativePath,
        );
        return (
          current.size === snapshot.size && current.sha256 === snapshot.sha256
        );
      } catch (error) {
        if (error instanceof ExternalRootError && error.code === "not_found") {
          return false;
        }
        throw error;
      }
    };
    const source = await matches(
      snapshot.sourceRelativePath,
      snapshot.targetRelativePath,
    );
    const target = await matches(
      snapshot.targetRelativePath,
      snapshot.sourceRelativePath,
    );
    if (source && target) return "both";
    if (source) return "source";
    if (target) return "target";
    return "missing_or_changed";
  }

  private async prepareRollbackContents(
    plan: ExternalMovePlan,
    session: BackendVaultDestructiveSession,
  ): Promise<Map<string, { current: string; restored: string }>> {
    const contents = new Map<string, { current: string; restored: string }>();
    for (const repair of plan.repairs) {
      const current = await this.vault.read(repair.filePath, session);
      const normalized = normalizeProtectedFrontmatter(current.content);
      if (normalized === normalizeProtectedFrontmatter(repair.before)) {
        continue;
      }
      if (normalized !== normalizeProtectedFrontmatter(repair.after)) {
        throw new ExternalRootError(
          "precondition_failed",
          `ÉLYSIA note changed outside protected runtime frontmatter: ${repair.filePath}`,
        );
      }
      contents.set(repair.filePath, {
        current: current.content,
        restored: preserveCurrentProtectedFrontmatter(
          repair.before,
          current.content,
        ),
      });
    }
    return contents;
  }

  private async compensateApply(
    observed: ExternalMoveJournalObservation,
    originalError: unknown,
    session: BackendVaultDestructiveSession,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (
      !isSafeObservedPlan(observed) ||
      !hasCurrentDestructiveBinding(observed.plan)
    ) {
      return ["external_root_non_verifiable"];
    }
    try {
      // Claim compensation from the exact receipt seen by the failed executor
      // before any backend or filesystem observation. A CAS loss is never an
      // invitation to reload and adopt a replacement executor's payload.
      observed = this.journal.transitionObserved(
        observed,
        [observed.plan.status],
        "rolling_back_repairs",
        { recoveryErrors: [] },
      );
      assertObservedPlanSafeForBackend(observed);
      let plan = observed.plan;
      // Compensation is deliberately all-or-nothing with the originating
      // backend generation. A replacement connection must never repair or
      // roll back a vault it did not attest for this operation.
      this.vault.assertDestructiveSession(session);
      const placement = await this.inspectFilePlacement(plan.snapshot);
      if (placement === "both" || placement === "missing_or_changed") {
        throw new Error(`External file placement is ${placement}.`);
      }
      const rollbackContents = await this.prepareRollbackContents(
        plan,
        session,
      );
      for (const repair of [...plan.repairs].reverse()) {
        const rollback = rollbackContents.get(repair.filePath);
        if (rollback) {
          await this.vault.conditionalReplace(
            repair.filePath,
            rollback.current,
            rollback.restored,
            sha256Text(rollback.current),
            session,
          );
        }
        observed = this.journal.recordRestoredRepairObserved(
          observed,
          repair.filePath,
        );
        plan = observed.plan;
        assertStoredPlanSafeForBackend(plan);
      }
      observed = this.journal.transitionObserved(
        observed,
        ["rolling_back_repairs"],
        "rolling_back_file",
      );
      plan = observed.plan;
      assertStoredPlanSafeForBackend(plan);
      this.vault.assertDestructiveSession(session);
      if ((await this.inspectFilePlacement(plan.snapshot)) === "target") {
        await this.roots.rollbackMove(plan.snapshot);
      }
      this.journal.updateObserved(
        observed,
        "failed_compensated",
        failureCode(originalError),
        { recoveryErrors: [] },
      );
    } catch (compensationError) {
      errors.push(failureCode(compensationError));
      if (isSafeObservedPlan(observed)) {
        const originalCode = failureCode(originalError);
        try {
          this.journal.updateObserved(
            observed,
            "recovery_required",
            originalCode,
            {
              recoveryErrors: [
                ...safeRecoveryCodes(observed.plan.recoveryErrors),
                ...errors,
              ],
            },
          );
        } catch (updateError) {
          // Keep the incident fail-closed; never reload an unobserved row.
          errors.push(failureCode(updateError));
        }
      }
    }
    return errors;
  }

  private async inventory(
    snapshot: ExternalMoveSnapshot,
  ): Promise<Record<string, unknown>> {
    const location = await this.roots.getPrivateReferenceLocation(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const sourceToken = externalReferenceToken(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const inventory = await this.inventoryInternal(
      snapshot,
      location.fileUri,
      location.fileUri,
      sourceToken,
      sourceToken,
    );
    return {
      rootId: snapshot.rootId,
      relativePath: snapshot.sourceRelativePath,
      sourceSha256: snapshot.sha256,
      inventoryDigest: inventoryDigest(inventory),
      reparable: inventory.repairs.map((item) => ({
        filePath: item.filePath,
        expectedSha256: item.expectedSha256,
      })),
      manualReview: inventory.manualReview,
      completeForCanonicalContract: true,
    };
  }

  private async inventoryInternal(
    snapshot: ExternalMoveSnapshot,
    oldFileUri: string,
    newFileUri: string,
    sourceToken: string,
    targetToken: string,
    session?: BackendVaultDestructiveSession,
  ): Promise<Inventory> {
    const location = await this.roots.getPrivateReferenceLocation(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const candidatePaths = new Set<string>();
    for (const candidate of [
      { query: sourceToken, caseSensitive: true },
      { query: oldFileUri, caseSensitive: false },
      { query: location.absolutePath, caseSensitive: false },
      { query: path.basename(location.absolutePath), caseSensitive: false },
    ]) {
      for (const filePath of await this.vault.searchPaths(
        candidate.query,
        "",
        candidate.caseSensitive,
        session,
      )) {
        candidatePaths.add(filePath);
      }
    }

    const repairs: ExternalNoteRepair[] = [];
    const manualReview: Array<{ filePath: string; reason: string }> = [];
    for (const filePath of [...candidatePaths].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const note = await this.vault.read(filePath, session);
      const scan = scanCanonicalExternalReferences(note.content);
      const mentioned = scan.occurrences.filter((occurrence) =>
        occurrenceMentionsSource(
          occurrence,
          snapshot.rootId,
          snapshot.sourceRelativePath,
          oldFileUri,
          location.absolutePath,
        ),
      );
      if (mentioned.length === 0) {
        if (
          note.content.includes(oldFileUri) ||
          note.content
            .toLowerCase()
            .includes(location.absolutePath.toLowerCase())
        ) {
          manualReview.push({
            filePath,
            reason: MANUAL_REVIEW_REASON_PHYSICAL_PATH,
          });
        }
        continue;
      }
      if (
        mentioned.some(
          (occurrence) =>
            occurrence.classification !== "reparable" ||
            occurrence.token?.rootId !== snapshot.rootId ||
            occurrence.token.relativePath !== snapshot.sourceRelativePath ||
            !occurrence.fileLink ||
            (occurrence.fileLink.url !== oldFileUri &&
              !samePhysicalPath(
                occurrence.fileLink.localPath,
                location.absolutePath,
              )),
        )
      ) {
        manualReview.push({
          filePath,
          reason: MANUAL_REVIEW_REASON_AMBIGUOUS,
        });
        continue;
      }
      let after = note.content;
      const descending = [...mentioned].sort(
        (a, b) => b.containerRange.start.offset - a.containerRange.start.offset,
      );
      for (const occurrence of descending) {
        after = replaceOccurrence(
          after,
          occurrence,
          sourceToken,
          targetToken,
          oldFileUri,
          newFileUri,
        );
      }
      repairs.push({
        filePath,
        expectedSha256: note.sha256,
        before: note.content,
        after,
      });
    }
    return {
      repairs,
      manualReview,
      candidatePaths: [...candidatePaths].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }
}
