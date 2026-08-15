import type { ObsidianRestApiService } from "../obsidianRestAPI/service.js";
import { requestContextService } from "../../utils/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import type { AtomicWriteBackend } from "./obsidianNoteReplaceOperationAdapter.js";

export class RestBaseAtomicWriteBackend implements AtomicWriteBackend {
  constructor(private readonly rest: ObsidianRestApiService) {}

  async status() {
    const result = await this.rest.getBaseAtomicStatus(
      requestContextService.createRequestContext({
        operation: "BaseAtomicStatus",
      }),
    );
    if (result.migration.legacyConfigWritesEnabled) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Governed Base operations require legacy whole-file config writes to be disabled in Bases Bridge.",
        { reason: "legacy_base_config_writes_enabled" },
      );
    }
    return {
      ...result,
      backend: { ...result.backend, kind: "obsidian-vault-process" as const },
      limits: { markdownOnly: true as const },
    };
  }

  async read(payload: Parameters<AtomicWriteBackend["read"]>[0]) {
    const result = await this.rest.readAtomicBase(
      payload,
      requestContextService.createRequestContext({
        operation: "BaseAtomicRead",
      }),
    );
    return { ...result, content: result.yaml };
  }

  async replace(payload: Parameters<AtomicWriteBackend["replace"]>[0]) {
    return this.rest.replaceAtomicBase(
      {
        contractVersion: payload.contractVersion,
        path: payload.path,
        bindingFingerprint: payload.bindingFingerprint,
        expectedSha256: payload.expectedSha256,
        nextYaml: payload.nextContent,
      },
      requestContextService.createRequestContext({
        operation: "BaseAtomicReplace",
      }),
    );
  }
}
