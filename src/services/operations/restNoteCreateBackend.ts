import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type { NoteCreateApply } from "../noteCreateContract.js";
import type { NoteCreateBackend } from "./noteCreateOperationAdapter.js";
import { requestContextService } from "../../utils/index.js";

export class RestNoteCreateBackend implements NoteCreateBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}
  preflight(path: string): Promise<unknown> {
    return this.rest.noteCreatePreflight({ contractVersion: 1, path },
      requestContextService.createRequestContext({ operation: "NoteCreatePreflight" }));
  }
  create(request: NoteCreateApply): Promise<unknown> {
    return this.rest.noteCreateApply(request,
      requestContextService.createRequestContext({ operation: "NoteCreateApply" }));
  }
  inspect(path: string): Promise<unknown> {
    return this.rest.noteCreateInspect({ contractVersion: 1, path },
      requestContextService.createRequestContext({ operation: "NoteCreateInspect" }));
  }
}
