import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type {
  AtomicWriteCasRequest,
  AtomicWriteCasResponse,
  AtomicWriteReadRequest,
  AtomicWriteReadResponse,
  AtomicWriteStatusResponse,
} from "../obsidianRestAPI/types.js";
import { requestContextService } from "../../utils/index.js";
import type { AtomicWriteBackend } from "./obsidianNoteReplaceOperationAdapter.js";

export class RestAtomicWriteBackend implements AtomicWriteBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}

  status(): Promise<AtomicWriteStatusResponse> {
    return this.rest.getAtomicWriteStatus(
      requestContextService.createRequestContext({
        operation: "AtomicWriteStatus",
      }),
    );
  }

  read(payload: AtomicWriteReadRequest): Promise<AtomicWriteReadResponse> {
    return this.rest.readAtomicWriteNote(
      payload,
      requestContextService.createRequestContext({
        operation: "AtomicWriteRead",
      }),
    );
  }

  replace(payload: AtomicWriteCasRequest): Promise<AtomicWriteCasResponse> {
    return this.rest.replaceAtomicWriteNote(
      payload,
      requestContextService.createRequestContext({
        operation: "AtomicWriteReplace",
      }),
    );
  }
}
