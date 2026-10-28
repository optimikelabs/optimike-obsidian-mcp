import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type { VaultFileCreateApply, VaultFileCreateKind } from "../vaultFileCreateContract.js";
import type { VaultFileCreateBackend } from "./vaultFileCreateOperationAdapter.js";
import { requestContextService } from "../../utils/index.js";
import { assertNoFoldedSibling } from "../noteNameMcp.js";
import { requireAtomicBridgeVersion } from "../atomicBridgeVersion.js";

export class RestVaultFileCreateBackend implements VaultFileCreateBackend {
  constructor(private readonly rest: ObsidianRestApiService, readonly kind: VaultFileCreateKind) {}
  async status() { return requireAtomicBridgeVersion(await this.rest.getAtomicWriteStatus(requestContextService.createRequestContext({ operation: "AtomicWriteStatus" }))); }
  async preflight(path: string): Promise<unknown> {
    const context = requestContextService.createRequestContext({ operation: "VaultFileCreatePreflight" });
    // Windows/macOS fold case and Unicode form; the Bridge repeats the check on the real directory.
    const slash = path.lastIndexOf("/");
    let siblings: string[] | undefined;
    try { siblings = await this.rest.listFiles(slash < 0 ? "" : path.slice(0, slash), context); } catch { siblings = undefined; }
    if (siblings) assertNoFoldedSibling(path.slice(slash + 1), siblings);
    return this.rest.vaultFileCreate(this.kind, "preflight", { contractVersion: 1, path }, context);
  }
  create(request: VaultFileCreateApply): Promise<unknown> {
    return this.rest.vaultFileCreate(this.kind, "apply", request, requestContextService.createRequestContext({ operation: "VaultFileCreateApply" }));
  }
  inspect(path: string): Promise<unknown> {
    return this.rest.vaultFileCreate(this.kind, "inspect", { contractVersion: 1, path }, requestContextService.createRequestContext({ operation: "VaultFileCreateInspect" }));
  }
}
