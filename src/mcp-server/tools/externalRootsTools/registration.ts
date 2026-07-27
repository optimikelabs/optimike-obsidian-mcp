import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExternalRootError,
  ExternalRootsService,
} from "../../../services/externalRootsService.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";

const RootPathSchema = z
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

const ListSchema = RootPathSchema.extend({
  depth: z.number().int().min(0).max(20).default(1),
  maxEntries: z.number().int().positive().max(5000).optional(),
});

const StatSchema = RootPathSchema.extend({
  includeHash: z.boolean().default(false),
});

const ReadSchema = RootPathSchema.extend({
  maxChars: z.number().int().positive().max(2_000_000).optional(),
});

export const ExternalHandoffSchema = RootPathSchema.extend({
  includeHash: z.boolean().default(true),
});

function disabledError(): ExternalRootError {
  return new ExternalRootError(
    "configuration_invalid",
    "External roots are disabled. Configure MCP_EXTERNAL_ROOTS_FILE to enable them.",
  );
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
      const externalError =
        error instanceof ExternalRootError
          ? error
          : new ExternalRootError(
              "non_verifiable",
              error instanceof Error ? error.message : String(error),
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
    ListSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ListSchema>) =>
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
    StatSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof StatSchema>) =>
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
    "Reads bounded UTF-8 text from one explicitly allowed root-relative file. For binary and Office documents, a local stdio client can explicitly request external_handoff and use its own document tools.",
    ReadSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ReadSchema>) =>
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
    "Returns a verified local file path for an explicitly allowed stdio client so that its own document tools can process the file. Physical paths are disclosed only by this explicit handoff.",
    ExternalHandoffSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ExternalHandoffSchema>) =>
      externalRootsResult(() =>
        !localHandoffAllowed
          ? Promise.reject(
              new ExternalRootError(
                "capability_denied",
                "Local path handoff is available only over the stdio transport.",
              ),
            )
          : service
            ? service.handoff(
                params.rootId,
                params.relativePath,
                params.includeHash,
              )
            : Promise.reject(disabledError()),
      )(),
  );
}
