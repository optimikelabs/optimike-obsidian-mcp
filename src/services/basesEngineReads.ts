/**
 * Read-only reports built on the Bases Bridge engine routes: the function
 * registry of the installed Obsidian and the formula health of Bases.
 * An unavailable engine is reported as "unverified", never as healthy.
 */

import {
  BASE_FORMULA_STATUSES,
  BASES_FUNCTIONS_DOC_URL,
  BASES_SYNTAX_DOC_URL,
  type BaseEngineUnavailableReason,
  type BaseFormulaStatus,
  type BaseFunctionType,
} from "./basesEngineContract.js";
import type { BaseEngine } from "./baseFormulaEngineCheck.js";
import type { BaseFunctionDescriptor } from "./obsidianRestAPI/methods/basesEngineMethods.js";

const DOCS = [BASES_FUNCTIONS_DOC_URL, BASES_SYNTAX_DOC_URL] as const;
export const MAX_CHECKED_BASES = 100;
const CHECK_CONCURRENCY = 4;
const MAX_DOC_CHARS = 200;

/** Reasons that concern one Base; any other reason means the engine is out. */
const PER_BASE_REASONS = new Set<BaseEngineUnavailableReason>(["base_not_found", "invalid_yaml"]);

type Unverified ={ status: "unverified"; reason: BaseEngineUnavailableReason };

function signature(fn: BaseFunctionDescriptor): string {
  const params = fn.params.map((param) => {
    const name = `${param.variadic ? "..." : ""}${param.name}${param.optional ? "?" : ""}`;
    return param.types.length ? `${name}: ${param.types.join(" | ")}` : name;
  });
  return `${fn.name}(${params.join(", ")})`;
}

/** Without `on`: names grouped by type. With `on`: signatures and short docs. */
export async function basesFunctions(engine: BaseEngine, on?: BaseFunctionType) {
  const registry = await engine.functions(on);
  if (!registry.available) {
    return { status: "unverified", reason: registry.reason, docs: DOCS } as const;
  }
  if (on) {
    return {
      obsidianVersion: registry.obsidianVersion,
      on,
      functions: registry.functions.map((fn) => ({
        signature: signature(fn),
        ...(fn.doc ? { doc: fn.doc.length > MAX_DOC_CHARS ? `${fn.doc.slice(0, MAX_DOC_CHARS - 1)}…` : fn.doc } : {}),
      })),
      docs: DOCS,
    };
  }
  const byType: Record<string, string[]> = {};
  for (const fn of registry.functions) (byType[fn.on] ??= []).push(fn.name);
  for (const names of Object.values(byType)) names.sort();
  return {
    obsidianVersion: registry.obsidianVersion,
    functions: byType,
    next: "Pass on=<Type> for parameters and descriptions.",
    docs: DOCS,
  };
}

type FormulaReport = {
  name: string;
  status: BaseFormulaStatus;
  rows?: number;
  errorRows?: number;
  nullRows?: number;
  message?: string;
};

type BaseReport =
  | { path: string; status: "verified"; obsidianVersion: string; formulas: FormulaReport[] }
  | ({ path: string } & Unverified);

async function checkOne(engine: BaseEngine, path: string): Promise<BaseReport> {
  const result = await engine.evaluate({ path });
  if (!result.available) return { path, status: "unverified", reason: result.reason };
  return {
    path,
    status: "verified",
    obsidianVersion: result.obsidianVersion,
    formulas: Object.entries(result.formulas).map(([name, formula]) => ({
      name,
      status: formula.status,
      ...(formula.rows === undefined ? {} : { rows: formula.rows }),
      ...(formula.errorRows ? { errorRows: formula.errorRows } : {}),
      ...(formula.nullRows && formula.status === "all_null" ? { nullRows: formula.nullRows } : {}),
      ...(formula.samples[0] ? { message: formula.samples[0].message } : {}),
    })),
  };
}

function summary(reports: BaseReport[]) {
  const formulas = Object.fromEntries(BASE_FORMULA_STATUSES.map((status) => [status, 0])) as Record<BaseFormulaStatus, number>;
  let unverified = 0;
  for (const report of reports) {
    if (report.status === "unverified") unverified += 1;
    else for (const formula of report.formulas) formulas[formula.status] += 1;
  }
  return { bases: reports.length, unverifiedBases: unverified, formulas };
}

/**
 * Formula health of one Base, or of every Base listed by the Bridge. In the
 * all-Bases report, healthy Bases are summarized and only problems are listed.
 */
export async function basesCheck(
  engine: BaseEngine,
  listBasePaths: () => Promise<string[]>,
  path?: string,
) {
  if (path) {
    const report = await checkOne(engine, path);
    return { ...report, docs: DOCS };
  }
  const all = [...new Set(await listBasePaths())].sort();
  const paths = all.slice(0, MAX_CHECKED_BASES);
  if (paths.length === 0) return { summary: summary([]), problems: [], docs: DOCS };
  // The first answer tells whether the engine itself is reachable; when it is
  // not, every other Base would be unverified for the same reason.
  const first = await checkOne(engine, paths[0]!);
  if (first.status === "unverified" && !PER_BASE_REASONS.has(first.reason)) {
    return { status: "unverified", reason: first.reason, bases: all.length, docs: DOCS } as const;
  }
  const reports: BaseReport[] = new Array(paths.length);
  reports[0] = first;
  let next = 1;
  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, paths.length) }, async () => {
      for (let index = next++; index < paths.length; index = next++) {
        reports[index] = await checkOne(engine, paths[index]!);
      }
    }),
  );
  const problems = reports.flatMap((report): BaseReport[] => {
    if (report.status === "unverified") return [report];
    const broken = report.formulas.filter((formula) => formula.status !== "ok");
    return broken.length ? [{ ...report, formulas: broken }] : [];
  });
  return {
    summary: summary(reports),
    ...(all.length > paths.length ? { truncated: { checked: paths.length, total: all.length } } : {}),
    problems,
    docs: DOCS,
  };
}
