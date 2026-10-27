import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import type { NoteCreateApply } from "../noteCreateContract.js";
import type { NoteCreateBackend } from "./noteCreateOperationAdapter.js";
import { requestContextService } from "../../utils/index.js";
import { assertNoFoldedSibling } from "../noteNameMcp.js";

export class RestNoteCreateBackend implements NoteCreateBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}
  status() { return this.rest.getAtomicWriteStatus(requestContextService.createRequestContext({ operation: "AtomicWriteStatus" })); }
  inspectFrontmatterFormat(yaml: string) { return this.rest.inspectAtomicFrontmatterFormat({ contractVersion: 1, yaml }, requestContextService.createRequestContext({ operation: "AtomicFrontmatterFormat" })); }
  async preflight(path: string): Promise<unknown> {
    const context = requestContextService.createRequestContext({ operation: "NoteCreatePreflight" });
    await this.refuseFoldedSibling(path, context);
    return this.rest.noteCreatePreflight({ contractVersion: 1, path }, context);
  }
  /** Windows/macOS fold case and Unicode form: refuse a name that would collide with a sibling there. */
  private async refuseFoldedSibling(path: string, context: ReturnType<typeof requestContextService.createRequestContext>) {
    const slash = path.lastIndexOf("/");
    let siblings: string[];
    try { siblings = await this.rest.listFiles(slash < 0 ? "" : path.slice(0, slash), context); }
    catch { return; } // listing unavailable: the Bridge applies the same check on the real directory
    assertNoFoldedSibling(path.slice(slash + 1), siblings);
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
