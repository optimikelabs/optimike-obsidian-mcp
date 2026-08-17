import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type {
  AtomicWriteStatusResponse,
  CanvasAtomicCasRequest,
  CanvasAtomicCasResponse,
  CanvasAtomicReadRequest,
  CanvasAtomicReadResponse,
} from "../obsidianRestAPI/types.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { requestContextService } from "../../utils/index.js";
import type { AtomicWriteBackend } from "./obsidianNoteReplaceOperationAdapter.js";

export class RestCanvasAtomicWriteBackend implements AtomicWriteBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}

  async status(): Promise<AtomicWriteStatusResponse> {
    const status = await this.rest.getAtomicWriteStatus(
      requestContextService.createRequestContext({
        operation: "CanvasAtomicWriteStatus",
      }),
    );
    if (
      status.backend.canvasAtomicCas !== true ||
      typeof status.backend.canvasWriteEnabled !== "boolean"
    ) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Atomic Write Bridge does not expose the governed Canvas CAS capability.",
        { reason: "canvas_atomic_capability_missing" },
      );
    }
    return {
      ...status,
      backend: {
        ...status.backend,
        writeEnabled: status.backend.canvasWriteEnabled,
      },
      settlement: undefined,
      protection: undefined,
    };
  }

  read(payload: CanvasAtomicReadRequest): Promise<CanvasAtomicReadResponse> {
    return this.rest.readAtomicWriteCanvas(
      payload,
      requestContextService.createRequestContext({
        operation: "CanvasAtomicWriteRead",
      }),
    );
  }

  replace(payload: CanvasAtomicCasRequest): Promise<CanvasAtomicCasResponse> {
    return this.rest.replaceAtomicWriteCanvas(
      payload,
      requestContextService.createRequestContext({
        operation: "CanvasAtomicWriteReplace",
      }),
    );
  }
}
