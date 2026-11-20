/**
 * @module BasesEngineMethods
 * @description
 * Client for the Bases Bridge engine routes: formula evaluation by Obsidian's
 * own Bases engine and the Bases function registry of the installed Obsidian.
 *
 * The engine is optional. Obsidian may be closed, the Bridge may predate these
 * routes (HTTP 404) or its canary may fail. Every such case is returned as
 * `{ available: false, reason }`, never thrown and never reported as a pass:
 * callers must say "unverified" rather than "ok".
 */

import { z } from "zod/v3";
import { McpError, BaseErrorCode } from "../../../types-global/errors.js";
import { RequestContext } from "../../../utils/index.js";
import { RequestFunction } from "../types.js";

const ENGINE_PREFIX = "/extensions/obsidian-bases-bridge/engine";
const ENGINE_TIMEOUT_MS = 20_000;
const MAX_SAMPLES = 3;
const MAX_MESSAGE_CHARS = 300;

import {
  BASE_ENGINE_UNAVAILABLE_REASONS,
  BASE_FORMULA_STATUSES,
  BASE_FUNCTION_TYPES,
  type BaseEngineUnavailableReason,
  type BaseFormulaStatus,
  type BaseFunctionType,
} from "../../basesEngineContract.js";

export type { BaseEngineUnavailableReason, BaseFormulaStatus, BaseFunctionType };

export type BaseEngineUnavailable = {
  available: false;
  reason: BaseEngineUnavailableReason;
};

export type BaseFormulaEvaluation = {
  status: BaseFormulaStatus;
  rows?: number;
  errorRows?: number;
  nullRows?: number;
  samples: Array<{ path?: string; message: string }>;
};

export type BaseEngineEvaluation =
  | {
      available: true;
      obsidianVersion: string;
      formulas: Record<string, BaseFormulaEvaluation>;
    }
  | BaseEngineUnavailable;

export type BaseFunctionParam = {
  name: string;
  types: string[];
  optional: boolean;
  variadic: boolean;
};

export type BaseFunctionDescriptor = {
  name: string;
  on: BaseFunctionType;
  params: BaseFunctionParam[];
  doc?: string;
};

export type BaseFunctionRegistry =
  | {
      available: true;
      obsidianVersion: string;
      functions: BaseFunctionDescriptor[];
    }
  | BaseEngineUnavailable;

const Count = z.number().int().nonnegative().optional();
const Name = z.string().min(1).max(256);

const EvaluateResponse = z.union([
  z.object({
    available: z.literal(true),
    obsidianVersion: z.string().min(1).max(64),
    canary: z.object({ ok: z.boolean() }).passthrough().optional(),
    formulas: z.record(
      Name,
      z
        .object({
          status: z.enum(BASE_FORMULA_STATUSES),
          rows: Count,
          errorRows: Count,
          nullRows: Count,
          samples: z
            .array(
              z
                .object({
                  path: z.string().max(1024).optional(),
                  message: z.string().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  }).passthrough(),
  z.object({ available: z.literal(false), reason: z.string().optional() }).passthrough(),
]);

const FunctionDescriptor = z
  .object({
    name: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/u),
    on: z.enum(BASE_FUNCTION_TYPES),
    params: z
      .array(
        z
          .object({
            name: z.string().max(64),
            types: z.array(z.string().max(64)).max(16).optional(),
            optional: z.boolean().optional(),
            variadic: z.boolean().optional(),
          })
          .passthrough(),
      )
      .max(32)
      .optional(),
    // The Bridge sends null for a function without a description.
    doc: z.string().nullable().optional(),
  })
  .passthrough();

// Entries are validated one by one so that a type added by a newer Obsidian
// drops that entry instead of the whole registry.
const FunctionsResponse = z.union([
  z.object({
    available: z.literal(true),
    obsidianVersion: z.string().min(1).max(64),
    functions: z.array(z.unknown()).max(5_000),
  }).passthrough(),
  z.object({ available: z.literal(false), reason: z.string().optional() }).passthrough(),
]);

function unavailable(reason: unknown): BaseEngineUnavailable {
  return {
    available: false,
    reason: (BASE_ENGINE_UNAVAILABLE_REASONS as readonly unknown[]).includes(reason)
      ? (reason as BaseEngineUnavailableReason)
      : "engine_unavailable",
  };
}

/** Engine text is bounded and stripped of control characters before use. */
export function boundEngineText(value: string, max = MAX_MESSAGE_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function requestFailure(error: unknown): BaseEngineUnavailable {
  // An older Bridge does not mount the engine routes.
  if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
    return unavailable("bridge_route_missing");
  }
  return unavailable("engine_request_failed");
}

/**
 * Evaluates the formulas of one Base with Obsidian's engine. `yaml` omitted
 * evaluates the file as stored; a `yaml` candidate is evaluated in memory.
 */
export async function evaluateBaseEngine(
  _request: RequestFunction,
  payload: { path: string; yaml?: string; formulas?: string[] },
  context: RequestContext,
): Promise<BaseEngineEvaluation> {
  let raw: unknown;
  try {
    raw = await _request<unknown>(
      {
        method: "POST",
        url: `${ENGINE_PREFIX}/evaluate`,
        headers: { "Content-Type": "application/json" },
        data: payload,
        timeout: ENGINE_TIMEOUT_MS,
      },
      context,
      "evaluateBaseEngine",
    );
  } catch (error) {
    return requestFailure(error);
  }
  const parsed = EvaluateResponse.safeParse(raw);
  if (!parsed.success) return unavailable("engine_response_invalid");
  const data = parsed.data;
  if (data.available === false) return unavailable(data.reason);
  // A failed canary means the engine answers but cannot be trusted.
  if (!data.canary || data.canary.ok !== true) return unavailable("canary_failed");
  const formulas: Record<string, BaseFormulaEvaluation> = {};
  for (const [name, value] of Object.entries(data.formulas)) {
    formulas[name] = {
      status: value.status,
      ...(value.rows === undefined ? {} : { rows: value.rows }),
      ...(value.errorRows === undefined ? {} : { errorRows: value.errorRows }),
      ...(value.nullRows === undefined ? {} : { nullRows: value.nullRows }),
      samples: (value.samples ?? [])
        .flatMap((sample) => {
          const message = typeof sample.message === "string" ? boundEngineText(sample.message) : "";
          return message ? [{ ...(sample.path ? { path: sample.path } : {}), message }] : [];
        })
        .slice(0, MAX_SAMPLES),
    };
  }
  return { available: true, obsidianVersion: data.obsidianVersion, formulas };
}

/** Reads the Bases function registry, optionally for one receiver type. */
export async function listBaseEngineFunctions(
  _request: RequestFunction,
  on: BaseFunctionType | undefined,
  context: RequestContext,
): Promise<BaseFunctionRegistry> {
  let raw: unknown;
  try {
    raw = await _request<unknown>(
      {
        method: "GET",
        url: `${ENGINE_PREFIX}/functions${on ? `?on=${encodeURIComponent(on)}` : ""}`,
        timeout: ENGINE_TIMEOUT_MS,
      },
      context,
      "listBaseEngineFunctions",
    );
  } catch (error) {
    return requestFailure(error);
  }
  const parsed = FunctionsResponse.safeParse(raw);
  if (!parsed.success) return unavailable("engine_response_invalid");
  const data = parsed.data;
  if (data.available === false) return unavailable(data.reason);
  const valid = data.functions.flatMap((entry) => {
    const fn = FunctionDescriptor.safeParse(entry);
    return fn.success ? [fn.data] : [];
  });
  // A registry whose every entry is unusable would make every call look
  // unknown; it is a broken answer, not an empty registry.
  if (data.functions.length > 0 && valid.length === 0) {
    return unavailable("engine_response_invalid");
  }
  return {
    available: true,
    obsidianVersion: data.obsidianVersion,
    functions: valid
      .filter((fn) => !on || fn.on === on)
      .map((fn) => ({
        name: fn.name,
        on: fn.on,
        params: (fn.params ?? []).map((param) => ({
          name: param.name,
          types: param.types ?? [],
          optional: param.optional === true,
          variadic: param.variadic === true,
        })),
        ...(fn.doc ? { doc: boundEngineText(fn.doc, 500) } : {}),
      })),
  };
}
