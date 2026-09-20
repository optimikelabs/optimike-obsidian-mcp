import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type { NativeMoveApply } from "../nativeNoteMoveContract.js";
import type { NativeNoteMoveBackend } from "./nativeNoteMoveOperationAdapter.js";
import { requestContextService } from "../../utils/index.js";

export class RestNativeNoteMoveBackend implements NativeNoteMoveBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}
  preflight(sourcePath: string, destinationPath: string): Promise<unknown> {
    return this.rest.nativeNoteMovePreflight({ contractVersion: 1, sourcePath, destinationPath },
      requestContextService.createRequestContext({ operation: "NativeNoteMovePreflight" }));
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
