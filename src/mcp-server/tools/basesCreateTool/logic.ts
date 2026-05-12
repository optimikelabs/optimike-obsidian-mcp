/**
 * @fileoverview Logic for the `bases_create` MCP tool.
 */

import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  BaseCreateRequest,
  BaseCreateResponse,
} from "../../../services/obsidianRestAPI/types.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

export const BasesCreateInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Chemin cible du nouveau fichier .base (relatif au coffre)."),
    spec: z
      .record(z.any())
      .describe(
        "Spécification JSON conforme à la syntaxe Bases (filters, properties, formulas, views).",
      ),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Autoriser l'écrasement si le fichier existe déjà."),
    validateOnly: z
      .boolean()
      .default(false)
      .describe("Quand true, valide uniquement la spec sans écrire sur disque."),
  })
  .describe(
    "Crée un nouveau fichier .base (ou valide la spec) via le bridge REST obsidian-bases-bridge.",
  );

export type BasesCreateInput = z.infer<typeof BasesCreateInputSchema>;

export async function processBasesCreate(
  params: BasesCreateInput,
  parentContext: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<BaseCreateResponse> {
  assertWriteAllowed({
    operation: "bases_create",
    action: params.validateOnly ? "validateOnly" : "create",
    target: params.path,
    allowInReadonly: params.validateOnly,
    destructive: params.overwrite,
    guardedReason: params.overwrite
      ? "base overwrite requires MCP_WRITE_MODE=full"
      : undefined,
    context: parentContext,
  });

  const payload: BaseCreateRequest = {
    path: params.path,
    spec: params.spec,
    overwrite: params.overwrite,
    validateOnly: params.validateOnly,
  };

  const context = requestContextService.createRequestContext({
    parentContext,
    operation: "BasesCreate",
    params: {
      path: params.path,
      overwrite: params.overwrite,
      validateOnly: params.validateOnly,
    },
  });

  logger.debug("Creating base via REST bridge", context);
  return obsidianService.createBase(payload, context);
}
