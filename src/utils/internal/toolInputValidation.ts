import { z } from "zod/v3";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";

export type PublicToolInputIssue = Readonly<{ path: string; message: string }>;
export type PublicToolInputIssues = readonly PublicToolInputIssue[];

// Only frozen diagnostics constructed from an input schema may cross the
// public boundary. An arbitrary McpError (or Bridge response) cannot forge them.
const publicIssues = new WeakSet<object>();

export function isPublicToolInputIssues(
  value: unknown,
): value is PublicToolInputIssues {
  return typeof value === "object" && value !== null && publicIssues.has(value);
}

function inputBranches(schema: z.ZodTypeAny): z.ZodTypeAny[] {
  if (schema instanceof z.ZodEffects) return inputBranches(schema.innerType());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return inputBranches(schema.unwrap());
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodCatch)
    return inputBranches(schema._def.innerType);
  if (schema instanceof z.ZodPipeline) return inputBranches(schema._def.in);
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion)
    return schema.options.flatMap(inputBranches);
  return [schema];
}

function publicIssuePath(
  schema: z.ZodTypeAny,
  path: (string | number)[],
): string {
  let branches = inputBranches(schema);
  return path
    .slice(0, 32)
    .map((segment) => {
      let declared = branches.length > 0;
      const next: z.ZodTypeAny[] = [];
      for (const branch of branches) {
        if (
          branch instanceof z.ZodObject &&
          typeof segment === "string" &&
          Object.hasOwn(branch.shape, segment)
        ) {
          next.push(branch.shape[segment]);
        } else {
          declared = false;
          if (branch instanceof z.ZodRecord) next.push(branch.valueSchema);
          if (branch instanceof z.ZodArray && typeof segment === "number")
            next.push(branch.element);
        }
      }
      branches = next.flatMap(inputBranches);
      // Record keys, array indexes and unknown paths are all caller-controlled.
      return declared ? String(segment) : "*";
    })
    .join(".");
}

/** Map input validation only; Zod errors parsing upstream responses stay internal. */
export function parseToolInput<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  authorMessages: ReadonlySet<string>,
): z.output<S> {
  try {
    return schema.parse(input);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const issues: PublicToolInputIssues = Object.freeze(
      error.issues.slice(0, 20).map((issue) =>
        Object.freeze({
          path: publicIssuePath(schema, issue.path),
          // Zod's default messages can echo enum values and unknown keys. Even
          // custom refinements may interpolate caller content: require a closed
          // author-written message, never copy arbitrary ZodError.message.
          message: authorMessages.has(issue.message)
            ? issue.message
            : "Invalid value for this field.",
        }),
      ),
    );
    publicIssues.add(issues);
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "Invalid tool arguments.",
      {
        reasonCode: "invalid_tool_arguments",
        validationIssues: issues,
      },
    );
  }
}
