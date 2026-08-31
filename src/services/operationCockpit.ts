import { Buffer } from "node:buffer";
import { z } from "zod";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type {
  PendingOperationRow,
  PendingOperationRowsInput,
  PendingOperationRowsPage,
} from "./operations/obsidianNoteReplaceJournal.js";

export const OPERATION_COCKPIT_CONTRACT_VERSION = 1 as const;
export const OPERATION_COCKPIT_DEFAULT_LIMIT = 50 as const;
export const OPERATION_COCKPIT_MAX_LIMIT = 100 as const;

const OperationKindSchema = z.enum([
  "obsidian.note.replace",
  "obsidian.frontmatter.patch",
  "obsidian.base.formula.patch",
  "obsidian.canvas.patch",
  "obsidian.text.patch",
]);

const PendingRowSchema = z
  .object({
    operationId: z.string().uuid(),
    status: z.enum(["planned", "applying", "outcome_unknown"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    operationKind: OperationKindSchema,
  })
  .strict();

const CursorSchema = z
  .object({
    contractVersion: z.literal(OPERATION_COCKPIT_CONTRACT_VERSION),
    updatedAt: z.string().datetime({ offset: true }),
    operationKind: OperationKindSchema,
    operationId: z.string().uuid(),
  })
  .strict();

type Cursor = z.infer<typeof CursorSchema>;

export type PendingOperationSource = {
  listPendingOperationRows(
    input: Omit<
      PendingOperationRowsInput,
      | "fallbackOperationKind"
      | "admittedProjectionKinds"
      | "allowUnprojectedFallback"
    >,
  ): PendingOperationRowsPage;
};

export type OperationCockpitItem = {
  operationKind: z.infer<typeof OperationKindSchema>;
  planRef: string;
  state: PendingOperationRow["status"];
  admittedAt: string;
  updatedAt: string;
  ageSeconds: number;
  nextAction: "apply" | "status" | "recover";
};

export type OperationCockpitPage = {
  contractVersion: typeof OPERATION_COCKPIT_CONTRACT_VERSION;
  generatedAt: string;
  operations: OperationCockpitItem[];
  nextCursor?: string;
};

const PLAN_REF_PREFIXES: Readonly<
  Record<z.infer<typeof OperationKindSchema>, string>
> = {
  "obsidian.note.replace": "obsidian-note-replace:v1:",
  "obsidian.frontmatter.patch": "obsidian-frontmatter-patch:v1:",
  "obsidian.base.formula.patch": "obsidian-base-formula-patch:v1:",
  "obsidian.canvas.patch": "obsidian-canvas-patch:v1:",
  "obsidian.text.patch": "obsidian-text-patch:v1:",
};

function invalidCursor(): McpError {
  return new McpError(
    BaseErrorCode.VALIDATION_ERROR,
    "The pending-operation cursor is invalid or belongs to another contract version.",
    { reason: "operation_cockpit_cursor_invalid" },
  );
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw invalidCursor();
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    const result = CursorSchema.safeParse(parsed);
    if (!result.success) throw invalidCursor();
    return result.data;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw invalidCursor();
  }
}

function encodeCursor(row: PendingOperationRow): string {
  const operationKind = OperationKindSchema.parse(row.operationKind);
  return Buffer.from(
    JSON.stringify({
      contractVersion: OPERATION_COCKPIT_CONTRACT_VERSION,
      updatedAt: row.updatedAt,
      operationKind,
      operationId: row.operationId,
    } satisfies Cursor),
    "utf8",
  ).toString("base64url");
}

function compareRows(left: PendingOperationRow, right: PendingOperationRow) {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.operationKind.localeCompare(right.operationKind) ||
    left.operationId.localeCompare(right.operationId)
  );
}

function nextAction(
  status: PendingOperationRow["status"],
): OperationCockpitItem["nextAction"] {
  if (status === "planned") return "apply";
  if (status === "applying") return "status";
  return "recover";
}

function publicItem(
  row: PendingOperationRow,
  now: number,
): OperationCockpitItem {
  const parsed = PendingRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "The pending-operation journal contains an invalid public projection.",
      { reason: "operation_cockpit_projection_invalid" },
    );
  }
  const value = parsed.data;
  const admittedAt = Date.parse(value.createdAt);
  const ageSeconds = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.floor((now - admittedAt) / 1000)),
  );
  return {
    operationKind: value.operationKind,
    planRef: `${PLAN_REF_PREFIXES[value.operationKind]}${value.operationId}`,
    state: value.status,
    admittedAt: value.createdAt,
    updatedAt: value.updatedAt,
    ageSeconds,
    nextAction: nextAction(value.status),
  };
}

export class OperationCockpit {
  constructor(
    private readonly sources: readonly PendingOperationSource[],
    private readonly now: () => number = Date.now,
  ) {}

  list(input: { limit?: number; cursor?: string } = {}): OperationCockpitPage {
    const limit = input.limit ?? OPERATION_COCKPIT_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > OPERATION_COCKPIT_MAX_LIMIT
    ) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `limit must be an integer from 1 to ${OPERATION_COCKPIT_MAX_LIMIT}.`,
        { reason: "operation_cockpit_limit_invalid" },
      );
    }
    const cursor = decodeCursor(input.cursor);
    const after = cursor
      ? {
          updatedAt: cursor.updatedAt,
          operationKind: cursor.operationKind,
          operationId: cursor.operationId,
        }
      : undefined;
    const pages = this.sources.map((source) =>
      source.listPendingOperationRows({ limit, after }),
    );
    const rows = pages.flatMap((page) => page.rows).sort(compareRows);
    const visible = rows.slice(0, limit);
    const hasMore = rows.length > limit || pages.some((page) => page.hasMore);
    const generatedAt = new Date(this.now()).toISOString();
    return {
      contractVersion: OPERATION_COCKPIT_CONTRACT_VERSION,
      generatedAt,
      operations: visible.map((row) =>
        publicItem(row, Date.parse(generatedAt)),
      ),
      ...(hasMore && visible.length > 0
        ? { nextCursor: encodeCursor(visible.at(-1)!) }
        : {}),
    };
  }
}
