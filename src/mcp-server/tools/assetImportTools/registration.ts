import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";
import type { ExternalRootsService } from "../../../services/externalRootsService.js";
import type { AssetImportOperationAdapter } from "../../../services/assets/assetImportOperation.js";
import { ASSET_SOURCE_MAX_BYTES } from "../../../services/assets/imageProcessing.js";
import { AssetImportInputSchema, AssetApplyInputSchema, AssetStatusInputSchema, type AssetSourceProvider } from "../../../services/assets/assetImportContract.js";
import { assertExternalReadAccess } from "../externalRootsTools/registration.js";
import { GOVERNED_PLAN_TOOL_ANNOTATIONS, GOVERNED_MUTATION_TOOL_ANNOTATIONS, READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

export async function registerAssetImportTools(
  server: McpServer,
  runtime: AssetImportOperationAdapter | undefined,
  sourceRoots: ExternalRootsService | undefined,
  localTransport: boolean,
): Promise<void> {
  if (!runtime) return;
  const source = (authInfo: Parameters<typeof assertExternalReadAccess>[1]): AssetSourceProvider => ({
    authorize: input => {
      assertExternalReadAccess(localTransport, authInfo);
      if (!sourceRoots) throw new McpError(BaseErrorCode.FORBIDDEN, "Asset source roots are not configured.");
      return sourceRoots.binaryProcessingPolicy(input.rootId, input.relativePath);
    },
    read: async input => {
      assertExternalReadAccess(localTransport, authInfo);
      if (!sourceRoots) throw new McpError(BaseErrorCode.FORBIDDEN, "Asset source roots are not configured.");
      return sourceRoots.readBinaryForProcessing(input.rootId, input.relativePath, ASSET_SOURCE_MAX_BYTES);
    },
  });
  const writeGuard = () => {
    if (!config.assetImportEnabled || config.mcpWriteMode !== "full") {
      throw new McpError(BaseErrorCode.FORBIDDEN, "Asset import is disabled by the explicit write policy.", {reason:"asset_import_disabled"});
    }
    assertWriteAllowed({ runtimeMode:config.obsidianRuntimeMode, writeMode:config.mcpWriteMode, operation:"note-write" });
  };
  async function run(toolName:string, operation:()=>Promise<unknown>) {
    try {
      const result=await operation();
      const receipt=result as {outcome?:unknown;postflight?:{status?:unknown}};
      const failed=["conflict","rejected","failed","outcome_unknown"].includes(String(receipt.outcome)) ||
        (receipt.outcome==="committed"&&receipt.postflight?.status!=="verified");
      return {content:[{type:"text" as const,text:JSON.stringify(result)}],isError:failed};
    } catch(error) {
      return {content:[{type:"text" as const,text:JSON.stringify(publicMcpToolErrorPayload(error,{operation:toolName,toolName}))}],isError:true};
    }
  }
  server.registerTool("asset_import_plan", {
    description:"Plan one explicitly requested image import from a server-local ExternalRoot authorized for readable + handoff. Reads and decodes the expected original, applies the configured image policy and freezes bytes in the existing private journal; no vault asset or note is written. Does not accept URLs, model-carried base64, client-local paths, automatic downloads or overwrite. Keep remote references remote unless import was requested. Reuse an existing local asset instead of importing it again. Source and image limits apply; Windows x64 local NTFS creation only.",
    inputSchema:mcpSchema(AssetImportInputSchema),annotations:GOVERNED_PLAN_TOOL_ANNOTATIONS,
  }, async (params:z.infer<typeof AssetImportInputSchema>, context) => run("asset_import_plan",()=>runtime.plan(params,source(context.http?.authInfo),writeGuard)));
  server.registerTool("asset_import_apply", {
    description:"Apply the exact sealed asset import once with its matching idempotency key. Requires the independent asset-import opt-in and full write policy; creates one binary without overwriting. Never creates directories or modifies a note. On timeout/lost response/partial effect, use status; never issue another import to retry. An uncertain asset is preserved, not automatically deleted. Insert the returned embed through a separate governed note operation only after postflight is verified.",
    inputSchema:mcpSchema(AssetApplyInputSchema),annotations:GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  }, async (params:z.infer<typeof AssetApplyInputSchema>, context) => run("asset_import_apply",()=>runtime.apply(params.planRef,params.idempotencyKey,source(context.http?.authInfo),writeGuard)));
  server.registerTool("asset_import_status", {
    description:"Observe one exact asset import and reconcile its durable receipt without creating, converting, deleting or replacing an asset or note. A matching file proves observed bytes, not authorship or Obsidian indexing. A previously committed but subsequently changed/missing asset returns unverified postflight and no usable embed. No automatic recovery or rollback is performed.",
    inputSchema:mcpSchema(AssetStatusInputSchema),annotations:READ_ONLY_TOOL_ANNOTATIONS,
  }, async (params:z.infer<typeof AssetStatusInputSchema>) => run("asset_import_status",()=>runtime.status(params.planRef)));
}
