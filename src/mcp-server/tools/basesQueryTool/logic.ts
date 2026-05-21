/**
 * @fileoverview Logic for the `bases_query` MCP tool.
 */

import { z } from "zod";
import { LocalBasesService } from "../../../services/localBasesService.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  BaseQueryRequest,
  BaseQueryResponse,
} from "../../../services/obsidianRestAPI/types.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";

const SortSchema = z
  .object({
    prop: z
      .string()
      .min(1)
      .describe("Identifiant de propriété (ex. 'priority' ou 'file.mtime')."),
    dir: z.enum(["asc", "desc"]).default("asc"),
  })
  .describe("Critère de tri supplémentaire.");

export const BasesQueryInputSchema = z
  .object({
    base_id: z
      .string()
      .min(1)
      .describe("Identifiant (chemin) du fichier .base à interroger."),
    view: z
      .string()
      .min(1)
      .optional()
      .describe("Vue à utiliser pour l'ordre/les formules. Optionnel."),
    filter: z
      .record(z.any())
      .optional()
      .describe("Filtre additionnel (JSON) appliqué par le bridge."),
    sort: z
      .array(SortSchema)
      .optional()
      .describe("Critères de tri supplémentaires (en plus de la vue)."),
    limit: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .describe("Nombre max de lignes par page (<= 500)."),
    page: z
      .number()
      .min(1)
      .default(1)
      .describe("Numéro de page (1-indexé)."),
    evaluate: z
      .boolean()
      .default(true)
      .describe("Quand true, force l'utilisation des valeurs évaluées si disponibles."),
  })
  .describe(
    "Exécute une requête sur une base. Supporte filtres additionnels, tri, pagination et mode evaluate (engine).",
  );

export type BasesQueryInput = z.infer<typeof BasesQueryInputSchema>;

export async function processBasesQuery(
  params: BasesQueryInput,
  parentContext: RequestContext,
  obsidianService: ObsidianRestApiService | undefined,
  localBasesService?: LocalBasesService,
): Promise<BaseQueryResponse> {
  const payload: BaseQueryRequest = {
    view: params.view,
    filter: params.filter,
    sort: params.sort,
    limit: params.limit,
    page: params.page,
    evaluate: params.evaluate,
  };

  const context = requestContextService.createRequestContext({
    parentContext,
    operation: "BasesQuery",
    params: {
      ...params,
      filter: params.filter ? "<payload>" : undefined,
      sort: params.sort ? params.sort.length : undefined,
    },
  });

  if (obsidianService) {
    logger.debug("Querying base via REST bridge", context);
    return obsidianService.queryBase(params.base_id, payload, context);
  }
  if (localBasesService) {
    logger.debug("Querying base via local fallback", context);
    return localBasesService.queryBase(params.base_id, payload, context);
  }
  throw new Error("Base query requires either Obsidian REST or local Bases fallback.");
}
