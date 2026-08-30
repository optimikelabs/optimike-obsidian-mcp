import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type BackendToolCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type BackendToolCallObservation = {
  result: unknown;
  generation?: number;
  sessionId?: string;
};

export type BackendVaultAdapterOptions = {
  backendEndpoint: string;
  rootConfigFingerprint: string;
  profileId?: string;
  expectedTargetAttestation?: string;
  /**
   * Supplied by the stdio proxy. It is deliberately process-local: a move
   * session must not survive a reconnect, even when the replacement targets
   * the same vault and exposes the same public status.
   */
  getActiveBackendSession?: () =>
    | { generation: number; sessionId: string }
    | undefined;
};

export type BackendVaultDestructiveSession = {
  generation: number;
  sessionId: string;
  bindingFingerprint: string;
};

export type ExternalMoveBindingIdentity = {
  /**
   * v2 is the first binding that is authenticated by the *backend* vault
   * target. Older journals deliberately remain readable, but are never
   * eligible for a destructive continuation.
   */
  schemaVersion: 2;
  backendFingerprint: string;
  vaultFingerprint: string;
  rootConfigFingerprint: string;
  bindingFingerprint: string;
  vaultIdentitySource: "backend_destructive_vault_attestation";
  verifiable: boolean;
};

/** Path-free signal used by the proxy to retain its read surface. */
export class BackendVaultTargetUnverifiedError extends Error {
  constructor() {
    super("External move target identity could not be proven by the backend.");
    this.name = "BackendVaultTargetUnverifiedError";
  }
}

/** The backend connection changed after a destructive move session began. */
export class BackendVaultSessionChangedError extends Error {
  constructor() {
    super(
      "External move backend session changed; no further vault repair or compensation is permitted.",
    );
    this.name = "BackendVaultSessionChangedError";
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function isOpaqueIdentityProof(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Derives a path-free attestation from a vault directory's stable filesystem
 * identity. The raw realpath, device and inode are never returned or persisted.
 */
export function attestVaultFilesystemTarget(
  vaultPath: string | undefined,
): string | undefined {
  if (!vaultPath) return undefined;
  try {
    const resolvedVault = realpathSync(vaultPath);
    const vaultStats = statSync(resolvedVault, { bigint: true });
    if (
      !vaultStats.isDirectory() ||
      vaultStats.dev === 0n ||
      vaultStats.ino === 0n
    ) {
      return undefined;
    }
    return createHash("sha256")
      .update("optimike.runtime.destructive-vault-attestation.v2\0", "utf8")
      .update(`${vaultStats.dev}:${vaultStats.ino}`, "utf8")
      .digest("hex");
  } catch {
    return undefined;
  }
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
      throw new Error("The vault backend rejected the request.");
    }
    throw new Error("The vault backend returned a non-JSON payload.");
  }
  if (toolResult.isError) {
    // Backend tool text may contain a vault path, note body, or upstream
    // stack detail. It is never a public diagnostic and must not reach the
    // durable external-move journal through a caller's catch path.
    throw new Error("The vault backend rejected the request.");
  }
  return parsed;
}

function extractBackendToolCallObservation(
  value: unknown,
): BackendToolCallObservation {
  if (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    typeof (value as Record<string, unknown>).generation === "number" &&
    Number.isSafeInteger((value as Record<string, unknown>).generation)
  ) {
    return {
      result: (value as Record<string, unknown>).result,
      generation: (value as Record<string, unknown>).generation as number,
      sessionId:
        typeof (value as Record<string, unknown>).sessionId === "string"
          ? ((value as Record<string, unknown>).sessionId as string)
          : undefined,
    };
  }
  // Direct adapters remain useful for read-only and unit-test callers. A
  // destructive session, however, fails closed when the proxy did not attach
  // its concrete connection generation.
  return { result: value };
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class BackendVaultAdapter {
  private bindingIdentityPromise?: Promise<ExternalMoveBindingIdentity>;
  private requireLiveInventory = false;
  private lastObservedGeneration: number | undefined;
  private lastObservedSessionId: string | undefined;

  constructor(
    private readonly callTool: BackendToolCaller,
    private readonly options?: BackendVaultAdapterOptions,
  ) {}

  private activeSession():
    | { generation: number; sessionId: string }
    | undefined {
    return this.options?.getActiveBackendSession?.();
  }

  private assertSessionCurrent(session: BackendVaultDestructiveSession): void {
    const active = this.activeSession();
    if (
      active?.generation !== session.generation ||
      active.sessionId !== session.sessionId
    ) {
      throw new BackendVaultSessionChangedError();
    }
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    session?: BackendVaultDestructiveSession,
  ): Promise<unknown> {
    if (session) this.assertSessionCurrent(session);
    const observed = extractBackendToolCallObservation(
      await this.callTool(name, args),
    );
    this.lastObservedGeneration = observed.generation;
    this.lastObservedSessionId = observed.sessionId;
    if (session) {
      if (
        observed.generation !== session.generation ||
        observed.sessionId !== session.sessionId
      ) {
        throw new BackendVaultSessionChangedError();
      }
    }
    return observed.result;
  }

  /**
   * Returns a path-redacted backend/vault/root identity for move plans.
   *
   * The coordinator should persist this value and reject apply or rollback
   * when the current binding differs. A stable explicit profile ID and a fresh
   * opaque backend attestation are required before the coordinator can
   * initialize; runtime status is only used through its public, path-redacted
   * contract.
   */
  async getBindingIdentity(
    refresh = false,
  ): Promise<ExternalMoveBindingIdentity> {
    if (!this.options) {
      throw new Error(
        "External move identity options are required for a profiled journal.",
      );
    }
    if (!this.options.profileId?.trim()) {
      throw new Error(
        "External move profile ID is required. Configure MCP_EXTERNAL_MOVE_PROFILE_ID.",
      );
    }
    if (refresh) this.bindingIdentityPromise = undefined;
    this.bindingIdentityPromise ??= this.loadBindingIdentity();
    return this.bindingIdentityPromise;
  }

  /**
   * Captures one backend generation after freshly proving the target. Every
   * destructive backend call receives this fence; a reconnect is terminal for
   * the operation rather than an invitation to use the replacement vault.
   */
  async captureDestructiveSession(
    expectedBinding?: ExternalMoveBindingIdentity,
  ): Promise<BackendVaultDestructiveSession> {
    const identity = await this.getBindingIdentity(true);
    const active = this.activeSession();
    if (
      !identity.verifiable ||
      (expectedBinding &&
        identity.bindingFingerprint !== expectedBinding.bindingFingerprint) ||
      active === undefined ||
      this.lastObservedGeneration !== active.generation ||
      this.lastObservedSessionId !== active.sessionId ||
      !Number.isSafeInteger(active.generation) ||
      !active.sessionId
    ) {
      throw new BackendVaultSessionChangedError();
    }
    return {
      generation: active.generation,
      sessionId: active.sessionId,
      bindingFingerprint: identity.bindingFingerprint,
    };
  }

  async openDestructiveSession(
    expectedBinding: ExternalMoveBindingIdentity,
    expectedSession?: BackendVaultDestructiveSession,
  ): Promise<BackendVaultDestructiveSession> {
    if (expectedSession) this.assertSessionCurrent(expectedSession);
    const session = await this.captureDestructiveSession(expectedBinding);
    if (
      expectedSession &&
      (session.generation !== expectedSession.generation ||
        session.sessionId !== expectedSession.sessionId)
    ) {
      throw new BackendVaultSessionChangedError();
    }
    return session;
  }

  assertDestructiveSession(session: BackendVaultDestructiveSession): void {
    this.assertSessionCurrent(session);
  }

  /**
   * A durable move status may be read after the stdio proxy has reconnected.
   * This check intentionally has no backend side effects: it only compares the
   * plan's private session fence with the proxy session currently in use. A
   * mismatch means that the old plan cannot safely repair or compensate a
   * possibly different vault.
   */
  isDestructiveSessionCurrent(
    session: BackendVaultDestructiveSession,
  ): boolean {
    try {
      this.assertSessionCurrent(session);
      return true;
    } catch {
      return false;
    }
  }

  private async loadBindingIdentity(): Promise<ExternalMoveBindingIdentity> {
    const options = this.options;
    if (!options) {
      throw new Error(
        "External move identity options are required for a profiled journal.",
      );
    }
    const explicitProfile = options.profileId?.trim();
    if (!explicitProfile) {
      throw new Error(
        "External move profile ID is required. Configure MCP_EXTERNAL_MOVE_PROFILE_ID.",
      );
    }
    const status = parseToolJson(
      await this.call("obsidian_runtime_status", {
        expectedDestructiveVaultAttestation: options.expectedTargetAttestation!,
      }),
    );
    const runtime = nestedRecord(status, "runtime");
    const configuration = runtime
      ? nestedRecord(runtime, "configuration")
      : undefined;
    const targetProven =
      status.runtimeMode === "headless-filesystem" &&
      isOpaqueIdentityProof(options.expectedTargetAttestation) &&
      configuration?.destructiveVaultIdentityVerified === true &&
      configuration?.destructiveVaultAttestationSchemeVersion === 2;
    if (!targetProven) {
      // Do not turn a malformed, unavailable, or swapped backend into a
      // merely advisory signal. The caller may keep its read surface alive,
      // but no move coordinator is authorized to exist for this connection.
      throw new BackendVaultTargetUnverifiedError();
    }

    const backendFingerprint = sha256Json({
      domain: "optimike.external-move.backend.v2",
      endpointFingerprint: sha256Json({
        domain: "optimike.external-move.backend-endpoint.v1",
        endpoint: options.backendEndpoint,
      }),
      runtimeMode:
        typeof status.runtimeMode === "string" ? status.runtimeMode : undefined,
      transport:
        typeof status.transport === "string" ? status.transport : undefined,
      cacheSource:
        typeof configuration?.cacheSource === "string"
          ? configuration.cacheSource
          : undefined,
      writeMode:
        typeof configuration?.writeMode === "string"
          ? configuration.writeMode
          : undefined,
      vaultConfigured:
        typeof configuration?.vaultConfigured === "boolean"
          ? configuration.vaultConfigured
          : undefined,
      semanticCacheConfigured:
        typeof configuration?.semanticCacheConfigured === "boolean"
          ? configuration.semanticCacheConfigured
          : undefined,
      queryEmbeddingEnabled:
        typeof configuration?.queryEmbeddingEnabled === "boolean"
          ? configuration.queryEmbeddingEnabled
          : undefined,
      protectedFrontmatterKeyCount:
        typeof configuration?.protectedFrontmatterKeyCount === "number"
          ? configuration.protectedFrontmatterKeyCount
          : undefined,
    });
    const vaultFingerprint = sha256Json({
      domain: "optimike.external-move.vault.v5",
      profileId: explicitProfile,
      targetAttestation: options.expectedTargetAttestation,
    });
    const bindingFingerprint = sha256Json({
      domain: "optimike.external-move.binding.v5",
      backendFingerprint,
      vaultFingerprint,
      rootConfigFingerprint: options.rootConfigFingerprint,
    });

    return {
      schemaVersion: 2,
      backendFingerprint,
      vaultFingerprint,
      rootConfigFingerprint: options.rootConfigFingerprint,
      bindingFingerprint,
      vaultIdentitySource: "backend_destructive_vault_attestation",
      verifiable: true,
    };
  }

  async refreshInventory(
    session?: BackendVaultDestructiveSession,
  ): Promise<void> {
    const status = parseToolJson(
      await this.call("obsidian_runtime_status", {}, session),
    );
    if (status.runtimeMode === "live" || status.runtimeMode === "hybrid") {
      this.requireLiveInventory = true;
      return;
    }
    this.requireLiveInventory = false;
    const parsed = parseToolJson(
      await this.call(
        "obsidian_runtime_maintenance",
        {
          action: "refresh_vault_cache",
        },
        session,
      ),
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
  async assertConditionalWritesSupported(
    session?: BackendVaultDestructiveSession,
  ): Promise<void> {
    const status = parseToolJson(
      await this.call("obsidian_runtime_status", {}, session),
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
    session?: BackendVaultDestructiveSession,
  ): Promise<string[]> {
    const paths = new Set<string>();
    let page = 1;
    let totalPages = 1;
    do {
      const parsed = parseToolJson(
        await this.call(
          "obsidian_global_search",
          {
            query,
            searchInPath: searchInPath || undefined,
            useRegex: false,
            caseSensitive,
            page,
            pageSize: 100,
            maxMatchesPerFile: 1,
            responseMode: "compact",
          },
          session,
        ),
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

  async read(
    filePath: string,
    session?: BackendVaultDestructiveSession,
  ): Promise<{
    filePath: string;
    content: string;
    sha256: string;
  }> {
    const parsed = parseToolJson(
      await this.call(
        "obsidian_read_note",
        {
          filePath,
          format: "markdown",
          includeStat: false,
        },
        session,
      ),
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
    session?: BackendVaultDestructiveSession,
  ): Promise<void> {
    const parsed = parseToolJson(
      await this.call(
        "obsidian_search_replace",
        {
          targetType: "filePath",
          targetIdentifier: filePath,
          replacements: [{ search: before, replace: after }],
          useRegex: false,
          caseSensitive: true,
          replaceAll: false,
          flexibleWhitespace: false,
          wholeWord: false,
          returnContent: false,
          expectedHash: expectedSha256,
        },
        session,
      ),
    );
    if (
      parsed.success !== true ||
      parsed.replacementsApplied !== 1 ||
      nestedRecord(parsed, "stats")?.hash !== sha256Text(after)
    ) {
      throw new Error("The conditional vault repair did not succeed.");
    }
  }
}
