import { createHash } from "node:crypto";

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type BackendToolCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

function parseToolJson(result: unknown): Record<string, unknown> {
  const toolResult = result as ToolResult;
  const text = toolResult.content?.find(
    (item) => item.type === "text" && typeof item.text === "string",
  )?.text;
  if (!text) throw new Error("The vault backend returned no JSON payload.");
  const parsed = JSON.parse(text) as Record<string, unknown>;
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
  constructor(private readonly callTool: BackendToolCaller) {}

  async searchPaths(query: string, searchInPath = ""): Promise<string[]> {
    const paths = new Set<string>();
    let page = 1;
    let totalPages = 1;
    do {
      const parsed = parseToolJson(
        await this.callTool("obsidian_global_search", {
          query,
          searchInPath: searchInPath || undefined,
          useRegex: false,
          caseSensitive: true,
          page,
          pageSize: 100,
          maxMatchesPerFile: 1,
          responseMode: "compact",
        }),
      );
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      for (const item of results) {
        if (
          typeof item === "object" &&
          item !== null &&
          "path" in item &&
          typeof item.path === "string"
        ) {
          paths.add(item.path);
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
