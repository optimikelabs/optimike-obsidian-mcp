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
  type OperonBridgeTask,
  type RuntimeIndexedTask,
} from "./contract";

const pipelines = [
  {
    name: "Project",
    statuses: [
      { label: "Planned" },
      { label: "InProgress" },
      { label: "Finished", isFinished: true },
    ],
  },
];

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
  assert.equal(isVersionCompatible("2.4.0"), true);
  assert.equal(isVersionCompatible("2.4.1"), false);
  assert.equal(isVersionCompatible("2.9.1"), false);
  assert.equal(isVersionCompatible("2.3.9"), false);
  assert.equal(isVersionCompatible("3.0.0"), false);
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

test("workflow resolution uses configured pipeline labels", () => {
  assert.deepEqual(resolveWorkflow("Project.InProgress", pipelines), {
    pipeline: "Project",
    statusLabel: "InProgress",
  });
  assert.deepEqual(resolveWorkflow("Unknown.State", pipelines), {
    pipeline: null,
    statusLabel: null,
  });
});

test("normalization preserves canonical/custom fields and unmanaged file properties", () => {
  const value = normalized();
  assert.equal(value.source, "inline");
  assert.equal(value.line, 5);
  assert.equal(value.pipeline, "Project");
  assert.equal(value.statusLabel, "InProgress");
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
  const before = settingsSignature(pipelines, []);
  const after = settingsSignature([{ name: "Project", statuses: [{ label: "Todo" }] }], []);
  assert.notEqual(before, after);
});
