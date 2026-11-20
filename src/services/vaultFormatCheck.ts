import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { RequestContext } from "../utils/index.js";
import {
  STATIC_MARKDOWN_LIMITATION,
  type FormatIssue,
  type FormatValidationResult,
} from "./obsidianFormatService.js";
import type {
  NoteInspectFinding,
  NoteInspectRequest,
  NoteInspectResponse,
} from "./obsidianRestAPI/types.js";

/** Bounded so a busy or stalled Obsidian never holds a validation call. */
export const VAULT_CHECK_TIMEOUT_MS = 5_000;

export type VaultInspectClient = {
  inspectAtomicNote(
    payload: NoteInspectRequest,
    context: RequestContext,
    timeoutMs?: number,
  ): Promise<NoteInspectResponse>;
};

export type VaultCheck =
  | {
      status: "checked";
      baseline: "current_file" | "none";
      propertyTypes: NoteInspectResponse["coverage"]["properties"]["source"];
    }
  | {
      status: "not_checked";
      reason:
        | "bridge_not_configured"
        | "bridge_route_missing"
        | "bridge_unavailable"
        | "bridge_request_rejected"
        | "bridge_response_invalid";
    };

export type MarkdownValidationWithVault = FormatValidationResult & {
  vaultCheck: VaultCheck;
};

const FINDING_MESSAGES: Record<string, string> = {
  "link-unresolved": "Link target does not resolve to a file in the vault.",
  "embed-unresolved": "Embedded file is not in the vault.",
  "link-heading-missing": "Linked heading does not exist in the target note.",
  "link-block-missing": "Linked block id does not exist in the target note.",
  "unknown-callout":
    "Callout type is not defined by Obsidian, the theme or CSS snippets; Obsidian renders it as a note.",
  "property-type-mismatch": "Property value does not fit the type declared in the vault.",
};

const NOT_CHECKED_REASONS: Record<
  Extract<VaultCheck, { status: "not_checked" }>["reason"],
  string
> = {
  bridge_not_configured: "this runtime mode has no Obsidian REST connection.",
  bridge_route_missing: "the Atomic Write Bridge in Obsidian is too old for vault-aware checks.",
  bridge_unavailable: "Obsidian or the Atomic Write Bridge did not answer.",
  bridge_request_rejected: "the Atomic Write Bridge rejected the request (filePath must be a vault-relative .md path).",
  bridge_response_invalid: "the Atomic Write Bridge returned an unexpected response.",
};

function isFinding(value: unknown): value is NoteInspectFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Record<string, unknown>;
  return (
    typeof finding.code === "string" &&
    Object.hasOwn(FINDING_MESSAGES, finding.code) &&
    (finding.severity === "error" || finding.severity === "warning") &&
    (finding.location === "body" || finding.location === "frontmatter") &&
    typeof finding.line === "number" &&
    typeof finding.target === "string"
  );
}

function isResponse(value: unknown): value is NoteInspectResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return (
    response.ok === true &&
    Array.isArray(response.findings) &&
    !!response.coverage &&
    typeof response.coverage === "object"
  );
}

function toIssue(finding: NoteInspectFinding): FormatIssue {
  return {
    severity: finding.severity,
    code: finding.code,
    message: FINDING_MESSAGES[finding.code],
    path: finding.location,
    line: finding.line,
    target: finding.target.slice(0, 512),
    ...(typeof finding.declaredType === "string" ? { declaredType: finding.declaredType } : {}),
    ...(Array.isArray(finding.suggestions)
      ? { suggestions: finding.suggestions.filter((item) => typeof item === "string").slice(0, 3) }
      : {}),
  };
}

function notChecked(
  result: FormatValidationResult,
  reason: Extract<VaultCheck, { status: "not_checked" }>["reason"],
): MarkdownValidationWithVault {
  return {
    ...result,
    limitations: [
      ...result.limitations,
      `Markdown was not checked against the vault: ${NOT_CHECKED_REASONS[reason]}`,
    ],
    vaultCheck: { status: "not_checked", reason },
  };
}

function bridgePath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return /\.md$/iu.test(normalized) ? normalized : undefined;
}

/**
 * Merge Obsidian's own view of the vault into a static Markdown validation.
 * When the Bridge answers, its callout check replaces the fixed-list one.
 * Otherwise the static result stands and says it was not checked.
 */
export async function checkMarkdownAgainstVault(
  result: FormatValidationResult,
  input: { content: string; filePath?: string; source: "content" | "filePath" },
  client: VaultInspectClient | undefined,
  context: RequestContext,
  timeoutMs = VAULT_CHECK_TIMEOUT_MS,
): Promise<MarkdownValidationWithVault> {
  if (!client) return notChecked(result, "bridge_not_configured");
  const path = bridgePath(input.filePath);
  let response: unknown;
  try {
    response = await client.inspectAtomicNote(
      {
        contractVersion: 1,
        ...(path ? { path } : {}),
        content: input.content,
        // Validating a file by path checks the whole file; candidate content is
        // compared with the file it would replace.
        baseline: input.source === "filePath" ? "none" : "current_file",
      },
      context,
      timeoutMs,
    );
  } catch (error) {
    const code = error instanceof McpError ? error.code : undefined;
    return notChecked(
      result,
      code === BaseErrorCode.NOT_FOUND
        ? "bridge_route_missing"
        : code === BaseErrorCode.VALIDATION_ERROR
          ? "bridge_request_rejected"
          : "bridge_unavailable",
    );
  }
  if (!isResponse(response)) return notChecked(result, "bridge_response_invalid");

  const vaultIssues = response.findings.filter(isFinding).map(toIssue);
  const errors = [...result.errors, ...vaultIssues.filter((issue) => issue.severity === "error")];
  const warnings = [
    ...result.warnings.filter((issue) => issue.code !== "unknown-callout"),
    ...vaultIssues.filter((issue) => issue.severity === "warning"),
  ];
  const limitations = result.limitations.filter((item) => item !== STATIC_MARKDOWN_LIMITATION);
  limitations.push(
    response.baseline === "current_file"
      ? "Checked against the open vault: wikilinks, embeds, headings, block ids, callout types from loaded CSS and declared property types. Only issues this content adds to the current file are reported. Markdown-style [text](path) links and rendering are not checked."
      : "Checked against the open vault: wikilinks, embeds, headings, block ids, callout types from loaded CSS and declared property types. Markdown-style [text](path) links and rendering are not checked.",
  );
  if (response.coverage.references?.truncated || response.coverage.findings?.truncated) {
    limitations.push("The vault check stopped at its bound; more issues may exist.");
  }
  return {
    ...result,
    ok: errors.length === 0,
    errors,
    warnings,
    limitations,
    vaultCheck: {
      status: "checked",
      baseline: response.baseline === "current_file" ? "current_file" : "none",
      propertyTypes: response.coverage.properties?.source ?? "unavailable",
    },
  };
}
