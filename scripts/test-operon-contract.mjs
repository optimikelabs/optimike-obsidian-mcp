import assert from "node:assert/strict";
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
  OperonQuerySchema,
  OperonStatusSchema,
  OperonTaskSchema,
  OperonTransitionTaskSchema,
  OperonUpdateTaskSchema,
  OperonVaultMarkdownPathSchema,
  OperonVaultRelativePathSchema,
  queryOperonSnapshot,
  resolveOperonPriorityStableId,
  resolveOperonWorkflowStatus,
} from "../dist/services/operon/contract.js";

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
  resolveOperonWorkflowStatus(
    "Terminé",
    configuration.configuration.workflow,
  )?.value,
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

const create = OperonCreateTaskSchema.parse({
  idempotencyKey: "contract-create-1",
  task: {
    source: "file",
    description: "Create through MCP",
    properties: { north_star: true, rang: 2 },
  },
});
assert.equal(create.dryRun, true);

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
