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
          message: `Keys cannot be modified through bases_upsert_rows: ${forbiddenKeys.join(", ")}`,
        },
      },
    ];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof McpError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return "unknown_error";
}

function classifyLiveError(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("Network Error") || message.includes("No response")) {
    return "local_rest_unreachable";
  }
  if (
    message.includes("/bases") ||
    message.includes("Bases") ||
    message.includes("Bridge")
  ) {
    return "bases_bridge_unreachable_or_rejected";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "request_timeout_outcome_unknown";
  }
  return errorCode(error).toLowerCase();
}

function classifyResultError(result: BaseUpsertResult): string {
  const code = result.error?.code;
  if (code) return code;
  const message = result.error?.message ?? "";
  if (message.includes("timeout") || message.includes("timed out")) {
    return "write_timeout";
  }
  return "unknown_error";
}

function isRetryableError(code: string, message = ""): boolean {
  const normalized = code.toLowerCase();
  const text = message.toLowerCase();
  return (
    normalized === "write_timeout" ||
    normalized === "request_timeout_outcome_unknown" ||
    normalized === "local_rest_unreachable" ||
    normalized === "service_unavailable" ||
    (normalized === "write_error" &&
      (text.includes("timeout") || text.includes("timed out")))
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
      retryable: isRetryableError(result.error!.code, result.error!.message),
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
    const message = `Local REST preflight failed before bases_upsert_rows: ${errorMessage(error)}`;
    logger.error(message, { ...context, error: errorMessage(error) });
    return {
      ok: false,
      diagnostics: {
        source: "preflight",
        base_id: params.base_id,
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
      const message = `Base not found during bases_upsert_rows preflight: ${params.base_id}`;
      const results = makeFailedResults(
        params.operations,
        "base_not_found",
        message,
      );
      return {
        ok: false,
        diagnostics: {
          source: "preflight",
          base_id: params.base_id,
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
    const message = `Bases Bridge preflight failed before bases_upsert_rows: ${errorMessage(error)}`;
    logger.error(message, { ...context, error: errorMessage(error) });
    const results = makeFailedResults(
      params.operations,
      "bases_bridge_unreachable",
      message,
    );
    return {
      ok: false,
      diagnostics: {
        source: "preflight",
        base_id: params.base_id,
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
      .describe("Identifiant (chemin) de la base utilisée pour contextualiser la mise à jour."),
    operations: z
      .array(OperationSchema)
      .min(1)
      .describe("Tableau d'opérations d'upsert frontmatter."),
    continueOnError: z
      .boolean()
      .default(false)
      .describe("Quand true, poursuit les opérations malgré les erreurs individuelles."),
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
      .describe("Pause entre deux requêtes bridge, utile quand Obsidian indexe ou verrouille le coffre."),
    maxRetries: z
      .number()
      .int()
      .min(0)
      .max(3)
      .default(DEFAULT_MAX_RETRIES)
      .describe("Nombre de retries automatiques pour les erreurs retryables comme write_timeout."),
    retryBackoffMs: z
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(DEFAULT_RETRY_BACKOFF_MS)
      .describe("Backoff de base avant retry. Le délai est multiplié par le numéro de tentative."),
    requestTimeoutMs: z
      .number()
      .int()
      .min(10000)
      .max(300000)
      .default(DEFAULT_REQUEST_TIMEOUT_MS)
      .describe("Timeout HTTP client pour chaque requête vers le bridge Bases."),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Valide les fichiers, les mtime et le payload via le bridge sans écrire."),
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
      base_id: params.base_id,
      operations: params.operations.length,
      continueOnError: params.continueOnError,
      chunkSize: params.chunkSize,
      delayMs: params.delayMs,
      maxRetries: params.maxRetries,
      dryRun: params.dryRun,
    },
  });

  const operations: BaseUpsertOperation[] = params.operations.map((operation) => ({
    file: operation.file,
    set: operation.set,
    unset: operation.unset,
    expected_mtime: operation.expected_mtime,
  }));
  const validationErrors = validateOperationKeys(operations);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      results: validationErrors,
      summary: buildSummary(operations.length, validationErrors, params.dryRun),
      diagnostics: {
        source: "preflight",
        base_id: params.base_id,
        phase: "validation",
        message:
          "bases_upsert_rows refused protected or virtual frontmatter keys before writing.",
        recommendation:
          "Remove file.*, formula.*, création/creation, and modification from the payload; these fields are computed or auto-managed.",
      },
    };
  }
  const indexedOperations: IndexedOperation[] = operations.map((operation, index) => ({
    index,
    operation,
  }));
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
        base_id: params.base_id,
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
          const retryable = isRetryableError(code, result.error.message);
          if (retryable) {
            retryableErrorCount++;
          }
          if (retryable && attempt < params.maxRetries) {
            retryItems.push(item);
            continue;
          }
        }

        recordResult(item, result, attempt + 1);
      }

      return retryItems;
    } catch (error) {
      const message = errorMessage(error);
      const code = classifyLiveError(error);
      logger.error("bases_upsert_rows chunk failed after retries", {
        ...chunkContext,
        error: message,
        code,
      });
      if (isRetryableError(code, message) && attempt < params.maxRetries) {
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
            `Chunk request failed during bases_upsert_rows; individual write outcomes are unknown. Classified as ${code}. ${message}`,
          )[0]!,
          attempt + 1,
        );
      }
      return [];
    }
  };

  if (params.continueOnError) {
    let pending = indexedOperations;
    for (let attempt = 0; attempt <= params.maxRetries && pending.length > 0; attempt++) {
      if (attempt > 0) {
        retriedCount += pending.length;
        await sleep(params.retryBackoffMs * attempt);
      }
      const chunkSize = attempt === 0 ? effectiveChunkSize : 1;
      const chunks = chunkOperations(pending, chunkSize);
      const nextPending: IndexedOperation[] = [];
      for (let index = 0; index < chunks.length; index++) {
        nextPending.push(
          ...(await executeChunk(chunks[index]!, attempt, index + 1, chunks.length)),
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
      for (let attempt = 0; attempt <= params.maxRetries && pending.length > 0; attempt++) {
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
            message:
              "Operation skipped because continueOnError=false and a previous operation failed after retries.",
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
          message: "Operation did not produce a result.",
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
      operation.message.toLowerCase().includes("processfrontmatter"),
  );

  return {
    ok: allResults.every((result) => !result.error),
    results: allResults,
    summary,
    diagnostics: {
      source: "bases-bridge-rest",
      base_id: params.base_id,
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
