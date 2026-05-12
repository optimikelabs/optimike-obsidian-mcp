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
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

const UPSERT_CHUNK_SIZE = 25;

function chunkOperations(
  operations: BaseUpsertOperation[],
  chunkSize: number,
): BaseUpsertOperation[][] {
  const chunks: BaseUpsertOperation[][] = [];
  for (let i = 0; i < operations.length; i += chunkSize) {
    chunks.push(operations.slice(i, i + chunkSize));
  }
  return chunks;
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
    action: "upsert_rows",
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
    context: parentContext,
  });

  const context = requestContextService.createRequestContext({
    parentContext,
    operation: "BasesUpsertRows",
    params: {
      base_id: params.base_id,
      operations: params.operations.length,
      continueOnError: params.continueOnError,
    },
  });

  const operations: BaseUpsertOperation[] = params.operations.map((operation) => ({
    file: operation.file,
    set: operation.set,
    unset: operation.unset,
    expected_mtime: operation.expected_mtime,
  }));
  const operationChunks = chunkOperations(operations, UPSERT_CHUNK_SIZE);
  const allResults: BaseUpsertResult[] = [];

  logger.debug("Upserting rows via REST bridge (chunked)", {
    ...context,
    chunkSize: UPSERT_CHUNK_SIZE,
    chunkCount: operationChunks.length,
  });

  for (let index = 0; index < operationChunks.length; index++) {
    const chunk = operationChunks[index]!;
    const chunkContext = requestContextService.createRequestContext({
      parentContext: context,
      operation: "BasesUpsertRowsChunk",
      params: {
        base_id: params.base_id,
        chunkIndex: index + 1,
        chunkCount: operationChunks.length,
        operationsInChunk: chunk.length,
      },
    });

    try {
      const response = await obsidianService.upsertBaseRows(
        params.base_id,
        { operations: chunk, continueOnError: params.continueOnError },
        chunkContext,
      );

      allResults.push(...response.results);
      if (!params.continueOnError && !response.ok) {
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("bases_upsert_rows chunk failed after retries", {
        ...chunkContext,
        error: message,
      });
      allResults.push(
        ...chunk.map((operation) => ({
          file: operation.file,
          mtime: 0,
          error: {
            code: "request_failed_outcome_unknown",
            message: `Chunk request failed; individual write outcomes are unknown. ${message}`,
          },
        })),
      );
      if (!params.continueOnError) {
        break;
      }
    }
  }

  return {
    ok: allResults.every((result) => !result.error),
    results: allResults,
  };
}
