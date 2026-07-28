import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import {
  ExternalRootError,
  ExternalRootsService,
} from "../../../services/externalRootsService.js";
import { externalTransferBroker } from "../../../services/externalTransferBroker.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";

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

function disabledError(): ExternalRootError {
  return new ExternalRootError(
    "configuration_invalid",
    "External roots are disabled. Configure MCP_EXTERNAL_ROOTS_FILE to enable them.",
  );
}

function secureHttpIdentity(authInfo: AuthInfo | undefined): authInfo is AuthInfo {
  return Boolean(
    authInfo &&
      authInfo.token !== "dev-mode-placeholder-token" &&
      authInfo.clientId !== "dev-client-id" &&
      !authInfo.scopes.includes("dev-scope"),
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
      "HTTP handoff requires a non-development authenticated client identity.",
    );
  }

  // HTTP delivery always carries an integrity digest, independently of the
  // caller's includeHash preference, because the ticket contract relies on it.
  const prepared = await service.handoff(
    params.rootId,
    params.relativePath,
    true,
  );
  return externalTransferBroker.issue(prepared, authInfo);
}

export function externalRootsResult(operation: () => Promise<unknown>) {
  return async () => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await operation(), null, 2),
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
      const externalError =
        error instanceof ExternalRootError
          ? error
          : new ExternalRootError(
              "non_verifiable",
              "The external path could not be verified.",
            );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { error: externalError.code, message: externalError.message },
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
    externalRootsResult(async () => ({
      enabled: Boolean(service),
      mode: "read-only",
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
        developmentBypassAccepted: false,
      },
      roots: service ? await service.listRoots() : [],
    })),
  );

  server.tool(
    "external_roots_list",
    "Lists configured external document root IDs, capabilities, limits, and availability without disclosing physical paths.",
    {},
    READ_ONLY_TOOL_ANNOTATIONS,
    externalRootsResult(async () => ({
      roots: service ? await service.listRoots() : [],
    })),
  );

  server.tool(
    "external_list",
    "Lists bounded directory entries inside one configured external root. Paths are root-relative and links are never followed.",
    ExternalListSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalListSchema>) =>
      externalRootsResult(() =>
        service
          ? service.list(
              params.rootId,
              params.relativePath,
              params.depth,
              params.maxEntries,
            )
          : Promise.reject(disabledError()),
      )(),
  );

  server.tool(
    "external_stat",
    "Returns bounded metadata and optionally a SHA-256 hash for one root-relative external file.",
    ExternalStatSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalStatSchema>) =>
      externalRootsResult(() =>
        service
          ? service.getStat(
              params.rootId,
              params.relativePath,
              params.includeHash,
            )
          : Promise.reject(disabledError()),
      )(),
  );

  server.tool(
    "external_read",
    "Reads bounded UTF-8 text from one explicitly allowed root-relative file. Binary and Office documents require an explicit handoff mode supported by the active transport.",
    ExternalReadSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalReadSchema>) =>
      externalRootsResult(() =>
        service
          ? service.readText(
              params.rootId,
              params.relativePath,
              params.maxChars,
            )
          : Promise.reject(disabledError()),
      )(),
  );

  server.tool(
    "external_handoff",
    "Prepares one verified temporary copy of an explicitly allowed file. Stdio returns a local path; an authenticated HTTP profile may return a short-lived opaque download ticket. The source path is never returned over HTTP.",
    ExternalHandoffSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalHandoffSchema>, extra) =>
      externalRootsResult(() =>
        deliverExternalHandoff(
          service,
          localHandoffAllowed,
          params,
          extra.authInfo,
        ),
      )(),
  );
}
