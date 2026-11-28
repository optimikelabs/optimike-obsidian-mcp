import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import { resolveExternalSemanticGeneration, type ExternalSemanticGeneration } from "./externalSemanticGeneration.js";

const count = z.number().int().nonnegative().safe();
const generationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const errorCode = z.enum(["scan_failed", "embedding_busy", "embedding_failed", "build_failed", "source_drift", "deletion_guard"]);
const maintenanceWarning = z.enum(["retirements_rebuilt", "retirements_recovery_blocked", "generation_prune_blocked"]);
const serviceStatus = z.object({
  version: z.literal(1),
  generation: generationId.nullable(),
  observedAt: count,
  validUntil: count,
  pendingChanges: count.nullable(),
  lastError: errorCode.nullable(),
  maintenanceWarning: maintenanceWarning.nullable().optional(),
});
export const publicSemanticIndexSchema = z.object({
  generation: generationId.nullable(),
  builtAt: z.string().datetime({ precision: 3 }).nullable(),
  pendingChanges: count.nullable(),
  lastError: errorCode.nullable(),
  maintenanceWarning: maintenanceWarning.optional(),
  coverage: z.object({
    indexedNotes: count, indexedSections: count, candidateNotes: count.nullable(),
  }).nullable(),
});

export async function readSemanticIndexObservation(generation?: ExternalSemanticGeneration) {
  const pointer = process.env.SMART_ENV_GENERATION_POINTER;
  if (!pointer || !path.isAbsolute(pointer)) return;
  try {
    const directory = generation ? path.dirname(path.dirname(generation.directory)) : await realpath(path.dirname(pointer));
    const filename = path.join(directory, "SERVICE.json");
    const buffer = Buffer.alloc(4097);
    const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    let bytesRead;
    try {
      if (!(await file.stat()).isFile()) return;
      ({ bytesRead } = await file.read(buffer, 0, buffer.length, 0));
    } finally {
      await file.close();
    }
    if (bytesRead >= buffer.length) return;
    const status = serviceStatus.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
    const now = Date.now();
    if (status.generation === (generation?.id ?? null) &&
        status.observedAt <= now && status.validUntil >= status.observedAt &&
        status.validUntil - status.observedAt <= 900_000) {
      const valid = status.validUntil >= now && status.validUntil > status.observedAt;
      return {
        pendingChanges: valid ? status.pendingChanges : null,
        lastError: valid ? status.lastError : null,
        maintenanceWarning: valid ? status.maintenanceWarning ?? undefined : undefined,
      };
    }
  } catch {
    // A service file is optional. A bad observation cannot invalidate CURRENT.
  }
}

export function semanticIndexBuiltAt(generation: ExternalSemanticGeneration): string | null {
  return generation.manifest.builtAt ?? generation.manifest.createdAt ?? null;
}

export async function collectSemanticIndexStatus(generation?: ExternalSemanticGeneration):
  Promise<z.infer<typeof publicSemanticIndexSchema>> {
  const observation = await readSemanticIndexObservation(generation);
  const manifest = generation?.manifest;
  return {
    generation: generation?.id ?? null,
    builtAt: generation ? semanticIndexBuiltAt(generation) : null,
    pendingChanges: observation?.pendingChanges ?? null,
    lastError: observation?.lastError ?? null,
    ...(observation?.maintenanceWarning && { maintenanceWarning: observation.maintenanceWarning }),
    coverage: manifest ? {
      indexedNotes: manifest.vectors.notes.count,
      indexedSections: manifest.vectors.sections.count,
      candidateNotes: manifest.coverage?.candidateNotes ?? null,
    } : null,
  };
}

export async function readSemanticIndexStatus() {
  return collectSemanticIndexStatus(await resolveExternalSemanticGeneration().catch(() => undefined));
}
