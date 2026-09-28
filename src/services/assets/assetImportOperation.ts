import { z } from "zod";
import { operationDigest } from "../operations/contract.js";
import { ObsidianNoteReplaceJournal, ObsidianNoteReplaceConcurrencyError, type ObsidianNoteReplacePlan } from "../operations/obsidianNoteReplaceJournal.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { assetHash, assetFilename, assetSegment, ASSET_MAX_BYTES } from "./windowsAssetFiles.js";
import { runAssetJob, AssetWorkerError } from "./workerClient.js";
import { ASSET_IMPORT_KIND as KIND, ASSET_IMPORT_REF as REF, ASSET_IMPORT_KEY as KEY,
  AssetImportInputSchema, AssetProofSchema, AssetMetadataSchema, AssetInspectionSchema,
  type AssetImportInput, type AssetProof, type AssetImportPolicy, type AssetSourceProvider,
  type AssetImportBackend, type AssetInspection } from "./assetImportContract.js";
import type { ProcessedImage } from "./imageProcessing.js";

function deny(reason:string, code:BaseErrorCode=BaseErrorCode.FORBIDDEN):never {
  throw new McpError(code,"The asset operation could not be authorized or verified.",{reason});
}
function operationId(ref:string):string {
  if(typeof ref!=="string"||!ref.startsWith(REF)||!z.string().uuid().safeParse(ref.slice(REF.length)).success) deny("asset_plan_invalid");
  return ref.slice(REF.length);
}
const uncertain = (row:ObsidianNoteReplacePlan) => ["planned","applying","outcome_unknown"].includes(row.status);
let plansInFlight=0;

/** A binary projection of the existing journal, not another transaction engine. */
export class AssetImportOperationAdapter {
  readonly operationKind=KIND;
  private readonly policy:AssetImportPolicy;
  private readonly policyDigest:string;
  constructor(private readonly backend:AssetImportBackend,
    private readonly journal:ObsidianNoteReplaceJournal,
    policy:AssetImportPolicy,
    private readonly convert:(bytes:Buffer,policy:{quality:number;preserveOriginal?:boolean;exceptionReason?:string})=>Promise<ProcessedImage>
      = (bytes,policy)=>runAssetJob({kind:"convert",bytes,policy})) {
    if(!policy.assetFolder||policy.assetFolder.length>800||policy.assetFolder.includes("\\")) deny("asset_policy_invalid");
    policy.assetFolder.split("/").forEach(assetSegment);
    if(!Number.isInteger(policy.quality)||policy.quality<1||policy.quality>100) deny("asset_policy_invalid");
    this.policy=Object.freeze({...policy});
    this.policyDigest=operationDigest({version:1,...this.policy,backend:"windows-handle-relative-ntfs"});
  }
  private intent(input:AssetImportInput):string {
    return operationDigest({kind:KIND,input,policyDigest:this.policyDigest});
  }
  private proof(row:ObsidianNoteReplacePlan):AssetProof {
    if(row.projection?.kind!==KIND||row.projection.contractVersion!==1) deny("asset_projection_invalid");
    const parsed=AssetProofSchema.safeParse(row.projection.proof);
    if(!parsed.success) deny("asset_proof_invalid");
    const proof=parsed.data;
    if(proof.policyDigest!==this.policyDigest||proof.folder!==this.policy.assetFolder||
       row.path!==proof.folder+"/"+proof.filename||row.bindingFingerprint!==proof.binding||
       row.afterSha256!==proof.metadata.sha256||proof.metadata.sourceSha256!==proof.input.source.sha256||
       row.idempotencyKey!==KEY+proof.input.idempotencyKey||
       row.projection.publicIdempotencyKey!==proof.input.idempotencyKey||
       row.idempotencyIdentity!==this.intent(proof.input)||row.projection.intentDigest!==this.intent(proof.input)||
       row.requestDigest!==operationDigest(proof)||
       row.beforeSha256!==operationDigest({absent:row.path,binding:proof.binding})) deny("asset_proof_mismatch");
    if(uncertain(row)) {
      if(typeof row.nextContent!=="string"||row.nextContent.length>Math.ceil(ASSET_MAX_BYTES/3)*4) deny("asset_bytes_invalid");
      const bytes=Buffer.from(row.nextContent,"base64");
      if(bytes.toString("base64")!==row.nextContent||bytes.length!==proof.metadata.size||assetHash(bytes)!==row.afterSha256) deny("asset_bytes_invalid");
    }
    return proof;
  }
  private required(ref:string):ObsidianNoteReplacePlan {
    const row=this.journal.get(operationId(ref));if(!row)deny("asset_plan_not_found",BaseErrorCode.NOT_FOUND);
    this.proof(row);return row;
  }
  private receipt(row:ObsidianNoteReplacePlan,verified=false) {
    const proof=this.proof(row);
    const committed=row.status==="committed"&&verified;
    return {
      contractVersion:1,operationKind:KIND,planRef:REF+row.operationId,
      phase:row.status==="planned"?"planned":row.status==="applying"?"applying":"terminal",
      outcome:row.status==="planned"||row.status==="applying"?null:row.status,
      path:row.path,asset:proof.metadata,
      postflight:{status:verified?"verified":row.status==="planned"?"not_started":"unverified"},
      applyAllowed:row.status==="planned",recoveryAllowed:false,
      nextAction:row.status==="planned"?"apply":committed?"none":"status",
      embed:committed?"![["+row.path+"]]":null,
      noteInsertion:"separate_governed_operation",indexing:"not_certified",authorship:"not_proven_by_observation",
      admittedAt:row.createdAt,updatedAt:row.updatedAt,
    };
  }
  async plan(input:unknown,source:AssetSourceProvider,authorize:()=>void|Promise<void>) {
    const parsed=AssetImportInputSchema.parse(input);
    await authorize();await source.authorize(parsed.source);
    const existing=this.journal.getByIdempotencyKey(KEY+parsed.idempotencyKey);
    if(existing) {
      this.proof(existing);
      if(existing.idempotencyIdentity!==this.intent(parsed))deny("asset_idempotency_conflict",BaseErrorCode.CONFLICT);
      return this.receipt(existing);
    }
    if(plansInFlight>=2)deny("asset_plan_busy",BaseErrorCode.SERVICE_UNAVAILABLE);
    plansInFlight++;
    try {
      const bytes=await source.read(parsed.source);
      if(assetHash(bytes)!==parsed.source.sha256)deny("asset_source_changed",BaseErrorCode.CONFLICT);
      const processed=await this.convert(bytes,{quality:parsed.quality??this.policy.quality,
        preserveOriginal:parsed.preserveOriginal,exceptionReason:parsed.exceptionReason});
      const {bytes:output,...rest}=processed;
      const metadata=AssetMetadataSchema.parse(rest);
      if(!Buffer.isBuffer(output)||output.length!==metadata.size||assetHash(output)!==metadata.sha256||
         metadata.sourceSha256!==parsed.source.sha256)deny("asset_conversion_unverified");
      const filename=assetFilename(parsed.name+"."+metadata.format);
      const before=AssetInspectionSchema.parse(await this.backend.inspect(filename));
      if(before.exists)deny("asset_destination_exists",BaseErrorCode.CONFLICT);
      await source.authorize(parsed.source);await authorize();
      const proof=AssetProofSchema.parse({input:parsed,filename,folder:this.policy.assetFolder,
        policyDigest:this.policyDigest,binding:before.binding,metadata});
      const target=proof.folder+"/"+filename;
      const row=this.journal.create({
        idempotencyKey:KEY+parsed.idempotencyKey,idempotencyIdentity:this.intent(parsed),
        requestDigest:operationDigest(proof),path:target,
        beforeSha256:operationDigest({absent:target,binding:before.binding}),afterSha256:metadata.sha256,
        nextContent:output.toString("base64"),bindingFingerprint:before.binding,
        projection:{contractVersion:1,kind:KIND,publicIdempotencyKey:parsed.idempotencyKey,
          intentDigest:this.intent(parsed),proof},
      },32);
      return this.receipt(row);
    } finally {plansInFlight--;}
  }
  async apply(ref:string,key:string,source:AssetSourceProvider,authorize:()=>void|Promise<void>) {
    let row=this.required(ref);const proof=this.proof(row);
    if(key!==proof.input.idempotencyKey)deny("asset_idempotency_conflict",BaseErrorCode.CONFLICT);
    if(row.status!=="planned")return this.status(ref);
    await source.authorize(proof.input.source);await authorize();
    try {row=this.journal.transition(row.operationId,["planned"],"applying");}
    catch(error){if(error instanceof ObsidianNoteReplaceConcurrencyError)return this.status(ref);throw error;}
    const attempt=row.executionOwner?.attemptId;
    let dispatched=false;
    try {
      await source.authorize(proof.input.source);await authorize();
      const bytes=Buffer.from(row.nextContent,"base64");
      // No await can precede journaling the apply reservation. Once dispatched,
      // any uncertain worker result is reconciled; never perform a second write.
      dispatched=true;
      const result=await this.backend.create(proof.filename,bytes,proof.binding);
      if(result.sha256!==row.afterSha256||result.size!==proof.metadata.size||
         typeof result.fileIdentity!=="string"||!result.fileIdentity)throw new AssetWorkerError("asset_effect_unverified");
      row=this.journal.transition(row.operationId,["applying"],"committed",{
        effectProof:{kind:"exclusive_binary_create",digest:row.afterSha256,details:{nativeAcknowledged:true}},
      },attempt);
      return this.receipt(row,true);
    } catch(error) {
      const reason=error instanceof AssetWorkerError?error.reason:undefined;
      const outcome=!dispatched?"rejected":reason==="asset_exists"?"conflict":
        reason==="asset_binding_conflict"?"rejected":"outcome_unknown";
      try {row=this.journal.transition(row.operationId,["applying"],outcome,
        {failure:outcome==="outcome_unknown"?"asset_effect_unverified":"asset_request_rejected"},attempt);}
      catch(error){if(!(error instanceof ObsidianNoteReplaceConcurrencyError))throw error;row=this.required(ref);}
      return this.receipt(row);
    }
  }
  async status(ref:string) {
    let row=this.required(ref);const proof=this.proof(row);
    let observed:AssetInspection;
    try {observed=AssetInspectionSchema.parse(await this.backend.inspect(proof.filename,proof.binding));}
    catch {return this.receipt(row,false);}
    const matches=observed.binding===proof.binding&&observed.exists&&observed.sha256===row.afterSha256&&observed.size===proof.metadata.size;
    if(matches&&(row.status==="applying"||row.status==="outcome_unknown")) {
      try {row=this.journal.commitAfterVerifiedProof(row.operationId,{kind:"observed_binary_state",digest:row.afterSha256,details:{authorshipProven:false}});}
      catch(error){if(!(error instanceof ObsidianNoteReplaceConcurrencyError))throw error;row=this.required(ref);}
    }
    return this.receipt(row,Boolean(matches)&&row.status==="committed");
  }
}
