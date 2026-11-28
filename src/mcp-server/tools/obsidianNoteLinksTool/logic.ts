import { z } from "zod/v3";
import type {
  FilesystemNoteLinksResponse,
  NoteLinksResponse,
  ObsidianRestApiService,
} from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import type { RequestContext } from "../../../utils/index.js";

export const OBSIDIAN_NOTE_LINKS_DEFAULT_LIMIT = 200;
export const OBSIDIAN_NOTE_LINKS_MAX_LIMIT = 1000;

export const ObsidianNoteLinksInputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.toLowerCase().endsWith(".md"), {
      message: "filePath must identify a Markdown note.",
    })
    .describe("Vault-relative Markdown note path."),
  requireComplete: z.boolean().optional().describe(
    "For filesystem reads, refuse when a limited source could affect the result.",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(OBSIDIAN_NOTE_LINKS_MAX_LIMIT)
    .optional()
    .default(OBSIDIAN_NOTE_LINKS_DEFAULT_LIMIT)
    .describe(
      "Maximum returned independently for outgoing references, unresolved aggregates, and backlinks. Defaults to 200; maximum 1000.",
    ),
});

export type ObsidianNoteLinksInput = z.infer<
  typeof ObsidianNoteLinksInputSchema
>;

export async function processObsidianNoteLinks(
  input: ObsidianNoteLinksInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService | undefined,
  vaultCache?: VaultCacheService,
): Promise<NoteLinksResponse | FilesystemNoteLinksResponse> {
  const parsed = ObsidianNoteLinksInputSchema.parse(input);
  if (!obsidianService) {
    if (vaultCache) return vaultCache.readFilesystemNoteLinks(parsed.filePath, parsed.limit, context, parsed.requireComplete);
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Note links require Obsidian Desktop or the shared filesystem cache.",
      context,
    );
  }
  return obsidianService.readNoteLinks(
    {
      contractVersion: 1,
      path: parsed.filePath,
      limit: parsed.limit,
    },
    context,
  );
}
