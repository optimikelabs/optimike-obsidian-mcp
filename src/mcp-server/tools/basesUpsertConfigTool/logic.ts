/**
 * @fileoverview Logic for the `bases_upsert_config` MCP tool.
 */

import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  BaseConfigUpsertRequest,
  BaseConfigUpsertResponse,
} from "../../../services/obsidianRestAPI/types.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

const RawBasesUpsertConfigInputSchema = z
  .object({
    base_id: z
      .string()
      .min(1)
      .describe("Identifiant (chemin) du fichier .base à mettre à jour."),
    yaml: z
      .string()
      .optional()
      .describe("YAML complet de la base. Optionnel si 'json' est fourni."),
    json: z
      .record(z.any())
      .optional()
      .describe("Spécification JSON de la base. Optionnel si 'yaml' est fourni."),
    validateOnly: z
      .boolean()
      .default(false)
      .describe("Quand true, valide la configuration sans écrire."),
  })
  .describe(
    "Remplace ou valide la configuration d'un fichier .base (YAML ou JSON) via le bridge REST.",
  );

export const BasesUpsertConfigInputSchema = RawBasesUpsertConfigInputSchema;

export type BasesUpsertConfigInput = z.infer<
  typeof BasesUpsertConfigInputSchema
>;

export async function processBasesUpsertConfig(
  params: BasesUpsertConfigInput,
  parentContext: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<BaseConfigUpsertResponse> {
  assertWriteAllowed({
    operation: "bases_upsert_config",
    action: params.validateOnly ? "validateOnly" : "upsert_config",
    target: params.base_id,
    allowInReadonly: params.validateOnly,
    destructive: !params.validateOnly,
    guardedReason: !params.validateOnly
      ? "base config replacement requires MCP_WRITE_MODE=full"
      : undefined,
    context: parentContext,
  });

  if (!params.yaml && !params.json) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "Fournir au moins 'yaml' ou 'json' pour mettre à jour la base.",
    );
  }

  const payload: BaseConfigUpsertRequest = {
    yaml: params.yaml,
    json: params.json,
    validateOnly: params.validateOnly,
  };

  const context = requestContextService.createRequestContext({
    parentContext,
    operation: "BasesUpsertConfig",
    params: {
      base_id: params.base_id,
      hasYaml: Boolean(params.yaml),
      hasJson: Boolean(params.json),
      validateOnly: params.validateOnly,
    },
  });

  logger.debug("Updating base config via REST bridge", context);
  return obsidianService.upsertBaseConfig(params.base_id, payload, context);
}
