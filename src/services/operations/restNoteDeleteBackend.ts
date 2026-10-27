import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type { NoteDeleteApply } from "../noteDeleteContract.js";
import type { NoteDeleteBackend } from "./noteDeleteOperationAdapter.js";
import { requestContextService } from "../../utils/index.js";
import { requireAtomicBridgeVersion } from "../atomicBridgeVersion.js";

export class RestNoteDeleteBackend implements NoteDeleteBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}
  async bridgeStatus(): Promise<unknown> {
    return requireAtomicBridgeVersion(await this.rest.getAtomicWriteStatus(requestContextService.createRequestContext({ operation: "AtomicWriteStatus" })));
  }
  async preflight(path: string, acknowledgeBacklinks: boolean): Promise<unknown> {
    await this.bridgeStatus();
    return this.rest.noteDeletePreflight(
      { contractVersion: 1, path, acknowledgeBacklinks },
      requestContextService.createRequestContext({ operation: "NoteDeletePreflight" }),
    );
  }
  apply(request: NoteDeleteApply): Promise<unknown> {
    return this.rest.noteDeleteApply(request,
      requestContextService.createRequestContext({ operation: "NoteDeleteApply" }));
  }
  status(operationId: string, preconditionDigest: string): Promise<unknown> {
    return this.rest.noteDeleteStatus({ contractVersion: 1, operationId, preconditionDigest },
      requestContextService.createRequestContext({ operation: "NoteDeleteStatus" }));
  }
}
