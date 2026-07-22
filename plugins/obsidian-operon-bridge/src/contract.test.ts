import assert from "node:assert/strict";
import test from "node:test";
import {
  filterTasks,
  isIndexReady,
  isVersionCompatible,
  normalizeTask,
  paginateTasks,
  queryTasks,
  resolveWorkflow,
  settingsSignature,
  shouldAttemptIndexValidation,
  type OperonBridgeTask,
  type RuntimeIndexedTask,
} from "./contract";

const pipelines = [
  {
    id: "pl_project",
    name: "Project",
    statuses: [
      { id: "st_project_planned", label: "Planned" },
      { id: "st_project_in_progress", label: "InProgress" },
      { id: "st_project_finished", label: "Finished", isFinished: true },
    ],
  },
];

const semanticConfiguration = {
  language: "en",
  workflow: { language: "en", defaultPipelineName: "Project", pipelines: [] },
  priorities: { defaultPriority: "C", items: [] },
  keys: [],
  creation: {
    fileTasksFolder: "Operon/Tasks",
    inlineTaskSaveMode: "ask-every-time",
    inlineTaskUseDailyNote: false,
    inlineTaskTargetFile: "Operon/Inbox.md",
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
  indexing: { excludedFolders: [], fullReindexOnStartup: false, indexEventDebounceMs: 250 },
  docs: { folder: "Operon/Docs", autoUpdateEnabled: false },
  views: { filters: [] },
};

const task: RuntimeIndexedTask = {
  operonId: "abc1234",
  description: "Ship bridge",
  checkbox: "open",
  fieldValues: {
    status: "Project.InProgress",
    priority: "A",
    dateDue: "2026-07-31",
    parentTask: "parent1",
    blockedBy: "dep1; dep2",
    custom: "signal",
  },
  tags: ["#elysia", "bridge"],
  primary: { filePath: "Efforts/Projets/Bridge.md", lineNumber: 4, format: "inline" },
  datetimeModified: "2026-07-20T10:00:00",
  tier: "hot",
};

function normalized(): OperonBridgeTask {
  return normalizeTask({
    task,
    pipelines,
    keyMappings: [
      {
        canonicalKey: "status",
        visiblePropertyName: "status",
      },
      {
        canonicalKey: "priority",
        visiblePropertyName: "priority",
      },
    ],
    frontmatter: { status: "Project.InProgress", priority: "A", rang: 4, north_star: true },
    sourceMtime: 1234,
    operonVersion: "2.4.0",
    bridgeVersion: "0.1.0",
    includeProperties: true,
  });
}

test("version compatibility is an explicit tested-version allowlist", () => {
  assert.equal(isVersionCompatible("operon", "2.4.0"), true);
  assert.equal(isVersionCompatible("operon", "2.5.0"), true);
  assert.equal(isVersionCompatible("operon", "2.5.1"), false);
  assert.equal(isVersionCompatible("operon", "2.5.2"), false);
  assert.equal(isVersionCompatible("kairelys", "2.5.0"), false);
  assert.equal(isVersionCompatible("kairelys", "2.5.1"), true);
  assert.equal(isVersionCompatible("kairelys", "2.5.2"), true);
  assert.equal(isVersionCompatible("kairelys", "2.5.3"), true);
  assert.equal(isVersionCompatible("kairelys", "2.5.4"), false);
  assert.equal(isVersionCompatible("kairelys", "2.6.0"), false);
  assert.equal(isVersionCompatible("kairelys", "2.6.1"), true);
  assert.equal(isVersionCompatible("kairelys", "2.6.2"), true);
  assert.equal(isVersionCompatible("kairelys", "2.6.3"), false);
});

test("index readiness refuses startup, recovery, sync, and dirty states", () => {
  const healthy = {
    health: "healthy",
    runtimePhase: "idle",
    verifiedThisSession: true,
    dirtySourceCount: 0,
  };
  assert.equal(isIndexReady({ compatible: true, generation: 1, diagnostics: healthy }), true);
  assert.equal(isIndexReady({ compatible: true, generation: 0, diagnostics: healthy }), false);
  assert.equal(
    isIndexReady({
      compatible: true,
      generation: 1,
      diagnostics: { ...healthy, runtimePhase: "sync-settling" },
    }),
    false,
  );
  assert.equal(
    isIndexReady({
      compatible: true,
      generation: 1,
      diagnostics: { ...healthy, dirtySourceCount: 1 },
    }),
    false,
  );
  assert.equal(isIndexReady({ compatible: true, generation: 1, diagnostics: null }), false);
});

test("index validation is attempted only for a settled unverified snapshot", () => {
  const settled = {
    health: "healthy",
    runtimePhase: "idle",
    verifiedThisSession: false,
    dirtySourceCount: 0,
  };
  assert.equal(
    shouldAttemptIndexValidation({
      compatible: true,
      generation: 2,
      diagnostics: settled,
      hasValidator: true,
    }),
    true,
  );
  assert.equal(
    shouldAttemptIndexValidation({
      compatible: true,
      generation: 2,
      diagnostics: { ...settled, verifiedThisSession: true },
      hasValidator: true,
    }),
    false,
  );
  assert.equal(
    shouldAttemptIndexValidation({
      compatible: true,
      generation: 2,
      diagnostics: { ...settled, dirtySourceCount: 1 },
      hasValidator: true,
    }),
    false,
  );
  assert.equal(
    shouldAttemptIndexValidation({
      compatible: true,
      generation: 2,
      diagnostics: settled,
      hasValidator: false,
    }),
    false,
  );
});

test("workflow resolution uses configured pipeline labels", () => {
  assert.deepEqual(resolveWorkflow("Project.InProgress", pipelines), {
    pipeline: "Project",
    pipelineId: "pl_project",
    statusLabel: "InProgress",
    statusId: "st_project_in_progress",
  });
  assert.deepEqual(resolveWorkflow("Unknown.State", pipelines), {
    pipeline: null,
    pipelineId: null,
    statusLabel: null,
    statusId: null,
  });
});

test("normalization preserves canonical/custom fields and unmanaged file properties", () => {
  const value = normalized();
  assert.equal(value.source, "inline");
  assert.equal(value.line, 5);
  assert.equal(value.pipeline, "Project");
  assert.equal(value.pipelineId, "pl_project");
  assert.equal(value.statusLabel, "InProgress");
  assert.equal(value.statusId, "st_project_in_progress");
  assert.deepEqual(value.blockedBy, ["dep1", "dep2"]);
  assert.equal(value.fields.custom, "signal");
  assert.deepEqual(value.properties, { north_star: true, rang: 4 });
  assert.match(value.revision, /^fnv1a32:[0-9a-f]{8}$/u);
});

test("filtering supports paths, tags, fields, properties, dates, and search", () => {
  const value = normalized();
  const tasks = [value];
  assert.equal(filterTasks(tasks, { pathIncludes: ["Efforts/Projets"] }).length, 1);
  assert.equal(filterTasks(tasks, { tagsAll: ["elysia", "bridge"] }).length, 1);
  assert.equal(filterTasks(tasks, { fieldEquals: { custom: "signal" } }).length, 1);
  assert.equal(filterTasks(tasks, { propertyEquals: { north_star: true } }).length, 1);
  assert.equal(filterTasks(tasks, { dates: [{ field: "due", before: "2026-08-01" }] }).length, 1);
  assert.equal(filterTasks(tasks, { search: "ship bridge" }).length, 1);
  assert.equal(filterTasks(tasks, { statuses: ["Project.Planned"] }).length, 0);
  assert.equal(filterTasks(tasks, { statusIds: ["st_project_in_progress"] }).length, 1);
  assert.equal(filterTasks(tasks, { pipelineIds: ["pl_project"] }).length, 1);
});

test("pagination and stable default sorting are deterministic", () => {
  const first = normalized();
  const second = { ...first, operonId: "zzz9999", path: "A.md", line: 1 };
  const result = queryTasks([first, second], { limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.count, 1);
  assert.equal(result.tasks[0].operonId, "zzz9999");
  assert.equal(result.nextCursor, "1");
  const next = paginateTasks([second, first], { cursor: result.nextCursor, limit: 1 });
  assert.equal(next.tasks[0].operonId, "abc1234");
});

test("settings signature changes when the workflow contract changes", () => {
  const before = settingsSignature(semanticConfiguration);
  const after = settingsSignature({
    ...semanticConfiguration,
    workflow: { ...semanticConfiguration.workflow, defaultPipelineName: "ÉLYSIA" },
  });
  assert.notEqual(before, after);
});
