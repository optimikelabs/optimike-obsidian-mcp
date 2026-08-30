/**
 * @fileoverview Logic for the `bases_upsert_rows` MCP tool.
 */

import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  BaseUpsertOperation,
  BaseUpsertResponse,
  BaseUpsertResult,
} from "../../../services/obsidianRestAPI/types.js";
import { McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

const DEFAULT_UPSERT_CHUNK_SIZE = 1;
const DEFAULT_BATCH_DELAY_MS = 150;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 90000;
const MAX_UPSERT_CHUNK_SIZE = 50;
const FALLBACK_RECOMMENDATION =
  "Do not retry blindly. Check obsidian_runtime_status, verify Local REST API and Bases Bridge, then use an explicit parser-YAML/filesystem fallback with validation if live REST remains unavailable.";
const BUSY_RECOMMENDATION =
  "Obsidian or Bases Bridge looks busy, indexing, locked, or slow while processFrontMatter is running. Retry failed operations alone after a short backoff; keep chunkSize low until the vault is idle.";
const PROTECTED_UPSERT_KEYS = new Set(["création", "creation", "modification"]);
const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
  base_not_found:
    "The requested Base was not found. Verify it with bases_list before retrying.",
  bases_bridge_unreachable:
    "The Bases Bridge could not be reached. Verify runtime status before retrying.",
  bases_bridge_unreachable_or_rejected:
    "The Bases Bridge could not process the request. Verify runtime status before retrying.",
  forbidden_key:
    "Protected or virtual frontmatter keys cannot be modified through bases_upsert_rows.",
  local_rest_unreachable:
    "Local REST could not be reached. Verify runtime status before retrying.",
  missing_bridge_result:
    "The Bases Bridge did not return a result for this operation; its outcome is unknown.",
  missing_result:
    "The operation did not produce a result; its outcome is unknown.",
  request_failed_outcome_unknown:
    "The request failed and the individual write outcome is unknown.",
  request_timeout_outcome_unknown:
    "The request timed out and the individual write outcome is unknown.",
  skipped_after_error:
    "The operation was skipped because a previous operation failed and continueOnError is false.",
  write_timeout:
    "The write timed out and its final outcome may require verification.",
};

type IndexedOperation = {
  index: number;
  operation: BaseUpsertOperation;
};

function chunkOperations(
  operations: IndexedOperation[],
  chunkSize: number,
): IndexedOperation[][] {
  const chunks: IndexedOperation[][] = [];
  for (let i = 0; i < operations.length; i += chunkSize) {
    chunks.push(operations.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isForbiddenUpsertKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized.startsWith("file.") ||
    normalized.startsWith("formula.") ||
    PROTECTED_UPSERT_KEYS.has(normalized)
  );
}

function validateOperationKeys(
  operations: BaseUpsertOperation[],
): BaseUpsertResult[] {
  return operations.flatMap((operation) => {
    const keys = [
      ...Object.keys(operation.set ?? {}),
      ...(operation.unset ?? []),
    ];
    const forbiddenKeys = keys.filter(isForbiddenUpsertKey);
    if (forbiddenKeys.length === 0) return [];
    return [
      {
        file: operation.file,
        mtime: 0,
        error: {
          code: "forbidden_key",
          message: PUBLIC_ERROR_MESSAGES.forbidden_key,
        },
      },
    ];
  });
}

function errorCode(error: unknown): string {
  if (error instanceof McpError) return error.code;
  return "unknown_error";
}

function classifyLiveError(error: unknown): string {
  if (error instanceof McpError) {
    if (error.code === "TIMEOUT") return "request_timeout_outcome_unknown";
    if (error.code === "SERVICE_UNAVAILABLE") {
      return "local_rest_unreachable";
    }
  }
  return errorCode(error).toLowerCase();
}

function classifyResultError(result: BaseUpsertResult): string {
  const code = result.error?.code;
  if (code) return code;
  return "unknown_error";
}

function publicErrorMessage(code: string): string {
  return (
    PUBLIC_ERROR_MESSAGES[code] ??
    "The Bases row operation could not be completed. Inspect the stable error code before retrying."
  );
}

function publicResultError(result: BaseUpsertResult): BaseUpsertResult {
  if (!result.error) return result;
  const code = classifyResultError(result);
  return {
    ...result,
    error: {
      code,
      message: publicErrorMessage(code),
    },
  };
}

/**
 * The Bases Bridge deliberately omits caller paths from failed HTTP payloads.
 * Its response is positional, so bind each row back to the already validated
 * request operation here rather than trusting a reflected bridge `file` field.
 */
function bindBridgeResultToOperation(
  operation: BaseUpsertOperation,
  result: BaseUpsertResult,
): BaseUpsertResult {
  return {
    ...publicResultError(result),
    file: operation.file,
  };
}

function isRetryableError(code: string): boolean {
  const normalized = code.toLowerCase();
  return (
    normalized === "write_timeout" ||
    normalized === "request_timeout_outcome_unknown" ||
    normalized === "local_rest_unreachable" ||
    normalized === "service_unavailable"
  );
}

function makeFailedResults(
  operations: BaseUpsertOperation[],
  code: string,
  message: string,
): BaseUpsertResult[] {
  return operations.map((operation) => ({
    file: operation.file,
    mtime: 0,
    error: {
      code,
      message,
    },
    warnings: [FALLBACK_RECOMMENDATION],
  }));
}

function buildSummary(
  totalCount: number,
  results: BaseUpsertResult[],
  dryRun?: boolean,
): NonNullable<BaseUpsertResponse["summary"]> {
  const failedOperations = results
    .filter((result) => result.error)
    .map((result) => ({
      file: result.file,
      code: result.error!.code,
      message: result.error!.message,
      retryable: isRetryableError(result.error!.code),
      attempts: result.attempts,
    }));

  return {
    total_count: totalCount,
    changed_count: dryRun
      ? 0
      : results.filter((result) => result.changed && !result.error).length,
    failed_count: failedOperations.length,
    skipped_count: results.filter(
      (result) => result.error?.code === "skipped_after_error",
    ).length,
    retryable_error_count: failedOperations.filter(
      (operation) => operation.retryable,
    ).length,
    dry_run: dryRun,
    failed_operations: failedOperations,
  };
}

async function runLivePreflight(
  params: BasesUpsertRowsInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<BaseUpsertResponse | undefined> {
  try {
    await obsidianService.checkStatus(
      requestContextService.createRequestContext({
        parentContext: context,
        operation: "BasesUpsertRowsPreflightLocalRest",
      }),
    );
  } catch (error) {
    const message =
      "Local REST preflight could not verify availability before bases_upsert_rows.";
    logger.error(message, { ...context, reasonCode: "local_rest_unreachable" });
    return {
      ok: false,
      diagnostics: {
        source: "preflight",
        phase: "local_rest",
        message,
        recommendation: FALLBACK_RECOMMENDATION,
      },
      results: makeFailedResults(
        params.operations,
        "local_rest_unreachable",
        message,
      ),
      summary: buildSummary(
        params.operations.length,
        makeFailedResults(params.operations, "local_rest_unreachable", message),
        params.dryRun,
      ),
    };
  }

  try {
    const list = await obsidianService.listBases(
      requestContextService.createRequestContext({
        parentContext: context,
        operation: "BasesUpsertRowsPreflightBasesList",
      }),
    );
    const baseExists = list.bases.some((base) => base.id === params.base_id);
    if (!baseExists) {
      const message = publicErrorMessage("base_not_found");
      const results = makeFailedResults(
        params.operations,
        "base_not_found",
        message,
      );
      return {
        ok: false,
        diagnostics: {
          source: "preflight",
          phase: "base_exists",
          message,
          recommendation:
            "Verify the base_id with bases_list before retrying the write.",
        },
        results,
        summary: buildSummary(params.operations.length, results, params.dryRun),
      };
    }
  } catch (error) {
    const message =
      "Bases Bridge preflight could not verify availability before bases_upsert_rows.";
    logger.error(message, {
      ...context,
      reasonCode: "bases_bridge_unreachable",
    });
    const results = makeFailedResults(
      params.operations,
      "bases_bridge_unreachable",
      message,
    );
    return {
      ok: false,
      diagnostics: {
        source: "preflight",
        phase: "bases_bridge",
        message,
        recommendation: FALLBACK_RECOMMENDATION,
      },
      results,
      summary: buildSummary(params.operations.length, results, params.dryRun),
    };
  }

  return undefined;
}

const OperationSchema = z
  .object({
    file: z
      .string()
      .min(1)
      .describe(
        "Chemin de la note ciblée (relatif au coffre), ex. 'SEO/Pages/13-Aix.md'.",
      ),
    set: z
      .record(z.any())
      .optional()
      .describe("Valeurs de frontmatter à appliquer."),
    unset: z
      .array(z.string().min(1))
      .optional()
      .describe("Clés de frontmatter à supprimer."),
    expected_mtime: z
      .number()
      .optional()
      .describe(
        "Timestamp mtime attendu (verrou optimiste). Conflit => 409 renvoyé par le bridge.",
      ),
  })
  .describe("Opération d'upsert frontmatter pour une note.");

export const BasesUpsertRowsInputSchema = z
  .object({
    base_id: z
      .string()
      .min(1)
      .describe(
        "Identifiant (chemin) de la base utilisée pour contextualiser la mise à jour.",
      ),
    operations: z
      .array(OperationSchema)
      .min(1)
      .describe("Tableau d'opérations d'upsert frontmatter."),
    continueOnError: z
      .boolean()
      .default(false)
      .describe(
        "Quand true, poursuit les opérations malgré les erreurs individuelles.",
      ),
    chunkSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_UPSERT_CHUNK_SIZE)
      .default(DEFAULT_UPSERT_CHUNK_SIZE)
      .describe(
        "Nombre d'opérations envoyées par requête bridge. Par défaut 1 pour préserver une reprise granulaire autour de processFrontMatter.",
      ),
    delayMs: z
      .number()
      .int()
      .min(0)
      .max(30000)
      .default(DEFAULT_BATCH_DELAY_MS)
      .describe(
        "Pause entre deux requêtes bridge, utile quand Obsidian indexe ou verrouille le coffre.",
      ),
    maxRetries: z
      .number()
      .int()
      .min(0)
      .max(3)
      .default(DEFAULT_MAX_RETRIES)
      .describe(
        "Nombre de retries automatiques pour les erreurs retryables comme write_timeout.",
      ),
    retryBackoffMs: z
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(DEFAULT_RETRY_BACKOFF_MS)
      .describe(
        "Backoff de base avant retry. Le délai est multiplié par le numéro de tentative.",
      ),
    requestTimeoutMs: z
      .number()
      .int()
      .min(10000)
      .max(300000)
      .default(DEFAULT_REQUEST_TIMEOUT_MS)
      .describe(
        "Timeout HTTP client pour chaque requête vers le bridge Bases.",
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Valide les fichiers, les mtime et le payload via le bridge sans écrire.",
      ),
  })
  .describe(
    "Met à jour en lot les propriétés de notes référencées par une base (.base). Respecte le verrou mtime et interdit les clés formula.* / file.* côté bridge.",
  );

export type BasesUpsertRowsInput = z.infer<typeof BasesUpsertRowsInputSchema>;

export async function processBasesUpsertRows(
  params: BasesUpsertRowsInput,
  parentContext: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<BaseUpsertResponse> {
  assertWriteAllowed({
    operation: "bases_upsert_rows",
    action: params.dryRun ? "dry_run" : "upsert_rows",
    target: params.base_id,
    batchCount: params.operations.length,
    frontmatterKeys: params.operations.flatMap((operation) => [
      ...Object.keys(operation.set ?? {}),
      ...(operation.unset ?? []),
    ]),
    destructive: params.operations.some(
      (operation) => operation.unset && operation.unset.length > 0,
    ),
    guardedReason: params.operations.some(
      (operation) => operation.unset && operation.unset.length > 0,
    )
      ? "frontmatter unset operations require MCP_WRITE_MODE=full"
      : undefined,
    allowInReadonly: params.dryRun,
    allowInGuarded: params.dryRun,
    context: parentContext,
  });

  const context = requestContextService.createRequestContext({
    parentContext,
    operation: "BasesUpsertRows",
    params: {
      hasBaseId: Boolean(params.base_id),
      operations: params.operations.length,
      continueOnError: params.continueOnError,
      chunkSize: params.chunkSize,
      delayMs: params.delayMs,
      maxRetries: params.maxRetries,
      dryRun: params.dryRun,
    },
  });

  const operations: BaseUpsertOperation[] = params.operations.map(
    (operation) => ({
      file: operation.file,
      set: operation.set,
      unset: operation.unset,
      expected_mtime: operation.expected_mtime,
    }),
  );
  const validationErrors = validateOperationKeys(operations);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      results: validationErrors,
      summary: buildSummary(operations.length, validationErrors, params.dryRun),
      diagnostics: {
        source: "preflight",
        phase: "validation",
        message:
          "bases_upsert_rows refused protected or virtual frontmatter keys before writing.",
        recommendation:
          "Remove file.*, formula.*, création/creation, and modification from the payload; these fields are computed or auto-managed.",
      },
    };
  }
  const indexedOperations: IndexedOperation[] = operations.map(
    (operation, index) => ({
      index,
      operation,
    }),
  );
  const effectiveChunkSize = params.continueOnError ? params.chunkSize : 1;
  const allResultsByIndex = new Map<number, BaseUpsertResult>();
  let retriedCount = 0;
  let retryableErrorCount = 0;
  let stoppedAfterIndex: number | undefined;

  logger.debug("Upserting rows via REST bridge (chunked)", {
    ...context,
    chunkSize: effectiveChunkSize,
    chunkCount: chunkOperations(indexedOperations, effectiveChunkSize).length,
  });

  const preflightFailure = await runLivePreflight(
    params,
    context,
    obsidianService,
  );
  if (preflightFailure) {
    return preflightFailure;
  }

  const recordResult = (
    item: IndexedOperation,
    result: BaseUpsertResult,
    attempts: number,
  ) => {
    allResultsByIndex.set(item.index, {
      ...result,
      attempts,
    });
  };

  const executeChunk = async (
    chunk: IndexedOperation[],
    attempt: number,
    chunkIndex: number,
    chunkCount: number,
  ): Promise<IndexedOperation[]> => {
    const chunkContext = requestContextService.createRequestContext({
      parentContext: context,
      operation: "BasesUpsertRowsChunk",
      params: {
        hasBaseId: Boolean(params.base_id),
        attempt,
        chunkIndex,
        chunkCount,
        operationsInChunk: chunk.length,
        dryRun: params.dryRun,
      },
    });

    try {
      const response = await obsidianService.upsertBaseRows(
        params.base_id,
        {
          operations: chunk.map((item) => item.operation),
          continueOnError: params.continueOnError,
          dryRun: params.dryRun,
          requestTimeoutMs: params.requestTimeoutMs,
        },
        chunkContext,
      );

      const retryItems: IndexedOperation[] = [];
      for (let resultIndex = 0; resultIndex < chunk.length; resultIndex++) {
        const item = chunk[resultIndex]!;
        const result = response.results[resultIndex];
        if (!result) {
          const message =
            "Bases Bridge returned fewer results than requested; operation outcome is unknown.";
          retryItems.push(item);
          recordResult(
            item,
            {
              file: item.operation.file,
              mtime: 0,
              error: {
                code: "missing_bridge_result",
                message,
              },
              warnings: [FALLBACK_RECOMMENDATION],
            },
            attempt + 1,
          );
          continue;
        }

        if (result.error) {
          const code = classifyResultError(result);
          const retryable = isRetryableError(code);
          if (retryable) {
            retryableErrorCount++;
          }
          if (retryable && attempt < params.maxRetries) {
            retryItems.push(item);
            continue;
          }
        }

        recordResult(
          item,
          bindBridgeResultToOperation(item.operation, result),
          attempt + 1,
        );
      }

      return retryItems;
    } catch (error) {
      const code = classifyLiveError(error);
      logger.error("bases_upsert_rows chunk request failed", {
        ...chunkContext,
        reasonCode: code,
      });
      if (isRetryableError(code) && attempt < params.maxRetries) {
        retryableErrorCount += chunk.length;
        return chunk;
      }
      for (const item of chunk) {
        recordResult(
          item,
          makeFailedResults(
            [item.operation],
            code === "request_timeout_outcome_unknown"
              ? code
              : "request_failed_outcome_unknown",
            publicErrorMessage(
              code === "request_timeout_outcome_unknown"
                ? code
                : "request_failed_outcome_unknown",
            ),
          )[0]!,
          attempt + 1,
        );
      }
      return [];
    }
  };

  if (params.continueOnError) {
    let pending = indexedOperations;
    for (
      let attempt = 0;
      attempt <= params.maxRetries && pending.length > 0;
      attempt++
    ) {
      if (attempt > 0) {
        retriedCount += pending.length;
        await sleep(params.retryBackoffMs * attempt);
      }
      const chunkSize = attempt === 0 ? effectiveChunkSize : 1;
      const chunks = chunkOperations(pending, chunkSize);
      const nextPending: IndexedOperation[] = [];
      for (let index = 0; index < chunks.length; index++) {
        nextPending.push(
          ...(await executeChunk(
            chunks[index]!,
            attempt,
            index + 1,
            chunks.length,
          )),
        );
        if (index < chunks.length - 1) {
          await sleep(params.delayMs);
        }
      }
      pending = nextPending;
    }
  } else {
    for (const item of indexedOperations) {
      let pending: IndexedOperation[] = [item];
      for (
        let attempt = 0;
        attempt <= params.maxRetries && pending.length > 0;
        attempt++
      ) {
        if (attempt > 0) {
          retriedCount += pending.length;
          await sleep(params.retryBackoffMs * attempt);
        }
        pending = await executeChunk(pending, attempt, 1, 1);
      }
      const result = allResultsByIndex.get(item.index);
      if (result?.error) {
        stoppedAfterIndex = item.index;
        break;
      }
      await sleep(params.delayMs);
    }
  }

  if (typeof stoppedAfterIndex === "number") {
    for (const item of indexedOperations.slice(stoppedAfterIndex + 1)) {
      recordResult(
        item,
        {
          file: item.operation.file,
          mtime: 0,
          error: {
            code: "skipped_after_error",
            message: PUBLIC_ERROR_MESSAGES.skipped_after_error,
          },
        },
        0,
      );
    }
  }

  const allResults = indexedOperations.map(
    (item) =>
      allResultsByIndex.get(item.index) ?? {
        file: item.operation.file,
        mtime: 0,
        error: {
          code: "missing_result",
          message: PUBLIC_ERROR_MESSAGES.missing_result,
        },
      },
  );
  const summary = buildSummary(operations.length, allResults, params.dryRun);
  summary.retryable_error_count = retryableErrorCount;
  summary.retried_count = retriedCount;
  const failedOperations = summary.failed_operations ?? [];
  const hasBusyErrors = failedOperations.some(
    (operation) =>
      operation.code === "write_timeout" ||
      operation.code === "request_timeout_outcome_unknown",
  );

  return {
    ok: allResults.every((result) => !result.error),
    results: allResults,
    summary,
    diagnostics: {
      source: "bases-bridge-rest",
      phase: "upsert",
      message: hasBusyErrors ? BUSY_RECOMMENDATION : undefined,
      recommendation: allResults.some((result) => result.error)
        ? hasBusyErrors
          ? BUSY_RECOMMENDATION
          : FALLBACK_RECOMMENDATION
        : undefined,
    },
  };
}
