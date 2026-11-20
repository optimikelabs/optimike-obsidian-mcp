/**
 * Plan-time check of Base formulas by Obsidian's own Bases engine.
 *
 * Governed Base plans evaluate the stored Base and the compiled candidate with
 * the Bases Bridge engine route before sealing. A formula that the candidate
 * turns into a syntax or runtime error is refused with a bounded diagnosis;
 * errors already present in the stored Base do not block. When the engine is
 * unavailable the plan proceeds and says "unverified": it is never reported as
 * verified without a successful evaluation of both versions.
 */

import { parse } from "yaml";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { requestContextService } from "../utils/index.js";
import {
  BASE_FORMULA_ENGINE_REFUSAL,
  BASE_FUNCTION_TYPES,
  BASES_FUNCTIONS_DOC_URL,
  BASES_SYNTAX_DOC_URL,
  FUNCTION_IDENTIFIER,
  MAX_ENGINE_WARNINGS,
  MAX_FUNCTION_SUGGESTIONS,
  MAX_REFUSED_FORMULAS,
  MAX_UNKNOWN_FUNCTIONS,
  MAX_VALID_FUNCTIONS,
  type BaseEngineCheck,
  type BaseEngineUnavailableReason,
  type BaseFormulaStatus,
  type BaseFunctionType,
  type PublicFormulaCheck,
} from "./basesEngineContract.js";
import type {
  BaseEngineEvaluation,
  BaseFunctionDescriptor,
  BaseFunctionRegistry,
} from "./obsidianRestAPI/methods/basesEngineMethods.js";
import type { ObsidianRestApiService } from "./obsidianRestAPI/service.js";

/** The subset of the REST client the check needs; tests may replay it. */
export interface BaseEngine {
  evaluate(payload: { path: string; yaml?: string }): Promise<BaseEngineEvaluation>;
  functions(on?: BaseFunctionType): Promise<BaseFunctionRegistry>;
}

export function restBaseEngine(service: ObsidianRestApiService): BaseEngine {
  const context = () =>
    requestContextService.createRequestContext({ operation: "BaseEngineCheck" });
  return {
    evaluate: (payload) => service.evaluateBaseEngine(payload, context()),
    functions: (on) => service.listBaseEngineFunctions(on, context()),
  };
}

/** Known receiver types of `file.*` properties; anything else stays unknown. */
const FILE_PROPERTY_TYPES: Record<string, BaseFunctionType> = {
  name: "String",
  basename: "String",
  path: "String",
  folder: "String",
  ext: "String",
  size: "Number",
  ctime: "Date",
  mtime: "Date",
  tags: "List",
  links: "List",
  backlinks: "List",
  embeds: "List",
  properties: "Object",
  file: "File",
};

type FunctionCall = { name: string; receiver?: BaseFunctionType | "any" };

/** Blanks string literal contents so calls inside quoted text are ignored. */
function withoutStringContents(expression: string): string {
  return expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, (match) => `${match[0]}${match[0]}`);
}

function receiverType(before: string): BaseFunctionType | "any" {
  const text = before.trimEnd();
  if (/["']$/u.test(text)) return "String";
  if (/(?:^|[^\w$.])\d+(?:\.\d+)?$/u.test(text)) return "Number";
  if (/(?:^|[^\w$.])(?:now|today)\(\s*\)$/u.test(text)) return "Date";
  const property = /(?:^|[^\w$.])file\.([A-Za-z_$][\w$]*)$/u.exec(text);
  if (property) return FILE_PROPERTY_TYPES[property[1]!] ?? "any";
  if (/(?:^|[^\w$.])file$/u.test(text)) return "File";
  return "any";
}

/** Extracts `name(` global calls and `.name(` method calls from a formula. */
export function formulaFunctionCalls(expression: string): FunctionCall[] {
  const text = withoutStringContents(expression);
  const calls: FunctionCall[] = [];
  const seen = new Set<string>();
  const pattern = /(\.\s*)?([A-Za-z_$][\w$]*)\s*\(/gu;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    if (!match[1] && start > 0 && /[\w$]/u.test(text[start - 1]!)) continue;
    const name = match[2]!;
    if (!FUNCTION_IDENTIFIER.test(name)) continue;
    const call: FunctionCall = match[1]
      ? { name, receiver: receiverType(text.slice(0, start)) }
      : { name };
    const key = `${call.receiver ?? "Global"}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(call);
  }
  return calls;
}

function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Up to three registry names close to an unknown name, nearest first. */
export function suggestFunctionNames(name: string, candidates: Iterable<string>): string[] {
  const limit = Math.max(2, Math.ceil(name.length / 2));
  return [...new Set(candidates)]
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter((entry) => entry.distance > 0 && entry.distance <= limit)
    .sort((x, y) => x.distance - y.distance || x.candidate.localeCompare(y.candidate))
    .slice(0, MAX_FUNCTION_SUGGESTIONS)
    .map((entry) => entry.candidate);
}

type Registry = Map<BaseFunctionType, Set<string>>;

function registryByType(functions: BaseFunctionDescriptor[]): Registry {
  const registry: Registry = new Map();
  for (const fn of functions) {
    if (!registry.has(fn.on)) registry.set(fn.on, new Set());
    registry.get(fn.on)!.add(fn.name);
  }
  return registry;
}

/** Functions callable on a receiver type: its own plus the generic Value ones. */
function namesFor(registry: Registry, on: BaseFunctionType): Set<string> {
  if (on === "Global") return new Set(registry.get("Global") ?? []);
  return new Set([...(registry.get(on) ?? []), ...(registry.get("Value") ?? [])]);
}

function methodTypesDefining(registry: Registry, name: string): BaseFunctionType[] {
  return BASE_FUNCTION_TYPES.filter(
    (type) => type !== "Global" && registry.get(type)?.has(name),
  );
}

export function diagnoseFunctions(expression: string, functions: BaseFunctionDescriptor[]) {
  const registry = registryByType(functions);
  const unknownFunctions: PublicFormulaCheck["formulas"][number]["unknownFunctions"] = [];
  for (const call of formulaFunctionCalls(expression)) {
    if (!call.receiver) {
      if (!registry.get("Global")?.has(call.name)) {
        unknownFunctions.push({ name: call.name, on: "Global", definedOn: methodTypesDefining(registry, call.name) });
      }
      continue;
    }
    const definedOn = methodTypesDefining(registry, call.name);
    if (call.receiver === "any") {
      if (definedOn.length === 0) unknownFunctions.push({ name: call.name, on: "any", definedOn });
    } else if (!namesFor(registry, call.receiver).has(call.name)) {
      unknownFunctions.push({ name: call.name, on: call.receiver, definedOn });
    }
  }
  const first = unknownFunctions[0];
  const scope: BaseFunctionType | undefined =
    first && first.on !== "any" ? first.on : undefined;
  const valid = scope ? [...namesFor(registry, scope)].sort() : undefined;
  const pool = valid ?? [...new Set(
    BASE_FUNCTION_TYPES.filter((type) => type !== "Global").flatMap((type) => [...(registry.get(type) ?? [])]),
  )];
  return {
    unknownFunctions: unknownFunctions.slice(0, MAX_UNKNOWN_FUNCTIONS),
    ...(scope && valid ? { validFunctions: { on: scope, names: valid.slice(0, MAX_VALID_FUNCTIONS) } } : {}),
    suggestions: first ? suggestFunctionNames(first.name, pool) : [],
  };
}

/** Formula expressions of a Base, by name, as written in its YAML. */
function formulaExpressions(yaml: string): Map<string, string> {
  const expressions = new Map<string, string>();
  try {
    const document = parse(yaml) as { formulas?: unknown } | null;
    const formulas = document && typeof document === "object" ? document.formulas : undefined;
    if (formulas && typeof formulas === "object" && !Array.isArray(formulas)) {
      for (const [name, value] of Object.entries(formulas)) {
        if (value !== null && value !== undefined) expressions.set(name, String(value));
      }
    }
  } catch {
    // The compilers already validated the candidate; no expressions means no hints.
  }
  return expressions;
}

const ERROR_STATUSES = new Set<BaseFormulaStatus>(["syntax_error", "runtime_error"]);

function unverified(reason: BaseEngineUnavailableReason): BaseEngineCheck {
  return { status: "unverified", reason };
}

/**
 * Evaluates the stored Base and the candidate YAML. Returns the check to seal
 * with the plan, or throws a refusal when the candidate adds a formula error.
 */
export async function checkBaseFormulasBeforeSealing(
  engine: BaseEngine | undefined,
  path: string,
  candidateYaml: string,
): Promise<BaseEngineCheck> {
  if (!engine) return unverified("engine_not_configured");
  const [before, after] = await Promise.all([
    engine.evaluate({ path }),
    engine.evaluate({ path, yaml: candidateYaml }),
  ]);
  if (!after.available) return unverified(after.reason);
  if (!before.available) return unverified(before.reason);

  const introduced = Object.entries(after.formulas).filter(([name, result]) =>
    ERROR_STATUSES.has(result.status) && before.formulas[name]?.status !== result.status,
  );
  if (introduced.length === 0) {
    const warnings = Object.entries(after.formulas)
      .filter(([name, result]) =>
        (result.status === "all_null" || result.status === "not_evaluated") &&
        before.formulas[name]?.status !== result.status &&
        name.length <= 256,
      )
      .slice(0, MAX_ENGINE_WARNINGS)
      .map(([formula, result]) => ({ formula, status: result.status as "all_null" | "not_evaluated" }));
    return {
      status: "verified",
      obsidianVersion: after.obsidianVersion,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const registry = await engine.functions();
  const expressions = formulaExpressions(candidateYaml);
  const formulas = introduced.slice(0, MAX_REFUSED_FORMULAS).map(([name, result]) => {
    const expression = expressions.get(name);
    const hints = registry.available && expression !== undefined
      ? diagnoseFunctions(expression, registry.functions)
      : { unknownFunctions: [], suggestions: [] };
    return {
      name: name.slice(0, 256),
      status: result.status as "syntax_error" | "runtime_error",
      previousStatus: before.formulas[name]?.status ?? ("absent" as const),
      ...(result.errorRows === undefined ? {} : { errorRows: result.errorRows }),
      ...(result.rows === undefined ? {} : { rows: result.rows }),
      messages: [...new Set(result.samples.map((sample) => sample.message))].slice(0, 3),
      ...hints,
    };
  });
  const formulaCheck: PublicFormulaCheck = {
    obsidianVersion: after.obsidianVersion,
    docs: [BASES_FUNCTIONS_DOC_URL, BASES_SYNTAX_DOC_URL],
    functionsChecked: registry.available,
    formulas,
  };
  throw new McpError(
    BaseErrorCode.VALIDATION_ERROR,
    "Obsidian's Bases engine reports that the planned Base would break a formula.",
    { reasonCode: BASE_FORMULA_ENGINE_REFUSAL, formulaCheck },
  );
}
