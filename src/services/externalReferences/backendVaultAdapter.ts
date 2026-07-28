import { createHash } from "node:crypto";
import path from "node:path";

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type BackendToolCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type BackendVaultAdapterOptions = {
  backendEndpoint: string;
  rootConfigFingerprint: string;
  profileId?: string;
};

export type ExternalMoveBindingIdentity = {
  schemaVersion: 1;
  backendFingerprint: string;
  vaultFingerprint: string;
  rootConfigFingerprint: string;
  bindingFingerprint: string;
  vaultIdentitySource:
    | "explicit_profile"
    | "configured_vault"
    | "shared_cache_fallback";
  verifiable: boolean;
};

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function normalizedIdentityPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !(key in value) ||
    typeof (value as Record<string, unknown>)[key] !== "object" ||
    (value as Record<string, unknown>)[key] === null
  ) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key] as Record<string, unknown>;
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const toolResult = result as ToolResult;
  const text = toolResult.content?.find(
    (item) => item.type === "text" && typeof item.text === "string",
  )?.text;
  if (!text) throw new Error("The vault backend returned no JSON payload.");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (toolResult.isError) {
      throw new Error(text);
    }
    throw new Error("The vault backend returned a non-JSON payload.");
  }
  if (toolResult.isError) {
    throw new Error(
      typeof parsed.message === "string"
        ? parsed.message
        : "The vault backend rejected the request.",
    );
  }
  return parsed;
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class BackendVaultAdapter {
  private bindingIdentityPromise?: Promise<ExternalMoveBindingIdentity>;
  private requireLiveInventory = false;

  constructor(
    private readonly callTool: BackendToolCaller,
    private readonly options?: BackendVaultAdapterOptions,
  ) {}

  /**
   * Returns a path-redacted backend/vault/root identity for move plans.
   *
   * The coordinator should persist this value and reject apply or rollback
   * when the current binding differs. `verifiable: false` means the backend
   * exposed only its shared-cache path; apply should require an explicit
   * `MCP_EXTERNAL_MOVE_PROFILE_ID` in that case.
   */
  async getBindingIdentity(
    refresh = false,
  ): Promise<ExternalMoveBindingIdentity> {
    if (!this.options) {
      throw new Error(
        "External move identity options are required for a profiled journal.",
      );
    }
    if (refresh) this.bindingIdentityPromise = undefined;
    this.bindingIdentityPromise ??= this.loadBindingIdentity();
    return this.bindingIdentityPromise;
  }

  private async loadBindingIdentity(): Promise<ExternalMoveBindingIdentity> {
    const options = this.options;
    if (!options) {
      throw new Error(
        "External move identity options are required for a profiled journal.",
      );
    }
    const status = parseToolJson(
      await this.callTool("obsidian_runtime_status", {}),
    );
    const runtime = nestedRecord(status, "runtime");
    const configFields = runtime
      ? nestedRecord(runtime, "configFields")
      : undefined;
    const sharedCache = nestedRecord(status, "sharedCache");
    const configuredVault =
      configFields && typeof configFields.obsidianVaultPath === "string"
        ? configFields.obsidianVaultPath
        : undefined;
    const sharedCachePath =
      sharedCache && typeof sharedCache.dbPath === "string"
        ? sharedCache.dbPath
        : undefined;
    const explicitProfile = options.profileId?.trim();

    let vaultIdentitySource: ExternalMoveBindingIdentity["vaultIdentitySource"];
    let vaultIdentityMaterial: string;
    let verifiable: boolean;
    if (explicitProfile) {
      vaultIdentitySource = "explicit_profile";
      vaultIdentityMaterial = configuredVault
        ? `profile:${explicitProfile}|vault:${normalizedIdentityPath(configuredVault)}`
        : `profile:${explicitProfile}`;
      verifiable = true;
    } else if (configuredVault) {
      vaultIdentitySource = "configured_vault";
      vaultIdentityMaterial = `vault:${normalizedIdentityPath(configuredVault)}`;
      verifiable = true;
    } else if (sharedCachePath) {
      vaultIdentitySource = "shared_cache_fallback";
      vaultIdentityMaterial = `cache:${normalizedIdentityPath(sharedCachePath)}`;
      verifiable = false;
    } else {
      throw new Error(
        "The backend did not expose a vault identity. Configure MCP_EXTERNAL_MOVE_PROFILE_ID.",
      );
    }

    const backendFingerprint = sha256Json({
      domain: "optimike.external-move.backend.v1",
      runtimeMode: configFields?.obsidianRuntimeMode,
      obsidianBaseUrl: configFields?.obsidianBaseUrl,
      configuredVault: configuredVault
        ? normalizedIdentityPath(configuredVault)
        : undefined,
      cacheSource: configFields?.obsidianCacheSource,
      writeMode: configFields?.mcpWriteMode,
      protectedFrontmatterKeys: configFields?.mcpProtectedFrontmatterKeys,
    });
    const vaultFingerprint = sha256Json({
      domain: "optimike.external-move.vault.v1",
      source: vaultIdentitySource,
      identity: vaultIdentityMaterial,
    });
    const bindingFingerprint = sha256Json({
      domain: "optimike.external-move.binding.v1",
      backendFingerprint,
      vaultFingerprint,
      rootConfigFingerprint: options.rootConfigFingerprint,
    });

    return {
      schemaVersion: 1,
      backendFingerprint,
      vaultFingerprint,
      rootConfigFingerprint: options.rootConfigFingerprint,
      bindingFingerprint,
      vaultIdentitySource,
      verifiable,
    };
  }

  async refreshInventory(): Promise<void> {
    const status = parseToolJson(
      await this.callTool("obsidian_runtime_status", {}),
    );
    if (status.runtimeMode === "live" || status.runtimeMode === "hybrid") {
      this.requireLiveInventory = true;
      return;
    }
    this.requireLiveInventory = false;
    const parsed = parseToolJson(
      await this.callTool("obsidian_runtime_maintenance", {
        action: "refresh_vault_cache",
      }),
    );
    const sharedCache = nestedRecord(parsed, "sharedCache");
    if (!sharedCache || sharedCache.status !== "ready") {
      throw new Error(
        "The vault cache did not provide a complete ready inventory.",
      );
    }
  }

  /**
   * External reference repairs require a writer that can enforce the supplied
   * content hash atomically. Current Local REST writes do not enforce that
   * precondition, so only the guarded filesystem implementation on a copied or
   * dedicated vault is eligible.
   */
  async assertConditionalWritesSupported(): Promise<void> {
    const status = parseToolJson(
      await this.callTool("obsidian_runtime_status", {}),
    );
    if (status.runtimeMode !== "headless-filesystem") {
      throw new Error(
        "External move apply requires headless-filesystem on a copied or dedicated vault. Current live Local REST writes do not provide atomic expectedSha256 enforcement.",
      );
    }
  }

  async searchPaths(
    query: string,
    searchInPath = "",
    caseSensitive = true,
  ): Promise<string[]> {
    const paths = new Set<string>();
    let page = 1;
    let totalPages = 1;
    do {
      const parsed = parseToolJson(
        await this.callTool("obsidian_global_search", {
          query,
          searchInPath: searchInPath || undefined,
          useRegex: false,
          caseSensitive,
          page,
          pageSize: 100,
          maxMatchesPerFile: 1,
          responseMode: "compact",
        }),
      );
      if (
        this.requireLiveInventory &&
        (typeof parsed.message !== "string" ||
          !parsed.message.includes("API search successful") ||
          parsed.message.includes("Falling back"))
      ) {
        throw new Error(
          "A complete external-move inventory requires the live Obsidian API; cache fallback is not accepted.",
        );
      }
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      for (const item of results) {
        if (
          typeof item === "object" &&
          item !== null &&
          "path" in item &&
          typeof item.path === "string"
        ) {
          paths.add(item.path.replace(/^\/+/u, ""));
        }
      }
      totalPages =
        typeof parsed.totalPages === "number" ? parsed.totalPages : page;
      page += 1;
    } while (page <= totalPages);
    return [...paths].sort((a, b) => a.localeCompare(b));
  }

  async read(filePath: string): Promise<{
    filePath: string;
    content: string;
    sha256: string;
  }> {
    const parsed = parseToolJson(
      await this.callTool("obsidian_read_note", {
        filePath,
        format: "markdown",
        includeStat: false,
      }),
    );
    if (typeof parsed.content !== "string") {
      throw new Error("The vault backend returned a non-Markdown note.");
    }
    return {
      filePath,
      content: parsed.content,
      sha256: sha256Text(parsed.content),
    };
  }

  async conditionalReplace(
    filePath: string,
    before: string,
    after: string,
    expectedSha256: string,
  ): Promise<void> {
    const parsed = parseToolJson(
      await this.callTool("obsidian_search_replace", {
        targetType: "filePath",
        targetIdentifier: filePath,
        replacements: [{ search: before, replace: after }],
        useRegex: false,
        caseSensitive: true,
        replaceAll: false,
        flexibleWhitespace: false,
        wholeWord: false,
        returnContent: false,
        expectedSha256,
      }),
    );
    if (parsed.success !== true) {
      throw new Error("The conditional vault repair did not succeed.");
    }
  }
}
