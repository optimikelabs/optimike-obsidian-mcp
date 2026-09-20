import { z } from "zod";
import type {
  NoteLinksResponse,
  ObsidianRestApiService,
} from "../../../services/obsidianRestAPI/index.js";
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
): Promise<NoteLinksResponse> {
  if (!obsidianService) {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "obsidian_note_links requires a live Obsidian Desktop metadata cache.",
      context,
    );
  }
  const parsed = ObsidianNoteLinksInputSchema.parse(input);
  return obsidianService.readNoteLinks(
    {
      contractVersion: 1,
      path: parsed.filePath,
      limit: parsed.limit,
    },
    context,
  );
}
