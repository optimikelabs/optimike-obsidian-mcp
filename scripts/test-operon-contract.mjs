import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  OPERON_CONTRACT_VERSION,
  OperonAdoptTaskSchema,
  OperonBridgePageSchema,
  OperonConvertTaskSchema,
  OperonFilterQuerySchema,
  OperonTaskFinderSchema,
  OperonResolveTaskSchema,
  OperonRelationshipsSchema,
  OperonContextSchema,
  OperonRelocateTaskSchema,
  OperonConfigurationSchema,
  OperonCreateTaskSchema,
  OperonCreatePeriodicTaskSchema,
  OperonQuerySchema,
  OperonStatusSchema,
  OperonTaskSchema,
  OperonTransitionTaskSchema,
  OperonUpdateTaskSchema,
  OperonUpdatePeriodicSchedulingSchema,
  OperonSetRelationshipsSchema,
  OperonUpdateRecurrenceSchema,
  OperonRecoverMutationInputSchema,
  OperonRecoverMutationSchema,
  OperonPendingRecoveriesSchema,
  OperonMutationResultSchema,
  OperonNativeMutationProofSchema,
  OperonVaultMarkdownPathSchema,
  OperonVaultRelativePathSchema,
  queryOperonSnapshot,
  resolveOperonPriorityStableId,
  resolveOperonWorkflowStatus,
} from "../dist/services/operon/contract.js";

const planDigestA = "a".repeat(64);
const validNativeProof = {
  contractVersion: 1,
  kind: "mutation-result",
  status: "already-applied",
  mutationMayHaveApplied: true,
  retryAllowed: false,
  groupResults: [],
  receipt: {
    contractVersion: 1,
    planDigest: planDigestA,
    mutationKind: "task.update",
    targetDigest: "b".repeat(64),
    terminalOutcome: "already-applied",
    effectiveAt: "2026-08-24T08:00:00.000Z",
    completedAt: "2026-08-24T08:00:01.000Z",
    expiresAt: "2026-08-24T09:00:01.000Z",
  },
  postflight: { status: "receipt-replay" },
};
assert.deepEqual(
  OperonNativeMutationProofSchema.parse(validNativeProof),
  validNativeProof,
  "a bounded native Operon mutation proof must survive MCP validation intact",
);
for (const mutationKind of [
  "task.adopt",
  "task.create",
  "task.update",
  "task.transition",
  "task.relationship",
  "task.recurrence",
  "task.convert",
  "task.inline-relocate",
]) {
  assert.equal(
    OperonNativeMutationProofSchema.safeParse({
      ...validNativeProof,
      receipt: { ...validNativeProof.receipt, mutationKind },
      postflight: {
        status: "receipt-replay",
        observedAt: "2026-08-24T08:00:02.000Z",
      },
    }).success,
    true,
    `native receipt proof must admit ${mutationKind}`,
  );
}
assert.equal(
  OperonNativeMutationProofSchema.safeParse({
    ...validNativeProof,
    status: "committed",
  }).success,
  false,
  "unknown native proof statuses must be rejected",
);
assert.equal(
  OperonNativeMutationProofSchema.safeParse({
    ...validNativeProof,
    groupResults: Array.from({ length: 513 }, (_, index) => ({
      groupId: `group-${index}`,
      status: "committed",
    })),
  }).success,
  false,
  "native proof group results must remain bounded",
);
assert.equal(
  OperonNativeMutationProofSchema.safeParse({
    ...validNativeProof,
    receipt: {
      ...validNativeProof.receipt,
      planDigest: planDigestA.toUpperCase(),
    },
  }).success,
  false,
  "native receipt proofs must reject non-lowercase SHA-256 digests",
);
assert.equal(
  OperonNativeMutationProofSchema.safeParse({
    ...validNativeProof,
    groupResults: [
      {
        groupId: "group-no-leak",
        status: "failed",
        error: { reason: "private task content" },
      },
    ],
  }).success,
  false,
  "native group proofs must reject uncontracted error payloads",
);
assert.equal(
  OperonNativeMutationProofSchema.safeParse({
    ...validNativeProof,
    postflight: {
      status: "verified",
      observedAt: "2026-08-24T08:00:01.000Z",
      contextRevision: { private: "not projected by the Bridge" },
    },
  }).success,
  false,
  "native postflight proofs must reject unprojected context state",
);
assert.equal(
  OperonRecoverMutationSchema.safeParse({
    idempotencyKey: "recovery-contract-key",
    recoveryRef: "dvr1_contract-recovery",
    recovery: { kind: "periodic-update", planDigest: planDigestA },
  }).success,
  true,
);
assert.equal(
  OperonRecoverMutationSchema.safeParse({
    idempotencyKey: "recovery-contract-key",
    recoveryRef: "dvr1_contract-recovery",
    recovery: {
      kind: "periodic-update",
      planDigest: `sha256:${planDigestA}`,
    },
  }).success,
  false,
  "recovery planDigest must use Operon's exact lowercase 64-hex format",
);
assert.equal(
  OperonRecoverMutationSchema.safeParse({
    idempotencyKey: "recovery-contract-key",
    recoveryRef: "dvr1_contract-recovery",
  }).success,
  false,
  "every recovery must declare a typed recovery binding",
);
assert.equal(
  OperonRecoverMutationSchema.safeParse({
    idempotencyKey: "recovery-contract-key",
    recoveryRef: "dvr1_contract-recovery",
    recovery: { kind: "developer-api" },
  }).success,
  true,
  "legacy official Developer API recovery remains available through an explicit kind",
);
assert.equal(
  OperonRecoverMutationSchema.safeParse({
    idempotencyKey: "recovery-contract-key",
    recoveryRef: "dvr1_contract-recovery",
    recovery: { kind: "developer-api", planDigest: planDigestA },
  }).success,
  false,
  "developer-api recovery must structurally reject task-workflow plan digests",
);
assert.equal(
  OperonPendingRecoveriesSchema.safeParse({
    ok: true,
    contractVersion: "1",
    source: "operon-live",
    stale: false,
    recoveries: [{ planDigest: planDigestA }],
  }).success,
  true,
);
assert.equal(
  OperonPendingRecoveriesSchema.safeParse({
    ok: true,
    contractVersion: "1",
    source: "operon-live",
    stale: false,
    recoveries: [{ planDigest: planDigestA.toUpperCase() }],
  }).success,
  false,
  "pending recovery results must reject non-lowercase SHA-256 digests",
);
assert.equal(
  OperonMutationResultSchema.safeParse({
    ok: true,
    contractVersion: "1",
    operationId: "operation-uppercase-digest",
    idempotencyKey: "uppercase-digest-key",
    status: "planned",
    requested: {},
    planDigest: planDigestA.toUpperCase(),
    source: "operon-live",
    stale: false,
  }).success,
  false,
  "mutation results must reject non-lowercase SHA-256 digests",
);
assert.equal(
  OperonMutationResultSchema.safeParse({
    ok: true,
    contractVersion: "1",
    operationId: "operation-native-proof",
    idempotencyKey: "native-proof-key",
    status: "already-applied",
    requested: {},
    nativeProof: { ...validNativeProof, retryAllowed: "false" },
    source: "operon-live",
    stale: false,
  }).success,
  false,
  "a malformed native proof must reject the complete mutation response",
);

const schemaServer = new McpServer({
  name: "operon-recovery-schema-test",
  version: "0",
});
schemaServer.tool(
  "operon_recover_mutation",
  OperonRecoverMutationInputSchema.shape,
  async () => ({ content: [{ type: "text", text: "ok" }] }),
);
const [schemaClientTransport, schemaServerTransport] =
  InMemoryTransport.createLinkedPair();
const schemaClient = new Client({
  name: "operon-recovery-schema-client",
  version: "0",
});
await schemaServer.connect(schemaServerTransport);
await schemaClient.connect(schemaClientTransport);
const publishedRecoveryTool = (await schemaClient.listTools()).tools.find(
  (tool) => tool.name === "operon_recover_mutation",
);
assert.ok(publishedRecoveryTool);
assert.ok(
  publishedRecoveryTool.inputSchema.required?.includes("recovery"),
  "tools/list must publish the typed recovery binding as required",
);
const publishedRecoveryBinding =
  publishedRecoveryTool.inputSchema.properties?.recovery;
assert.ok(
  Array.isArray(publishedRecoveryBinding?.anyOf),
  "tools/list must publish the nested recovery discriminated union",
);
const publishedTaskWorkflowBranch = publishedRecoveryBinding.anyOf.find(
  (branch) => branch.properties?.planDigest,
);
const publishedDeveloperApiBranch = publishedRecoveryBinding.anyOf.find(
  (branch) => branch.properties?.kind?.const === "developer-api",
);
assert.equal(
  publishedTaskWorkflowBranch?.properties?.planDigest?.pattern,
  "^[a-f0-9]{64}$",
  "tools/list must publish the exact lowercase SHA-256 planDigest pattern only in the task-workflow branch",
);
assert.equal(
  Object.hasOwn(publishedDeveloperApiBranch?.properties ?? {}, "planDigest"),
  false,
  "tools/list must not publish planDigest in the developer-api branch",
);
await schemaClient.close();
await schemaServer.close();

assert.equal(
  resolveOperonPriorityStableId("F", [
    { id: "pr_a", label: "A" },
    { id: "pr_f", label: "F" },
  ]),
  "pr_f",
  "MCP postflight must compare priority labels against stable runtime ids",
);

const capabilities = {
  status: true,
  configuration: true,
  list: true,
  get: true,
  query: true,
  validate: true,
  adopt: false,
  create: false,
  update: false,
  transition: false,
  convert: false,
};

const semanticConfiguration = {
  language: "fr",
  workflow: {
    language: "fr",
    defaultPipelineName: "Project",
    pipelines: [
      {
        id: "pl_project",
        name: "Project",
        description: "Workflow projet ÉLYSIA",
        statuses: [
          {
            id: "st_project_finished",
            label: "Terminé",
            value: "Project.Terminé",
            isFinished: true,
            isCancelled: false,
            isScheduledTarget: false,
            isTrackingTarget: false,
          },
        ],
      },
    ],
  },
  priorities: { defaultPriority: "C", items: [] },
  keys: [],
  creation: {
    fileTasksFolder: "Efforts/Projets/_Operon",
    inlineTaskSaveMode: "ask-every-time",
    inlineTaskUseDailyNote: false,
    inlineTaskTargetFile: "Operon/Tasks/Operon Inbox.md",
    inlineTaskHeading: "",
    inlineTaskDailyNoteAddStartDate: false,
    inlineTaskDailyNoteAddScheduledDate: false,
    taskCreatorDefaultToFileTask: false,
    taskCreatorDefaultFileTemplateId: null,
    fileTaskTemplateFolder: "",
    fileTaskParentInlineTargetMode: "same-folder",
    fileTaskParentFileTargetMode: "same-folder",
    availableFileTaskTemplates: [],
  },
  automation: {
    autoCompleteParentWhenAllChildrenTerminal: false,
    cascadeCancelToDescendants: true,
    fileTaskAutoArchiveEnabled: false,
    fileTaskArchiveFolder: "Operon/Archives",
    fileTaskArchiveDelaySeconds: 30,
    fileTaskArchiveOnlyFromFileTasksFolder: true,
    fileRepeatDestination: "same-folder",
    fileRepeatCustomFolder: "",
  },
  indexing: {
    excludedFolders: ["tmp"],
    fullReindexOnStartup: false,
    indexEventDebounceMs: 250,
  },
  docs: {
    folder: "X/Logiciels/Obsidian/Plugins/Operon/Docs",
    autoUpdateEnabled: true,
  },
  views: {
    filters: [
      {
        id: "fs_elysia_now",
        name: "ÉLYSIA — Now",
        icon: "circle-play",
        definition: { id: "fs_elysia_now", conditions: [] },
      },
    ],
  },
};

const configuration = OperonConfigurationSchema.parse({
  ok: true,
  contractVersion: OPERON_CONTRACT_VERSION,
  source: "operon-runtime",
  stale: false,
  operonVersion: "2.5.0",
  bridgeVersion: "0.2.0",
  settingsSignature: "fnv1a32:01234567",
  configuration: semanticConfiguration,
  limitations: [],
});
assert.equal(
  configuration.configuration.workflow.pipelines[0].statuses[0].id,
  "st_project_finished",
);
assert.equal(
  resolveOperonWorkflowStatus("Terminé", configuration.configuration.workflow)
    ?.value,
  "Project.Terminé",
  "MCP postflight must resolve a short status label to the canonical workflow value",
);

const task = OperonTaskSchema.parse({
  operonId: "abc1234",
  source: "inline",
  path: "Efforts/Projets/Bridge.md",
  line: 7,
  sourceMtime: 1000,
  description: "Ship Operon Bridge",
  checkbox: "open",
  status: "Project.InProgress",
  statusId: "st_project_in_progress",
  statusLabel: "InProgress",
  pipeline: "Project",
  pipelineId: "pl_project",
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
    taskGallery: [
      "attachments/one,comma.png",
      "attachments\\two;semicolon.png",
    ],
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
    compatibilityState: "certified",
    compatibilityAdmission: "legacy-version",
    compatibilityReason: "Certified fixture runtime.",
    testedAgainst: "2.4.0",
    supportedRange: "2.4.0",
  },
  index: {
    ready: true,
    generation: 42,
    taskCount: 1,
    duplicateConflictCount: 0,
  },
  settingsSignature: "fnv1a32:01234567",
  taxonomy: {
    language: "fr",
    defaultPipelineName: "Project",
    pipelines: [
      {
        id: "pl_project",
        name: "Project",
        description: "Workflow projet ÉLYSIA",
        statuses: [
          {
            id: "st_project_finished",
            label: "Terminé",
            value: "Project.Terminé",
            isFinished: true,
            isCancelled: false,
            isScheduledTarget: false,
            isTrackingTarget: false,
          },
        ],
      },
    ],
  },
  capabilities,
  source: "operon-runtime",
  stale: false,
  limitations: ["read-only"],
});
assert.equal(status.index.generation, 42);
const {
  compatibilityState: _legacyCompatibilityState,
  compatibilityAdmission: _legacyCompatibilityAdmission,
  compatibilityReason: _legacyCompatibilityReason,
  ...legacyOperonStatus
} = status.operon;
const legacyBridgeStatus = OperonStatusSchema.parse({
  ...status,
  operon: legacyOperonStatus,
});
assert.equal(legacyBridgeStatus.operon.compatibilityState, undefined);

const bridgePage = OperonBridgePageSchema.parse({
  ok: true,
  contractVersion: OPERON_CONTRACT_VERSION,
  source: "operon-live",
  stale: false,
  generation: 42,
  settingsSignature: "fnv1a32:01234567",
  total: 1,
  count: 1,
  cursor: "0",
  hasMore: false,
  tasks: [task],
  limitations: ["read-only"],
});
assert.equal(bridgePage.tasks[0].operonId, "abc1234");

const query = OperonQuerySchema.parse({
  pipelineIds: ["pl_project"],
  statusIds: ["st_project_in_progress"],
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
    snapshotSchemaVersion: 2,
    settingsSignature: "fnv1a32:01234567",
    generation: 42,
    capabilities,
    limitations: ["read-only"],
    tasks: [task],
  },
  query,
);
assert.equal(page.total, 1);
assert.equal(page.tasks[0].statusId, "st_project_in_progress");
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
    snapshotSchemaVersion: 2,
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

const galleryMatch = queryOperonSnapshot(
  {
    source: "operon-live",
    stale: false,
    snapshotAt: "2026-07-20T12:00:00.000Z",
    snapshotAgeMs: 0,
    operonVersion: "3.5.3",
    bridgeVersion: "0.8.3",
    contractVersion: OPERON_CONTRACT_VERSION,
    snapshotSchemaVersion: 2,
    settingsSignature: "fnv1a32:01234567",
    generation: 42,
    capabilities,
    limitations: [],
    tasks: [task],
  },
  {
    fieldEquals: {
      taskGallery: [
        "attachments/one,comma.png",
        "attachments\\two;semicolon.png",
      ],
    },
    limit: 10,
  },
);
assert.equal(galleryMatch.total, 1);
const galleryReordered = queryOperonSnapshot(
  {
    ...galleryMatch,
    tasks: [task],
    settingsSignature: "fnv1a32:01234567",
    generation: 42,
  },
  {
    fieldEquals: {
      taskGallery: [
        "attachments\\two;semicolon.png",
        "attachments/one,comma.png",
      ],
    },
    limit: 10,
  },
);
assert.equal(
  galleryReordered.total,
  0,
  "ordered list equality must detect reordering",
);

const create = OperonCreateTaskSchema.parse({
  idempotencyKey: "contract-create-1",
  task: {
    source: "file",
    description: "Create through MCP",
    properties: { north_star: true, rang: 2 },
  },
});
assert.equal(create.dryRun, true);
assert.equal(
  OperonCreateTaskSchema.safeParse({
    idempotencyKey: "contract-create-scheduled-date",
    task: {
      source: "inline",
      description: "Scheduled task must use the periodic update workflow",
      fields: { dateScheduled: "2026-08-30" },
    },
  }).success,
  false,
  "task creation must not bypass periodic scheduling for dateScheduled",
);

const createWithGallery = OperonCreateTaskSchema.parse({
  idempotencyKey: "contract-create-gallery",
  task: {
    source: "inline",
    description: "Create ordered gallery",
    targetPath: "Efforts/Projets/Test.md",
    fields: {
      taskGallery: ["media/a,b.png", "media\\c;d.png", "media/a,b.png"],
    },
  },
});
assert.deepEqual(createWithGallery.task.fields.taskGallery, [
  "media/a,b.png",
  "media\\c;d.png",
]);
assert.equal(
  OperonCreateTaskSchema.safeParse({
    ...createWithGallery,
    task: {
      ...createWithGallery.task,
      fields: { taskGallery: "media/a.png;media/b.png" },
    },
  }).success,
  false,
  "taskGallery must never be reconstructed from a delimiter string",
);

for (const field of [
  "taskType",
  "taskImage",
  "taskIcon",
  "taskColor",
  "note",
  "location",
  "dateDue",
  "dateScheduled",
  "dateStarted",
  "datetimeStart",
  "datetimeEnd",
  "estimate",
]) {
  assert.equal(
    OperonCreateTaskSchema.safeParse({
      idempotencyKey: `contract-create-scalar-${field}`,
      task: {
        description: "Scalar field contract",
        source: "inline",
        fields: { [field]: ["must-not-coerce"] },
      },
    }).success,
    false,
    `${field} must reject arrays before preview/apply`,
  );
  assert.equal(
    OperonUpdateTaskSchema.safeParse({
      operonId: "abc1234",
      expectedRevision: task.revision,
      idempotencyKey: `contract-update-scalar-${field}`,
      patch: { fields: { [field]: ["must-not-coerce"] } },
    }).success,
    false,
    `update ${field} must reject arrays before preview/apply`,
  );
}
for (const field of ["taskGallery", "assignees", "contexts", "links"]) {
  assert.equal(
    OperonCreateTaskSchema.safeParse({
      idempotencyKey: `contract-create-list-${field}`,
      task: {
        description: "List field contract",
        source: "inline",
        fields: { [field]: "must-not-split" },
      },
    }).success,
    false,
    `${field} must reject scalar coercion before preview/apply`,
  );
  assert.equal(
    OperonUpdateTaskSchema.safeParse({
      operonId: "abc1234",
      expectedRevision: task.revision,
      idempotencyKey: `contract-update-list-${field}`,
      patch: { fields: { [field]: "must-not-split" } },
    }).success,
    false,
    `update ${field} must reject scalar coercion before preview/apply`,
  );
}
assert.equal(
  OperonCreatePeriodicTaskSchema.safeParse({
    idempotencyKey: "contract-periodic-scalar-field-array",
    periodic: {
      description: "Periodic scalar field contract",
      periodicKind: "daily",
      fields: { taskType: ["must-not-coerce"] },
    },
  }).success,
  false,
  "periodic creation must apply the scalar field contract before dispatch",
);

const createGallery256 = Array.from(
  { length: 256 },
  (_, index) => `media/create-${index}.png`,
);
assert.equal(
  OperonCreateTaskSchema.safeParse({
    idempotencyKey: "contract-create-gallery-256",
    task: {
      source: "inline",
      description: "Create maximum gallery",
      targetPath: "Efforts/Projets/Test.md",
      fields: { taskGallery: createGallery256 },
    },
  }).success,
  true,
);
assert.equal(
  OperonCreateTaskSchema.safeParse({
    idempotencyKey: "contract-create-gallery-257",
    task: {
      source: "inline",
      description: "Reject oversized gallery",
      targetPath: "Efforts/Projets/Test.md",
      fields: { taskGallery: [...createGallery256, "media/create-256.png"] },
    },
  }).success,
  false,
  "create must reject item 257 before normalization",
);

const updateGallery512 = Array.from(
  { length: 512 },
  (_, index) => `media/update-${index}.png`,
);
assert.equal(
  OperonUpdateTaskSchema.safeParse({
    operonId: "abc1234",
    expectedRevision: task.revision,
    idempotencyKey: "contract-update-gallery-512",
    patch: { fields: { taskGallery: updateGallery512 } },
  }).success,
  true,
);
assert.equal(
  OperonUpdateTaskSchema.safeParse({
    operonId: "abc1234",
    expectedRevision: task.revision,
    idempotencyKey: "contract-update-gallery-513",
    patch: {
      fields: { taskGallery: [...updateGallery512, "media/update-512.png"] },
    },
  }).success,
  false,
  "update must reject item 513 before normalization",
);

const createPeriodic = OperonCreatePeriodicTaskSchema.parse({
  idempotencyKey: "contract-periodic-create",
  periodic: {
    description: "Daily review",
    periodicKind: "daily",
    routeDate: "2026-08-23",
    tags: ["work", "#work", " #focus ", "", "#"],
    fields: { taskGallery: ["media/daily,one.png"] },
  },
});
assert.equal(createPeriodic.dryRun, true);
assert.equal(createPeriodic.periodic.periodicKind, "daily");
assert.deepEqual(createPeriodic.periodic.tags, ["work", "focus"]);
for (const periodic of [
  { fields: { parentTask: "abc1234" } },
  { statusId: "planned", fields: { status: "other" } },
  { priorityId: "priority-a", fields: { priority: "priority-b" } },
]) {
  assert.equal(
    OperonCreatePeriodicTaskSchema.safeParse({
      idempotencyKey: `contract-periodic-exclusive-${JSON.stringify(periodic)}`,
      periodic: {
        description: "Daily review",
        periodicKind: "daily",
        ...periodic,
      },
    }).success,
    false,
    "periodic creation must preserve Operon-owned parentage and unambiguous selectors",
  );
}
assert.equal(
  OperonCreatePeriodicTaskSchema.safeParse({
    idempotencyKey: "contract-periodic-invalid-route-date",
    periodic: {
      description: "Daily review",
      periodicKind: "daily",
      routeDate: "tomorrow",
    },
  }).success,
  false,
  "periodic routeDate must be rejected at the MCP boundary",
);

const updatePeriodic = OperonUpdatePeriodicSchedulingSchema.parse({
  operonId: "abc1234",
  expectedRevision: task.revision,
  idempotencyKey: "contract-periodic-update",
  patch: { fields: { dateScheduled: null } },
});
assert.equal(updatePeriodic.patch.fields.dateScheduled, null);
const updatePeriodicSet = OperonUpdatePeriodicSchedulingSchema.parse({
  ...updatePeriodic,
  idempotencyKey: "contract-periodic-update-set",
  patch: { fields: { dateScheduled: "2026-08-30" } },
});
assert.equal(updatePeriodicSet.patch.fields.dateScheduled, "2026-08-30");
assert.equal(
  OperonCreatePeriodicTaskSchema.safeParse({
    idempotencyKey: "contract-periodic-create-scheduled-date",
    periodic: {
      description: "Periodic task with an initial scheduled date",
      periodicKind: "daily",
      fields: { dateScheduled: "2026-08-30" },
    },
  }).success,
  true,
  "the native periodic-create workflow may set an initial dateScheduled value",
);

const adopt = OperonAdoptTaskSchema.parse({
  idempotencyKey: "contract-adopt-1",
  adoption: {
    targetPath: "Efforts/Projets/Test.md",
    line: 7,
    expectedLine: "- [ ] Migrer cette action 📅 2026-07-31",
    statusId: "st_project_planned",
  },
});
assert.equal(adopt.dryRun, true);
assert.equal(adopt.adoption.line, 7);
assert.equal(
  OperonAdoptTaskSchema.safeParse({
    ...adopt,
    adoption: {
      ...adopt.adoption,
      expectedLine: "- [ ] ligne 1\n- [ ] ligne 2",
    },
  }).success,
  false,
);

const update = OperonUpdateTaskSchema.parse({
  operonId: task.operonId,
  expectedRevision: task.revision,
  idempotencyKey: "contract-update-1",
  patch: { fields: { priority: "B" }, tags: ["elysia"] },
});
assert.equal(update.patch.fields?.priority, "B");
assert.equal(
  OperonUpdateTaskSchema.safeParse({
    ...update,
    patch: { description: "Rename", properties: { north_star: false } },
  }).success,
  false,
);
assert.equal(
  OperonUpdateTaskSchema.safeParse({
    ...update,
    patch: { properties: { north_star: false, rang: 3 } },
  }).success,
  false,
);

const transition = OperonTransitionTaskSchema.parse({
  operonId: task.operonId,
  expectedRevision: task.revision,
  idempotencyKey: "contract-transition-1",
  status: "Project.Finished",
});

const createByStatusId = OperonCreateTaskSchema.parse({
  idempotencyKey: "contract-create-status-id",
  task: {
    source: "inline",
    description: "Créer avec un statut stable",
    statusId: "st_project_planned",
    targetPath: "Efforts/Projets/Test.md",
  },
});
assert.equal(createByStatusId.task.statusId, "st_project_planned");
assert.throws(() =>
  OperonCreateTaskSchema.parse({
    idempotencyKey: "contract-create-status-conflict",
    task: {
      source: "inline",
      description: "Conflit de statut",
      statusId: "st_project_planned",
      fields: { status: "Project.Planned" },
      targetPath: "Efforts/Projets/Test.md",
    },
  }),
);
assert.equal(transition.dryRun, true);
const transitionById = OperonTransitionTaskSchema.parse({
  operonId: task.operonId,
  expectedRevision: task.revision,
  idempotencyKey: "contract-transition-id-1",
  statusId: "st_project_finished",
});
assert.equal(transitionById.statusId, "st_project_finished");
assert.equal(
  OperonTransitionTaskSchema.safeParse({
    ...transitionById,
    status: "Project.Finished",
  }).success,
  false,
);
assert.equal(
  OperonTransitionTaskSchema.safeParse({
    operonId: task.operonId,
    expectedRevision: task.revision,
    idempotencyKey: "contract-transition-missing-1",
  }).success,
  false,
);
assert.equal(
  OperonConvertTaskSchema.safeParse({
    operonId: task.operonId,
    expectedRevision: task.revision,
    idempotencyKey: "contract-convert-1",
    target: "inline",
  }).success,
  false,
);

assert.equal(
  OperonCreateTaskSchema.safeParse({
    idempotencyKey: "contract-traversal-create",
    task: {
      source: "inline",
      description: "Traversal",
      targetPath: "Efforts/Projets/../../Atlas/Test.md",
    },
  }).success,
  false,
);
for (const invalidPath of [
  " Efforts/Projets/Test.md",
  "Efforts/Projets/Test.md ",
  "Efforts\\Projets\\Test.md",
  "/Efforts/Projets/Test.md",
  "C:/Efforts/Projets/Test.md",
  "Efforts//Projets/Test.md",
  "Efforts/./Projets/Test.md",
  "Efforts/Projets/../Atlas/Test.md",
  "Efforts/Projets/Test",
]) {
  assert.equal(
    OperonVaultMarkdownPathSchema.safeParse(invalidPath).success,
    false,
    `must reject non-canonical Markdown path: ${JSON.stringify(invalidPath)}`,
  );
}
for (const invalidPath of [
  " Efforts/Projets",
  "Efforts/Projets ",
  "Efforts\\Projets",
  "Efforts//Projets",
  "Efforts/Projets/",
]) {
  assert.equal(
    OperonVaultRelativePathSchema.safeParse(invalidPath).success,
    false,
    `must reject non-canonical vault path: ${JSON.stringify(invalidPath)}`,
  );
}
for (const schemaAndValue of [
  [
    OperonAdoptTaskSchema,
    {
      ...adopt,
      adoption: {
        ...adopt.adoption,
        targetPath: `${adopt.adoption.targetPath} `,
      },
    },
  ],
  [
    OperonCreateTaskSchema,
    {
      idempotencyKey: "contract-create-path-space",
      task: {
        source: "inline",
        description: "Do not normalize",
        targetPath: "Efforts/Projets/Test.md ",
      },
    },
  ],
  [
    OperonConvertTaskSchema,
    {
      operonId: task.operonId,
      expectedRevision: task.revision,
      idempotencyKey: "contract-convert-path-space",
      target: "inline",
      targetPath: "Efforts/Projets/Test.md ",
    },
  ],
  [
    OperonRelocateTaskSchema,
    {
      operonId: task.operonId,
      expectedRevision: task.revision,
      idempotencyKey: "contract-relocate-path-space",
      targetPath: "Efforts/Projets/Cible.md ",
    },
  ],
]) {
  assert.equal(
    schemaAndValue[0].safeParse(schemaAndValue[1]).success,
    false,
    "mutation schemas must reject rather than normalize non-canonical paths",
  );
}
const filterQuery = OperonFilterQuerySchema.parse({
  filterSetId: "fs_elysia_now",
  scopePath: " Efforts/Projets ",
});
assert.equal(filterQuery.limit, 100);
assert.equal(filterQuery.scopePath, "Efforts/Projets");
assert.equal(
  OperonFilterQuerySchema.safeParse({
    filterSetId: "fs_elysia_now",
    scopePath: "Efforts/Projets/../Atlas",
  }).success,
  false,
);
const relocation = OperonRelocateTaskSchema.parse({
  operonId: task.operonId,
  expectedRevision: task.revision,
  idempotencyKey: "contract-relocate-1",
  targetPath: "Efforts/Projets/Cible.md",
});
assert.equal(relocation.dryRun, true);
const relationshipsMutation = OperonSetRelationshipsSchema.parse({
  operonId: "abc1234",
  expectedRevision: task.revision,
  idempotencyKey: "contract-relationships-1",
  relationships: { parentTask: null, blocking: ["bcd2345"], blockedBy: [] },
});
assert.equal(relationshipsMutation.dryRun, true);
for (const invalidRelationships of [
  { blocking: ["bcd2345", "bcd2345"] },
  { blocking: ["bcd2345"], blockedBy: ["bcd2345"] },
  { parentTask: "abc1234" },
]) {
  assert.equal(
    OperonSetRelationshipsSchema.safeParse({
      operonId: "abc1234",
      expectedRevision: task.revision,
      idempotencyKey: "contract-relationships-invalid",
      relationships: invalidRelationships,
    }).success,
    false,
  );
}
const recurrenceMutation = OperonUpdateRecurrenceSchema.parse({
  operonId: "abc1234",
  expectedRevision: task.revision,
  idempotencyKey: "contract-recurrence-1",
  scope: "this-and-following",
  changes: { repeat: "every week", datetimeRepeatEnd: null },
});
assert.equal(recurrenceMutation.dryRun, true);
assert.equal(
  OperonUpdateRecurrenceSchema.safeParse({
    ...recurrenceMutation,
    changes: { dateScheduled: "2026-08-30" },
  }).success,
  false,
  "recurrence updates must not bypass periodic scheduling for dateScheduled",
);
assert.equal(
  OperonUpdateRecurrenceSchema.safeParse({
    ...recurrenceMutation,
    scope: "all-tasks",
  }).success,
  false,
);
assert.equal(
  OperonUpdateTaskSchema.safeParse({
    operonId: "abc1234",
    expectedRevision: task.revision,
    idempotencyKey: "contract-update-dedicated-field",
    patch: { fields: { repeat: "every week" } },
  }).success,
  false,
  "general updates must not simulate recurrence mutations",
);
const genericScheduledDate = OperonUpdateTaskSchema.safeParse({
  operonId: "abc1234",
  expectedRevision: task.revision,
  idempotencyKey: "contract-update-scheduled-date",
  patch: { fields: { dateScheduled: "2026-08-30" } },
});
assert.equal(
  genericScheduledDate.success,
  false,
  "general updates must route scheduled dates through the periodic workflow",
);
if (genericScheduledDate.success) {
  throw new Error("Expected generic dateScheduled update to be rejected.");
}
assert.deepEqual(genericScheduledDate.error.issues, [
  {
    code: "custom",
    path: ["patch", "fields", "dateScheduled"],
    message:
      "Managed field 'dateScheduled' must use 'operon_update_periodic_scheduling'.",
  },
]);
for (const [field, value] of Object.entries({
  dateDue: "2026-08-31",
  dateStarted: "2026-08-30",
  datetimeStart: "2026-08-30T09:00:00",
  datetimeEnd: "2026-08-30T10:00:00",
})) {
  assert.equal(
    OperonUpdateTaskSchema.safeParse({
      operonId: "abc1234",
      expectedRevision: task.revision,
      idempotencyKey: `contract-update-temporal-${field}`,
      patch: { fields: { [field]: value } },
    }).success,
    true,
    `general updates must continue to accept ${field}`,
  );
}
assert.equal(
  OperonRelocateTaskSchema.safeParse({
    ...relocation,
    targetPath: "Efforts/Projets/../../Atlas/Cible.md",
  }).success,
  false,
);

const finder = OperonTaskFinderSchema.parse({
  text: "projet operon",
  scope: "recent",
  project: { mode: "tree", rootOperonId: task.operonId },
});
assert.equal(finder.limit, 20);
assert.equal(
  OperonTaskFinderSchema.safeParse({ text: "x", limit: 51 }).success,
  false,
);
assert.equal(
  OperonResolveTaskSchema.safeParse({
    selector: { kind: "search", query: "Operon", limit: 21 },
  }).success,
  false,
);
assert.equal(
  OperonRelationshipsSchema.parse({ operonId: task.operonId }).depth,
  1,
);
assert.equal(
  OperonContextSchema.safeParse({
    purpose: "analysis",
    projection: "task-neighborhood",
  }).success,
  false,
  "task-neighborhood must be rooted in an exact operonId",
);
assert.equal(
  OperonContextSchema.safeParse({
    purpose: "planning",
    projection: "planning-workload",
    filters: { checkbox: ["open"] },
    include: ["notes", "links"],
    limit: 50,
  }).success,
  true,
);

console.log(
  "PASS: Operon MCP native read/mutation schemas, filtering, property gating, and freshness envelope",
);
