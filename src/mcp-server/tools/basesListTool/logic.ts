/**
 * @fileoverview Logic for the `bases_list` MCP tool.
 *
 * This tool surfaces the list of Bases (`*.base` YAML files) discovered by the
 * obsidian-bases-bridge plugin. It simply proxies the response from the bridge
 * to the MCP client.
 */

import { z } from "zod";
import { LocalBasesService } from "../../../services/localBasesService.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  BasesListResponse as BasesListResult,
} from "../../../services/obsidianRestAPI/types.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";

/**
 * Input schema (empty object) required by the MCP SDK registration.
 */
export const BasesListInputSchema = z
  .object({})
  .strict()
  .describe(
    "Liste les fichiers .base disponibles dans le coffre Obsidian. Ne prend aucun paramètre.",
  );

export type BasesListInput = z.infer<typeof BasesListInputSchema>;

/**
 * Core logic that calls the Obsidian REST API bridge.
 */
export async function processBasesList(
  _params: BasesListInput,
  parentContext: RequestContext,
  obsidianService: ObsidianRestApiService | undefined,
  localBasesService?: LocalBasesService,
): Promise<BasesListResult> {
  const context = requestContextService.createRequestContext({
    parentContext,
    operation: "BasesList",
  });
  if (obsidianService) {
    logger.debug("Fetching Bases list via REST bridge", context);
    return obsidianService.listBases(context);
  }
  if (localBasesService) {
    logger.debug("Fetching Bases list via local fallback", context);
    return localBasesService.listBases();
  }
  throw new Error("Bases list requires either Obsidian REST or local Bases fallback.");
}
