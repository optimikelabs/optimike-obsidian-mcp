/**
 * @fileoverview Logic for the `bases_query` MCP tool.
 */

import { z } from "zod/v3";
import {
  BASE_QUERY_FILTER_DESCRIPTION,
  BASE_QUERY_FILTER_VERSION,
  compileBaseQueryFilter,
} from "../../../services/baseQueryFilter.js";
import { LocalBasesService } from "../../../services/localBasesService.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  BaseQueryRequest,
  BaseQueryResponse,
} from "../../../services/obsidianRestAPI/types.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
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
      .record(z.unknown())
      .optional()
      .describe(BASE_QUERY_FILTER_DESCRIPTION),
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

// Keep the object shape in tools/list while letting the handler diagnose an
// invalid filter through the public MCP validation error path.
export const BasesQueryDispatchSchema = BasesQueryInputSchema.extend({
  filter: z.unknown().optional(),
});
export type BasesQueryInput = z.infer<typeof BasesQueryDispatchSchema>;

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
    const filter = compileBaseQueryFilter(params.filter, true);
    logger.debug("Querying base via REST bridge", context);
    const { filterVersion, ...result } = await obsidianService.queryBase(params.base_id, payload, context);
    if (filter.usesPropertyTable && filterVersion !== BASE_QUERY_FILTER_VERSION) {
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Base query filter protocol unavailable.", {
        reasonCode: "base_query_filter_bridge_upgrade_required",
      });
    }
    return result;
  }
  if (localBasesService) {
    logger.debug("Querying base via local fallback", context);
    return localBasesService.queryBase(params.base_id, payload, context);
  }
  throw new Error("Base query requires either Obsidian REST or local Bases fallback.");
}
