/**
 * Leaf contract of the Bases engine check, shared by the REST client, the
 * governed Base plans, the read tools and the public error boundary. It has no
 * runtime imports besides zod so the error boundary can depend on it safely.
 */

import { z } from "zod/v3";

export const BASE_FORMULA_STATUSES = [
  "ok",
  "syntax_error",
  "runtime_error",
  "all_null",
  "not_evaluated",
] as const;
export type BaseFormulaStatus = (typeof BASE_FORMULA_STATUSES)[number];

export const BASE_FUNCTION_TYPES = [
  "Global",
  "Value",
  "Null",
  "String",
  "Number",
  "List",
  "Object",
  "RegExp",
  "Date",
  "File",
  "Link",
  "Tag",
] as const;
export type BaseFunctionType = (typeof BASE_FUNCTION_TYPES)[number];

/** Reasons reported by the Bridge itself plus the client-side failures. */
export const BASE_ENGINE_UNAVAILABLE_REASONS = [
  "engine_unavailable",
  "canary_failed",
  "unsupported_obsidian",
  "base_not_found",
  "invalid_yaml",
  "bridge_route_missing",
  "engine_request_failed",
  "engine_response_invalid",
  "engine_not_configured",
] as const;
export type BaseEngineUnavailableReason =
  (typeof BASE_ENGINE_UNAVAILABLE_REASONS)[number];

export const BASES_FUNCTIONS_DOC_URL = "https://help.obsidian.md/bases/functions";
export const BASES_SYNTAX_DOC_URL = "https://help.obsidian.md/bases/syntax";
export const BASE_FORMULA_ENGINE_REFUSAL = "base_formula_engine_error";

export const MAX_REFUSED_FORMULAS = 8;
export const MAX_UNKNOWN_FUNCTIONS = 8;
export const MAX_FUNCTION_SUGGESTIONS = 3;
export const MAX_VALID_FUNCTIONS = 80;
export const MAX_ENGINE_WARNINGS = 16;
export const FUNCTION_IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u;

const WarningSchema = z
  .object({
    formula: z.string().min(1).max(256),
    status: z.enum(["all_null", "not_evaluated"]),
  })
  .strict();

/** Stored with the sealed plan, so a replayed plan reports the same check. */
export const BaseEngineCheckSchema = z.union([
  z
    .object({
      status: z.literal("verified"),
      obsidianVersion: z.string().min(1).max(64),
      warnings: z.array(WarningSchema).max(MAX_ENGINE_WARNINGS).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unverified"),
      reason: z.enum(BASE_ENGINE_UNAVAILABLE_REASONS),
    })
    .strict(),
]);
export type BaseEngineCheck = z.infer<typeof BaseEngineCheckSchema>;

const FunctionName = z.string().regex(FUNCTION_IDENTIFIER);
const FunctionScope = z.enum([...BASE_FUNCTION_TYPES, "any"]);

/** Public refusal detail; the error boundary releases only this exact shape. */
const PublicFormulaCheckSchema = z
  .object({
    obsidianVersion: z.string().min(1).max(64),
    docs: z.tuple([z.literal(BASES_FUNCTIONS_DOC_URL), z.literal(BASES_SYNTAX_DOC_URL)]),
    functionsChecked: z.boolean(),
    formulas: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            status: z.enum(["syntax_error", "runtime_error"]),
            previousStatus: z.enum([...BASE_FORMULA_STATUSES, "absent"]),
            errorRows: z.number().int().nonnegative().optional(),
            rows: z.number().int().nonnegative().optional(),
            messages: z.array(z.string().min(1).max(300)).max(3),
            unknownFunctions: z
              .array(
                z
                  .object({
                    name: FunctionName,
                    on: FunctionScope,
                    definedOn: z.array(z.enum(BASE_FUNCTION_TYPES)).max(BASE_FUNCTION_TYPES.length),
                  })
                  .strict(),
              )
              .max(MAX_UNKNOWN_FUNCTIONS),
            validFunctions: z
              .object({
                on: z.enum(BASE_FUNCTION_TYPES),
                names: z.array(FunctionName).max(MAX_VALID_FUNCTIONS),
              })
              .strict()
              .optional(),
            suggestions: z.array(FunctionName).max(MAX_FUNCTION_SUGGESTIONS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_REFUSED_FORMULAS),
  })
  .strict();
export type PublicFormulaCheck = z.infer<typeof PublicFormulaCheckSchema>;

export function isPublicFormulaCheck(value: unknown): value is PublicFormulaCheck {
  return PublicFormulaCheckSchema.safeParse(value).success;
}

