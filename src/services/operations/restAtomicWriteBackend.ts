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

  inspectFrontmatterFormat(yaml: string): Promise<unknown> {
    return this.rest.inspectAtomicFrontmatterFormat({ contractVersion: 1, yaml }, requestContextService.createRequestContext({ operation: "AtomicFrontmatterFormat" }));
  }

  read(payload: AtomicWriteReadRequest): Promise<AtomicWriteReadResponse> {
    return this.rest.readAtomicWriteNote(
      payload,
      requestContextService.createRequestContext({
        operation: "AtomicWriteRead",
      }),
    );
  }

  prepareDate(payload: { contractVersion: 1; path: string; expectedSha256: string; bindingFingerprint: string }) {
    return this.rest.prepareAtomicWriteDate(payload, requestContextService.createRequestContext({ operation: "AtomicWriteDatePreparation" }));
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
