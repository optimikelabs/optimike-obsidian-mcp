import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type { NativeMoveApply } from "../nativeNoteMoveContract.js";
import type { NativeNoteMoveBackend } from "./nativeNoteMoveOperationAdapter.js";
import { requestContextService } from "../../utils/index.js";
import { assertNoFoldedSibling } from "../noteNameMcp.js";

export class RestNativeNoteMoveBackend implements NativeNoteMoveBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}
  bridgeStatus(): Promise<unknown> {
    return this.rest.getAtomicWriteStatus(requestContextService.createRequestContext({ operation: "AtomicWriteStatus" }));
  }
  async preflight(sourcePath: string, destinationPath: string): Promise<unknown> {
    const context = requestContextService.createRequestContext({ operation: "NativeNoteMovePreflight" });
    const slash = destinationPath.lastIndexOf("/");
    let siblings: string[] | undefined;
    try { siblings = await this.rest.listFiles(slash < 0 ? "" : destinationPath.slice(0, slash), context); }
    catch { /* listing unavailable: the Bridge applies the same check on the real directory */ }
    // Windows/macOS fold case and Unicode form: refuse a name that would collide with a sibling there.
    if (siblings) assertNoFoldedSibling(destinationPath.slice(slash + 1), siblings);
    return this.rest.nativeNoteMovePreflight({ contractVersion: 1, sourcePath, destinationPath }, context);
  }
  apply(request: NativeMoveApply): Promise<unknown> {
    return this.rest.nativeNoteMoveApply(request,
      requestContextService.createRequestContext({ operation: "NativeNoteMoveApply" }));
  }
  status(operationId: string, preconditionDigest: string): Promise<unknown> {
    return this.rest.nativeNoteMoveStatus({ contractVersion: 1, operationId, preconditionDigest },
      requestContextService.createRequestContext({ operation: "NativeNoteMoveStatus" }));
  }
}
