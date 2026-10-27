// Frozen response schemas from MCP v3.12.0/v3.14.0; test-only imports.
import { z } from "zod/v3";
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const LegacyRead = z.object({ dateManagement: z.object({ managed: z.boolean(), reason: z.string().optional() }).optional(),
  ok: z.literal(true), contractVersion: z.literal(1), path: z.string().min(1),
  content: z.string(), sha256: Hash, size: z.number().int().nonnegative(), bindingFingerprint: Hash,
  completion: z.object({ contractVersion: z.literal(1), kind: z.literal("fdm-completion-v1"), token: z.string().uuid(),
    epoch: z.string().uuid(), generation: z.number().int().nonnegative(), state: z.enum(["complete", "pending"]) })
    .refine(value => value.state !== "complete" || value.generation > 0).optional(),
}).passthrough();
export const LegacyCas = z.object({ ok: z.literal(true), contractVersion: z.literal(1), path: z.string().min(1),
  beforeSha256: Hash, afterSha256: Hash, size: z.number().int().nonnegative(), bindingFingerprint: Hash,
  completionToken: z.string().uuid().optional() }).passthrough();
export const LegacyCreateInspection = z.object({ contractVersion: z.literal(1), path: z.string().max(1024), bindingFingerprint: Hash,
  policyDigest: Hash.optional(), exists: z.boolean(), content: z.string().max(2 * 1024 * 1024).optional(), sha256: Hash.optional() }).strict();
export const LegacyCreateResult = z.object({ contractVersion: z.literal(1), operationId: z.string().uuid(), path: z.string().max(1024),
  bindingFingerprint: Hash, policyDigest: Hash, contentSha256: Hash,
  outcome: z.enum(["created", "conflict", "outcome_unknown"]), reason: z.string().regex(/^[a-z_]{1,96}$/u) }).strict();
const Ref = z.object({ kind: z.enum(["link", "embed", "frontmatter"]), targetPath: z.string().max(1024).nullable(),
  unresolvedPath: z.string().max(4096).nullable(), subpath: z.string().max(4096),
  anchor: z.enum(["valid:heading", "valid:block", "valid:footnote", "not_requested", "invalid", "unknown"]) }).strict();
export const LegacyMoveSnapshot = z.object({ contractVersion: z.literal(1), bindingFingerprint: Hash,
  sourcePath: z.string().max(1024), destinationPath: z.string().max(1024), updateLinks: z.boolean(),
  notes: z.array(z.object({ path: z.string().max(1024), sha256: Hash, references: z.array(Ref).max(200),
    backlinks: z.array(z.object({ sourcePath: z.string().max(1024), count: z.number().int().positive().safe() }).strict()).max(200),
    unresolved: z.array(z.object({ linkText: z.string().max(4096), count: z.number().int().positive().safe() }).strict()).max(200),
  }).strict()).min(1).max(17), preconditionDigest: Hash, expectedGraphDigest: Hash }).strict();
export const LegacyMoveObservation = z.object({ contractVersion: z.literal(1), operationId: z.string().uuid(), bindingFingerprint: Hash,
  preconditionDigest: Hash, outcome: z.enum(["committed", "conflict", "rejected", "outcome_unknown"]),
  reason: z.string().regex(/^[a-z_]{1,96}$/u), afterSha256: Hash.optional(),
  graphPostflight: z.enum(["pending", "verified", "failed", "indeterminate"]), observedGraphDigest: Hash.optional(),
  scope: z.literal("sealed_neighborhood_only"), replayAllowed: z.literal(false) }).strict();
