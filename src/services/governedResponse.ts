import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { z } from "zod";

export const GovernedResponseFields = {
  responseMode: z
    .enum(["compact", "detailed"])
    .optional()
    .describe(
      "Default detailed for compatibility. compact preserves state, postflight/checkAfter, permissions and proof digests; retrieve full evidence with the matching status tool and responseMode=detailed.",
    ),
  diagnostics: z
    .boolean()
    .optional()
    .describe(
      "Opt-in per-call server timings in milliseconds. Excludes client transport and does not change the sealed intent or journal.",
    ),
};
const timings = new AsyncLocalStorage<Record<string, number>>();
export async function measureGovernedPhase<T>(
  phase:
    | "bridgeStatus"
    | "noteRead"
    | "preDispatchRead"
    | "atomicCas"
    | "cacheRefresh",
  work: () => Promise<T>,
): Promise<T> {
  const current = timings.getStore();
  if (!current) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    current[phase] = (current[phase] ?? 0) + performance.now() - started;
  }
}
function compactReceipt(value: unknown, toolName: string): unknown {
  if (!value || typeof value !== "object") return value;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.planRef !== "string" ||
    typeof receipt.planDigest !== "string"
  )
    return value;
  const result: Record<string, unknown> = { responseMode: "compact" };
  for (const key of [
    "contractVersion",
    "operationId",
    "operationKind",
    "planRef",
    "planDigest",
    "phase",
    "outcome",
    "idempotencyKey",
    "target",
    "postflight",
    "applyAllowed",
    "recoveryAllowed",
    "recoveryRef",
  ]) {
    if (receipt[key] !== undefined) result[key] = receipt[key];
  }
  for (const key of ["beforeProof", "afterProof"]) {
    const proof = receipt[key] as { kind: string; digest: string } | undefined;
    if (proof) result[key] = { kind: proof.kind, digest: proof.digest };
  }
  const projection = receipt.projection as Record<string, unknown> | undefined;
  if (projection)
    result.projection = {
      kind: projection.kind,
      sourcePreservation: projection.sourcePreservation,
    };
  result.detailedReceipt = {
    tool: toolName.replace(/_(plan|apply|status|recover)$/u, "_status"),
    arguments: { planRef: receipt.planRef, responseMode: "detailed" },
  };
  return result;
}
export async function governedResponse(
  toolName: string,
  params: unknown,
  work: () => Promise<unknown>,
): Promise<unknown> {
  const options =
    params && typeof params === "object"
      ? (params as { responseMode?: string; diagnostics?: boolean })
      : {};
  const phases: Record<string, number> = {};
  const started = performance.now();
  const value = options.diagnostics
    ? await timings.run(phases, work)
    : await work();
  const result =
    options.responseMode === "compact"
      ? compactReceipt(value, toolName)
      : value;
  if (!options.diagnostics || !result || typeof result !== "object")
    return result;
  return {
    ...result,
    diagnostics: {
      scope: "current-server-call",
      totalMs: Math.round((performance.now() - started) * 1000) / 1000,
      phasesMs: Object.fromEntries(
        Object.entries(phases).map(([key, value]) => [
          key,
          Math.round(value * 1000) / 1000,
        ]),
      ),
    },
  };
}
