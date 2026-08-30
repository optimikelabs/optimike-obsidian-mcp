import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import {
  ExternalRootError,
  ExternalRootsService,
  externalMoveMutationUnavailableError,
  moveMutationStatus,
} from "../../../services/externalRootsService.js";
import { externalTransferBroker } from "../../../services/externalTransferBroker.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";

export const ExternalRootPathSchema = z
  .object({
    rootId: z
      .string()
      .min(1)
      .describe("Stable logical ID of a configured external root."),
    relativePath: z
      .string()
      .default("")
      .describe(
        "Path relative to the external root. Absolute paths are rejected.",
      ),
  })
  .strict();

export const ExternalListSchema = ExternalRootPathSchema.extend({
  depth: z.number().int().min(0).max(20).default(1),
  maxEntries: z.number().int().positive().max(5000).optional(),
});

export const ExternalStatSchema = ExternalRootPathSchema.extend({
  includeHash: z.boolean().default(false),
});

export const ExternalReadSchema = ExternalRootPathSchema.extend({
  maxChars: z.number().int().positive().max(2_000_000).optional(),
});

export const ExternalHandoffSchema = ExternalRootPathSchema.extend({
  includeHash: z.boolean().default(true),
});

export const ExternalReferencesScanSchema = ExternalRootPathSchema;

export const ExternalMovePlanSchema = z
  .object({
    rootId: z.string().min(1),
    sourceRelativePath: z.string().min(1),
    targetRelativePath: z.string().min(1),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

export const ExternalMoveApplySchema = z
  .object({
    planId: z.string().uuid(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

export const ExternalMoveStatusSchema = z
  .object({ planId: z.string().uuid() })
  .strict();

export const ExternalMoveRollbackSchema = ExternalMoveApplySchema;

function disabledError(): ExternalRootError {
  return new ExternalRootError(
    "configuration_invalid",
    "External roots are disabled. Configure MCP_EXTERNAL_ROOTS_FILE to enable them.",
  );
}

function secureHttpIdentity(
  authInfo: AuthInfo | undefined,
): authInfo is AuthInfo {
  return Boolean(
    authInfo &&
      authInfo.token !== "dev-mode-placeholder-token" &&
      authInfo.clientId !== "dev-client-id" &&
      !authInfo.scopes.includes("dev-scope") &&
      authInfo.scopes.includes("external:read"),
  );
}

function assertExternalReadAccess(
  localHandoffAllowed: boolean,
  authInfo: AuthInfo | undefined,
): void {
  if (localHandoffAllowed || secureHttpIdentity(authInfo)) return;
  throw new ExternalRootError(
    "capability_denied",
    "Direct HTTP external-root operations require a non-development authenticated client identity with the external:read scope.",
  );
}

async function deliverExternalHandoff(
  service: ExternalRootsService | undefined,
  localHandoffAllowed: boolean,
  params: z.infer<typeof ExternalHandoffSchema>,
  authInfo: AuthInfo | undefined,
): Promise<unknown> {
  if (!service) throw disabledError();

  if (localHandoffAllowed) {
    return service.handoff(
      params.rootId,
      params.relativePath,
      params.includeHash,
    );
  }

  if (!externalTransferBroker.enabled) {
    throw new ExternalRootError(
      "capability_denied",
      "HTTP handoff is disabled. The direct HTTP profile can still use status, listing, stat, hashing, and bounded UTF-8 reads.",
    );
  }
  if (!secureHttpIdentity(authInfo)) {
    throw new ExternalRootError(
      "capability_denied",
      "HTTP handoff requires a non-development authenticated client identity with the external:read scope.",
    );
  }

  // HTTP delivery always carries an integrity digest, independently of the
  // caller's includeHash preference, because the ticket contract relies on it.
  const prepared = await service.handoff(
    params.rootId,
    params.relativePath,
    true,
    externalTransferBroker.maxFileBytes,
  );
  return externalTransferBroker.issue(prepared, authInfo);
}

function externalReasonCode(error: unknown): ExternalRootError["code"] {
  return error instanceof ExternalRootError ? error.code : "non_verifiable";
}

function externalPublicMessage(
  reasonCode: ExternalRootError["code"],
): string | undefined {
  if (reasonCode === "non_verifiable") {
    return "The external path could not be verified.";
  }
  return undefined;
}

function publicExternalRootError(error: unknown): McpError {
  const reasonCode = externalReasonCode(error);

  const codeByReason: Record<ExternalRootError["code"], BaseErrorCode> = {
    configuration_invalid: BaseErrorCode.CONFIGURATION_ERROR,
    root_unknown: BaseErrorCode.NOT_FOUND,
    root_unavailable: BaseErrorCode.SERVICE_UNAVAILABLE,
    capability_denied: BaseErrorCode.FORBIDDEN,
    path_invalid: BaseErrorCode.VALIDATION_ERROR,
    path_outside_root: BaseErrorCode.FORBIDDEN,
    path_not_allowed: BaseErrorCode.FORBIDDEN,
    path_link_unsupported: BaseErrorCode.VALIDATION_ERROR,
    not_found: BaseErrorCode.NOT_FOUND,
    not_a_file: BaseErrorCode.VALIDATION_ERROR,
    not_a_directory: BaseErrorCode.VALIDATION_ERROR,
    target_exists: BaseErrorCode.CONFLICT,
    precondition_failed: BaseErrorCode.CONFLICT,
    too_large: BaseErrorCode.VALIDATION_ERROR,
    unsupported: BaseErrorCode.VALIDATION_ERROR,
    encrypted: BaseErrorCode.VALIDATION_ERROR,
    inaccessible: BaseErrorCode.SERVICE_UNAVAILABLE,
    non_verifiable: BaseErrorCode.SERVICE_UNAVAILABLE,
    timeout: BaseErrorCode.TIMEOUT,
  };
  return new McpError(
    codeByReason[reasonCode],
    "The external-root operation could not be completed. Review the reason code and retry only after resolving it.",
    { reasonCode: `EXTERNAL_ROOT_${reasonCode.toUpperCase()}` },
  );
}

export function externalRootsResult(
  toolNameOrOperation: string | (() => Promise<unknown>),
  params?: unknown,
  operation?: () => Promise<unknown>,
) {
  const toolName =
    typeof toolNameOrOperation === "string"
      ? toolNameOrOperation
      : "external_roots";
  const safeParams = typeof toolNameOrOperation === "string" ? params : {};
  const invoke =
    typeof toolNameOrOperation === "function" ? toolNameOrOperation : operation;
  return async () => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await invoke!(), null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (!(error instanceof ExternalRootError)) {
        console.error(
          "[external-roots] Unexpected filesystem error; details redacted.",
        );
      }
      const payload = publicMcpToolErrorPayload(
        publicExternalRootError(error),
        {
          operation: toolName,
          toolName,
          params: safeParams,
        },
      );
      const publicError = payload.error as {
        code: string;
        message: string;
        details?: { reasonCode?: string };
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: externalReasonCode(error),
                message:
                  externalPublicMessage(externalReasonCode(error)) ??
                  publicError.message,
                details: publicError.details,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  };
}

export async function registerExternalRootsTools(
  server: McpServer,
  service: ExternalRootsService | undefined,
  localHandoffAllowed: boolean,
): Promise<void> {
  server.tool(
    "external_runtime_status",
    "Reports whether explicitly configured external document roots are enabled and available. Physical root paths are never returned.",
    {},
    READ_ONLY_TOOL_ANNOTATIONS,
    async (_params, extra) =>
      externalRootsResult("external_runtime_status", {}, async () => {
        assertExternalReadAccess(localHandoffAllowed, extra?.authInfo);
        return {
          enabled: Boolean(service),
          mode: "read-only",
          externalMove: {
            available: false,
            // Direct HTTP may report the mutation boundary, but it cannot
            // establish the local vault binding required to plan or inspect a
            // move. Keep that transport limitation distinct from mutation
            // availability so callers do not mistake a transport denial for a
            // missing native primitive.
            planningAvailable: false,
            planningUnavailableReason: "stdio_only",
            ...moveMutationStatus(),
          },
          localHandoffAllowed,
          handoffModes: [
            ...(localHandoffAllowed ? (["local_path"] as const) : []),
            ...(!localHandoffAllowed && externalTransferBroker.enabled
              ? (["http_ticket"] as const)
              : []),
          ],
          httpHandoff: {
            ...externalTransferBroker.publicStatus(),
            available: externalTransferBroker.enabled,
            authenticatedIdentityRequired: true,
            requiredScope: "external:read",
            developmentBypassAccepted: false,
          },
          roots: service ? await service.listRoots() : [],
        };
      })(),
  );

  server.tool(
    "external_roots_list",
    "Lists configured external document root IDs, capabilities, limits, and availability without disclosing physical paths.",
    {},
    READ_ONLY_TOOL_ANNOTATIONS,
    async (_params, extra) =>
      externalRootsResult("external_roots_list", {}, async () => {
        assertExternalReadAccess(localHandoffAllowed, extra?.authInfo);
        return {
          roots: service ? await service.listRoots() : [],
        };
      })(),
  );

  server.tool(
    "external_list",
    "Lists bounded directory entries inside one configured external root. Paths are root-relative and links are never followed.",
    ExternalListSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalListSchema>, extra) =>
      externalRootsResult("external_list", params, () => {
        assertExternalReadAccess(localHandoffAllowed, extra?.authInfo);
        return service
          ? service.list(
              params.rootId,
              params.relativePath,
              params.depth,
              params.maxEntries,
            )
          : Promise.reject(disabledError());
      })(),
  );

  server.tool(
    "external_stat",
    "Returns bounded metadata and optionally a SHA-256 hash for one root-relative external file.",
    ExternalStatSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalStatSchema>, extra) =>
      externalRootsResult("external_stat", params, () => {
        assertExternalReadAccess(localHandoffAllowed, extra?.authInfo);
        return service
          ? service.getStat(
              params.rootId,
              params.relativePath,
              params.includeHash,
            )
          : Promise.reject(disabledError());
      })(),
  );

  server.tool(
    "external_read",
    "Reads bounded UTF-8 text from one explicitly allowed root-relative file. Binary and Office documents require an explicit handoff mode supported by the active transport.",
    ExternalReadSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalReadSchema>, extra) =>
      externalRootsResult("external_read", params, () => {
        assertExternalReadAccess(localHandoffAllowed, extra?.authInfo);
        return service
          ? service.readText(
              params.rootId,
              params.relativePath,
              params.maxChars,
            )
          : Promise.reject(disabledError());
      })(),
  );

  server.tool(
    "external_handoff",
    "Prepares one verified temporary copy of an explicitly allowed file. Stdio returns a local path; an authenticated HTTP profile may return a short-lived opaque download ticket. The source path is never returned over HTTP.",
    ExternalHandoffSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalHandoffSchema>, extra) =>
      externalRootsResult("external_handoff", params, () =>
        deliverExternalHandoff(
          service,
          localHandoffAllowed,
          params,
          extra?.authInfo,
        ),
      )(),
  );

  for (const definition of [
    {
      name: "external_references_scan",
      description:
        "Inventories canonical and ambiguous ÉLYSIA references to one external file. This stdio-only operation never mutates either surface.",
      schema: ExternalReferencesScanSchema.shape,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    {
      name: "external_move_plan",
      description:
        "Builds a durable stdio-only diagnostic plan for a same-root external file move and exact ÉLYSIA link repairs. Mutation is unavailable.",
      schema: ExternalMovePlanSchema.shape,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    {
      name: "external_move_status",
      description:
        "Returns the read-only durable status and redacted receipt for one external move plan.",
      schema: ExternalMoveStatusSchema.shape,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    {
      name: "external_move_apply",
      description:
        "Unavailable: native handle-relative external move mutation is not supported on this runtime.",
      schema: ExternalMoveApplySchema.shape,
      // This endpoint is retained so callers receive a stable, explicit
      // unsupported result. It cannot mutate while the native primitive is
      // unavailable, therefore its advertised MCP behavior must be read-only.
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    {
      name: "external_move_rollback",
      description:
        "Unavailable: native handle-relative external move mutation is not supported on this runtime.",
      schema: ExternalMoveRollbackSchema.shape,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
  ] as const) {
    server.tool(
      definition.name,
      definition.description,
      definition.schema,
      definition.annotations,
      externalRootsResult(definition.name, {}, () =>
        Promise.reject(
          definition.name === "external_move_apply" ||
            definition.name === "external_move_rollback"
            ? externalMoveMutationUnavailableError()
            : new ExternalRootError(
                "capability_denied",
                "External reference mutations and their plans are available only through the local stdio proxy.",
              ),
        ),
      ),
    );
  }
}
