import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";
import type { ExternalRootsService } from "../../../services/externalRootsService.js";
import type { AssetImportOperationAdapter } from "../../../services/assets/assetImportOperation.js";
import { ASSET_SOURCE_MAX_BYTES } from "../../../services/assets/imageProcessing.js";
import {
  AssetImportPlanInputSchema,
  AssetApplyInputSchema,
  AssetStatusInputSchema,
  type AssetImportInput,
  type AssetImportPlanInput,
  type AssetSourceProvider,
} from "../../../services/assets/assetImportContract.js";
import { AssetFileIngress } from "../../../services/assets/fileIngress.js";
import { assertExternalReadAccess } from "../externalRootsTools/registration.js";
import { GOVERNED_PLAN_TOOL_ANNOTATIONS, GOVERNED_MUTATION_TOOL_ANNOTATIONS, READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

export async function registerAssetImportTools(
  server: McpServer,
  runtime: AssetImportOperationAdapter | undefined,
  sourceRoots: ExternalRootsService | undefined,
  localTransport: boolean,
  fileIngress = new AssetFileIngress(
    config.assetChatgptFileIngressEnabled,
    config.assetChatgptFileHosts,
  ),
): Promise<void> {
  if (!runtime) return;
  const externalRootReady = Boolean(
    sourceRoots && (await sourceRoots.hasBinaryProcessingRoot()),
  );
  if (
    config.assetImportEnabled &&
    !externalRootReady &&
    !fileIngress.isEnabled()
  ) {
    throw new McpError(
      BaseErrorCode.CONFIGURATION_ERROR,
      "Asset import requires an available readable + handoff ExternalRoot or enabled ChatGPT file ingress.",
      { reason: "asset_source_unavailable" },
    );
  }
  const source = (authInfo: Parameters<typeof assertExternalReadAccess>[1]): AssetSourceProvider => ({
    authorize: input => {
      assertExternalReadAccess(localTransport, authInfo);
      if (fileIngress.isReference(input)) {
        return fileIngress.authorizeReference(input);
      }
      if (!sourceRoots) {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          "Asset source roots are not configured.",
        );
      }
      return sourceRoots.binaryProcessingPolicy(input.rootId, input.relativePath);
    },
    read: async input => {
      assertExternalReadAccess(localTransport, authInfo);
      if (fileIngress.isReference(input)) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "Host file ingress must be supplied through the file parameter.",
          { reason: "asset_file_parameter_required" },
        );
      }
      if (!sourceRoots) {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          "Asset source roots are not configured.",
        );
      }
      return sourceRoots.readBinaryForProcessing(
        input.rootId,
        input.relativePath,
        ASSET_SOURCE_MAX_BYTES,
      );
    },
  });
  const writeGuard = () => {
    if (!config.assetImportEnabled || config.mcpWriteMode !== "full") {
      throw new McpError(BaseErrorCode.FORBIDDEN, "Asset import is disabled by the explicit write policy.", {reason:"asset_import_disabled"});
    }
    assertWriteAllowed({ operation:"asset_import_apply", action:"import", destructive:true });
  };
  async function run(toolName:string, authInfo: Parameters<typeof assertExternalReadAccess>[1], operation:()=>Promise<unknown>) {
    try {
      // Also protect status and terminal apply replay before any receipt inspection.
      assertExternalReadAccess(localTransport, authInfo);
      const result=await operation();
      const receipt=result as {outcome?:unknown;postflight?:{status?:unknown}};
      const failed=["conflict","rejected","failed","outcome_unknown"].includes(String(receipt.outcome)) ||
        (receipt.outcome==="committed"&&receipt.postflight?.status!=="verified");
      return {content:[{type:"text" as const,text:JSON.stringify(result)}],isError:failed};
    } catch(error) {
      return {content:[{type:"text" as const,text:JSON.stringify(publicMcpToolErrorPayload(error,{operation:toolName,toolName,params:{}}))}],isError:true};
    }
  }
  server.registerTool("asset_import_plan", {
    description:"Plan one explicitly requested image import. Use source for a server-local readable + handoff ExternalRoot, or file for a host-provided ChatGPT file parameter when that ingress is enabled. ChatGPT file parameters are fetched directly by the server through a bounded HTTPS path; no base64 passes through the model and no staging file is created. The configured vault-relative destination is discoverable in obsidian_runtime_status and is returned by the plan. Planning decodes the original, applies the configured policy and freezes exact output bytes in the existing private journal; no vault asset or note is written. Arbitrary URL strings, client-local paths, overwrite and implicit clipping downloads remain unsupported.",
    inputSchema:mcpSchema(AssetImportPlanInputSchema),
    annotations:{...GOVERNED_PLAN_TOOL_ANNOTATIONS,openWorldHint:true},
    _meta:{"openai/fileParams":["file"]},
  }, async (params:z.infer<typeof AssetImportPlanInputSchema>, context) => run(
    "asset_import_plan",
    context.http?.authInfo,
    async () => {
      if (params.file) {
        writeGuard();
        const replay = runtime.replayHostFilePlan({
          fileId: params.file.file_id,
          name: params.name,
          quality: params.quality,
          preserveOriginal: params.preserveOriginal,
          exceptionReason: params.exceptionReason,
          idempotencyKey: params.idempotencyKey,
        });
        if (replay) return replay;

        return runtime.coalescePlanClaim(
          {
            sourceKind: "chatgpt_file",
            sourceIdentity: { fileId: params.file.file_id },
            name: params.name,
            quality: params.quality,
            preserveOriginal: params.preserveOriginal,
            exceptionReason: params.exceptionReason,
            idempotencyKey: params.idempotencyKey,
          },
          async () => {
            const materialized = await fileIngress.materialize(params.file!);
            const durable: AssetImportInput = {
              source: materialized.source,
              name: params.name,
              quality: params.quality,
              preserveOriginal: params.preserveOriginal,
              exceptionReason: params.exceptionReason,
              idempotencyKey: params.idempotencyKey,
            };
            return runtime.plan(
              durable,
              materialized.provider,
              writeGuard,
              true,
            );
          },
          true,
        );
      }
      const durable: AssetImportInput = {
        source: params.source!,
        name: params.name,
        quality: params.quality,
        preserveOriginal: params.preserveOriginal,
        exceptionReason: params.exceptionReason,
        idempotencyKey: params.idempotencyKey,
      };
      writeGuard();
      return runtime.coalescePlanClaim(
        {
          sourceKind: "external_root",
          sourceIdentity: durable.source,
          name: durable.name,
          quality: durable.quality,
          preserveOriginal: durable.preserveOriginal,
          exceptionReason: durable.exceptionReason,
          idempotencyKey: durable.idempotencyKey,
        },
        () =>
          runtime.plan(
            durable,
            source(context.http?.authInfo),
            writeGuard,
          ),
      );
    },
  ));
  server.registerTool("asset_import_apply", {
    description:"Apply the exact sealed asset import once with its matching idempotency key. Requires the independent asset-import opt-in and full write policy; creates one binary without overwriting. Never creates directories or modifies a note. On timeout/lost response/partial effect, use status; never issue another import to retry. An uncertain asset is preserved, not automatically deleted. Insert the returned embed through a separate governed note operation only after postflight is verified.",
    inputSchema:mcpSchema(AssetApplyInputSchema),annotations:GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  }, async (params:z.infer<typeof AssetApplyInputSchema>, context) => run("asset_import_apply",context.http?.authInfo,()=>runtime.apply(params.planRef,params.idempotencyKey,source(context.http?.authInfo),writeGuard)));
  server.registerTool("asset_import_status", {
    description:"Observe one exact asset import and reconcile its durable receipt without creating, converting, deleting or replacing an asset or note. A matching file proves observed bytes, not authorship or Obsidian indexing. A previously committed but subsequently changed/missing asset returns unverified postflight and no usable embed. No automatic recovery or rollback is performed.",
    inputSchema:mcpSchema(AssetStatusInputSchema),annotations:READ_ONLY_TOOL_ANNOTATIONS,
  }, async (params:z.infer<typeof AssetStatusInputSchema>, context) => run("asset_import_status",context.http?.authInfo,()=>runtime.status(params.planRef)));
}
