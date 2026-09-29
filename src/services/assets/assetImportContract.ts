import { z } from "zod";
import { assetSegment, assetFilename, ASSET_MAX_BYTES } from "./windowsAssetFiles.js";

export const ASSET_IMPORT_KIND = "obsidian.asset.import" as const;
export const ASSET_IMPORT_REF = "oasset:";
export const ASSET_IMPORT_KEY = "obsidian.asset.import:";
export const CHATGPT_FILE_ROOT_ID = "@chatgpt.file" as const;
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const AssetSourceSchema = z.object({
  rootId: z.string().min(1).max(128),
  relativePath: z.string().min(1).max(2048),
  sha256: Sha256.describe("Expected original SHA-256 from the authorized source. A changed source is rejected."),
}).strict();
export const AssetFileParamSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().regex(/^file_[A-Za-z0-9_-]{6,240}$/u),
  mime_type: z.string().min(1).max(200).optional(),
  file_name: z.string().min(1).max(255).optional(),
}).strict();

export const AssetImportInputSchema = z.object({
  source: AssetSourceSchema.describe("A source file on this server in a root authorized for readable + handoff. No URL, base64 or client-local path."),
  name: z.string().min(1).max(120).refine(value => {
    try { assetSegment(value); return true; } catch { return false; }
  }).describe("Explicit stable filename stem, without directories. The verified output format determines its extension."),
  quality: z.number().int().min(1).max(100).optional(),
  preserveOriginal: z.boolean().optional(),
  exceptionReason: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u),
}).strict().superRefine((input, ctx) => {
  if (input.preserveOriginal && !input.exceptionReason) ctx.addIssue({code:"custom",path:["exceptionReason"],message:"Original preservation requires an explicit reason."});
});
export const AssetImportPlanInputSchema = z.object({
  source: AssetSourceSchema.optional().describe(
    "Existing server-local source in a readable + handoff ExternalRoot.",
  ),
  file: AssetFileParamSchema.optional().describe(
    "Host-provided file parameter. ChatGPT supplies download_url and file_id through openai/fileParams; arbitrary URLs are not a substitute.",
  ),
  name: z.string().min(1).max(120).refine(value => {
    try { assetSegment(value); return true; } catch { return false; }
  }).describe("Explicit stable filename stem, without directories."),
  quality: z.number().int().min(1).max(100).optional(),
  preserveOriginal: z.boolean().optional(),
  exceptionReason: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u),
}).strict().superRefine((input, ctx) => {
  if (Boolean(input.source) === Boolean(input.file)) {
    ctx.addIssue({
      code: "custom",
      path: ["source"],
      message: "Provide exactly one source: server-local source or host file parameter.",
    });
  }
  if (input.preserveOriginal && !input.exceptionReason) {
    ctx.addIssue({
      code: "custom",
      path: ["exceptionReason"],
      message: "Original preservation requires an explicit reason.",
    });
  }
});

export type AssetImportPlanInput = z.infer<typeof AssetImportPlanInputSchema>;
export type AssetFileParam = z.infer<typeof AssetFileParamSchema>;

export const AssetApplyInputSchema = z.object({
  planRef: z.string().regex(/^oasset:[0-9a-f-]{36}$/u),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u),
}).strict();
export const AssetStatusInputSchema = z.object({planRef:AssetApplyInputSchema.shape.planRef}).strict();
export type AssetImportInput = z.infer<typeof AssetImportInputSchema>;
export type AssetSource = z.infer<typeof AssetSourceSchema>;
export const AssetMetadataSchema = z.object({
  format: z.enum(["webp","png","jpeg","gif","svg","avif"]),
  width:z.number().int().positive().max(16777216),
  height:z.number().int().positive().max(16777216),
  pages:z.number().int().positive().max(32),
  hasAlpha:z.boolean(), sourceSha256:Sha256, sha256:Sha256,
  size:z.number().int().positive().max(ASSET_MAX_BYTES),
  encoderVersion:z.string().min(1).max(100),
  exception:z.enum(["none","vector_preserved","animation_preserved","original_requested"]),
}).strict().refine(m => m.width*m.height*m.pages <= 16777216);
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;
export const AssetProofSchema = z.object({
  input:AssetImportInputSchema,
  filename:z.string().refine(value=>{try{assetFilename(value);return true;}catch{return false;}}),
  folder:z.string().min(1).max(800), policyDigest:Sha256, sourcePolicyDigest:Sha256, binding:Sha256,
  metadata:AssetMetadataSchema,
}).strict();
export type AssetProof = z.infer<typeof AssetProofSchema>;
export type AssetImportPolicy = {vaultRoot:string;assetFolder:string;quality:number};
export interface AssetSourceProvider {
  authorize(source:AssetSource):string|Promise<string>;
  read(source:AssetSource):Promise<Buffer>;
}
export const AssetInspectionSchema = z.discriminatedUnion("exists",[
  z.object({binding:Sha256,exists:z.literal(false)}).strict(),
  z.object({binding:Sha256,exists:z.literal(true),sha256:Sha256,size:z.number().int().nonnegative().max(ASSET_MAX_BYTES),fileIdentity:z.string().min(1).max(100)}).strict(),
]);
export type AssetInspection = z.infer<typeof AssetInspectionSchema>;
export interface AssetImportBackend {
  inspect(filename:string,binding?:string):Promise<AssetInspection>;
  create(filename:string,bytes:Buffer,binding:string):Promise<{sha256:string;size:number;fileIdentity:string}>;
}
