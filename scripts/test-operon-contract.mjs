import assert from "node:assert/strict";
import {
  OPERON_CONTRACT_VERSION,
  OperonBridgePageSchema,
  OperonQuerySchema,
  OperonStatusSchema,
  OperonTaskSchema,
  queryOperonSnapshot,
} from "../dist/services/operon/contract.js";

const capabilities = {
  status: true,
  list: true,
  get: true,
  query: true,
  validate: true,
  create: false,
  update: false,
  transition: false,
  convert: false,
};

const task = OperonTaskSchema.parse({
  operonId: "abc1234",
  source: "inline",
  path: "Efforts/Projets/Bridge.md",
  line: 7,
  sourceMtime: 1000,
  description: "Ship Operon Bridge",
  checkbox: "open",
  status: "Project.InProgress",
  statusLabel: "InProgress",
  pipeline: "Project",
  priority: "A",
  tier: "hot",
  tags: ["elysia", "bridge"],
  parentTask: null,
  blocking: [],
  blockedBy: [],
  dates: {
    due: "2026-07-31",
    scheduled: "2026-07-20",
    started: null,
    completed: null,
    cancelled: null,
    datetimeStart: null,
    datetimeEnd: null,
    created: "2026-07-20T10:00:00",
    modified: "2026-07-20T11:00:00",
  },
  fields: {
    status: "Project.InProgress",
    priority: "A",
    custom: "signal",
  },
  properties: { rang: 4, north_star: true },
  revision: "fnv1a32:deadbeef",
  sourceKind: "operon-index",
  operonVersion: "2.4.0",
  bridgeVersion: "0.1.0",
});

const status = OperonStatusSchema.parse({
  ok: true,
  contractVersion: OPERON_CONTRACT_VERSION,
  bridge: { id: "optimike-operon-bridge", version: "0.1.0", mode: "read-only" },
  operon: {
    present: true,
    version: "2.4.0",
    compatible: true,
    testedAgainst: "2.4.0",
    supportedRange: ">=2.4.0 <3.0.0",
  },
  index: { ready: true, generation: 42, taskCount: 1, duplicateConflictCount: 0 },
  settingsSignature: "fnv1a32:01234567",
  capabilities,
  source: "operon-runtime",
  stale: false,
  limitations: ["read-only"],
});
assert.equal(status.index.generation, 42);

const bridgePage = OperonBridgePageSchema.parse({
  ok: true,
  contractVersion: OPERON_CONTRACT_VERSION,
  source: "operon-live",
  stale: false,
  total: 1,
  count: 1,
  cursor: "0",
  hasMore: false,
  tasks: [task],
  limitations: ["read-only"],
});
assert.equal(bridgePage.tasks[0].operonId, "abc1234");

const query = OperonQuerySchema.parse({
  pathIncludes: ["Efforts/Projets"],
  tagsAll: ["elysia"],
  fieldEquals: { custom: "signal" },
  propertyEquals: { north_star: true },
  dates: [{ field: "due", before: "2026-08-01" }],
  includeProperties: true,
  limit: 10,
});

const page = queryOperonSnapshot(
  {
    source: "operon-live",
    stale: false,
    snapshotAt: "2026-07-20T12:00:00.000Z",
    snapshotAgeMs: 0,
    operonVersion: "2.4.0",
    bridgeVersion: "0.1.0",
    contractVersion: OPERON_CONTRACT_VERSION,
    settingsSignature: "fnv1a32:01234567",
    generation: 42,
    capabilities,
    limitations: ["read-only"],
    tasks: [task],
  },
  query,
);
assert.equal(page.total, 1);
assert.equal(page.tasks[0].properties?.north_star, true);

const stripped = queryOperonSnapshot(
  {
    source: "operon-cache",
    stale: true,
    snapshotAt: "2026-07-20T12:00:00.000Z",
    snapshotAgeMs: 5000,
    operonVersion: "2.4.0",
    bridgeVersion: "0.1.0",
    contractVersion: OPERON_CONTRACT_VERSION,
    settingsSignature: "fnv1a32:01234567",
    generation: 42,
    capabilities,
    limitations: ["stale"],
    tasks: [task],
  },
  { search: "ship", includeProperties: false, limit: 10 },
);
assert.equal(stripped.source, "operon-cache");
assert.equal(stripped.stale, true);
assert.equal("properties" in stripped.tasks[0], false);

console.log("PASS: Operon MCP contract schemas, filtering, property gating, and freshness envelope");
