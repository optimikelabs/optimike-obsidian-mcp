import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-operon-service-"),
);
const dbPath = path.join(tempRoot, "shared-cache.sqlite");

const capabilities = {
  status: true,
  configuration: true,
  list: true,
  get: true,
  query: true,
  validate: true,
  diagnostics: true,
  finder: true,
  resolve: true,
  relationships: true,
  context: true,
  timers: true,
  adopt: false,
  create: false,
  update: false,
  transition: false,
  convert: false,
  recovery: false,
  filterQuery: true,
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
        description: null,
        statuses: [
          {
            id: "st_project_in_progress",
            label: "InProgress",
            value: "Project.InProgress",
            isFinished: false,
            isCancelled: false,
            isScheduledTarget: false,
            isTrackingTarget: true,
          },
          {
            id: "st_project_done",
            label: "Done",
            value: "Project.Done",
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
  views: { filters: [] },
};

function configurationPayload() {
  return {
    ok: true,
    contractVersion: "1",
    source: "operon-runtime",
    stale: false,
    operonVersion: "2.4.0",
    bridgeVersion: "0.1.0",
    settingsSignature: "fnv1a32:settings",
    configuration: semanticConfiguration,
    limitations: ["read-only"],
  };
}

function makeTask(operonId, overrides = {}) {
  return {
    operonId,
    source: "inline",
    path: `Efforts/Projets/${operonId}.md`,
    line: 1,
    sourceMtime: 1000,
    description: `Task ${operonId}`,
    checkbox: "open",
    status: "Project.InProgress",
    statusId: "st_project_in_progress",
    statusLabel: "InProgress",
    pipeline: "Project",
    pipelineId: "pl_project",
    priority: "A",
    tier: "hot",
    tags: ["elysia"],
    parentTask: null,
    blocking: [],
    blockedBy: [],
    dates: {
      due: "2026-07-31",
      scheduled: null,
      started: null,
      completed: null,
      cancelled: null,
      datetimeStart: null,
      datetimeEnd: null,
      created: "2026-07-20T10:00:00",
      modified: "2026-07-20T11:00:00",
    },
    fields: { status: "Project.InProgress", priority: "A" },
    properties: { north_star: operonId === "abc1234" },
    revision: `fnv1a32:${operonId.padEnd(8, "0").slice(0, 8)}`,
    sourceKind: "operon-index",
    operonVersion: "2.4.0",
    bridgeVersion: "0.1.0",
    ...overrides,
  };
}

const tasks = [makeTask("abc1234"), makeTask("bcd2345")];
const state = {
  mode: "normal",
  generation: 1,
  statusCalls: 0,
  postCalls: 0,
  validationCalls: 0,
  mutationCalls: 0,
  recoveryCalls: 0,
  mutations: false,
};

function statusPayload() {
  state.statusCalls += 1;
  const generation =
    state.mode === "status-drift" && state.statusCalls >= 3
      ? state.generation + 1
      : state.generation;
  return {
    ok: state.mode !== "incompatible" && state.mode !== "initializing",
    contractVersion: "1",
    bridge: {
      id: "optimike-operon-bridge",
      version: "0.1.0",
      mode: "read-only",
    },
    operon: {
      present: state.mode !== "absent",
      version: "2.4.0",
      compatible: state.mode !== "incompatible",
      testedAgainst: "2.4.0",
      supportedRange: "2.4.0",
    },
    index: {
      ready: state.mode !== "incompatible" && state.mode !== "initializing",
      generation,
      taskCount: tasks.length,
      duplicateConflictCount: state.mode === "duplicate" ? 1 : 0,
    },
    settingsSignature: "fnv1a32:settings",
    capabilities: state.mutations
      ? {
          ...capabilities,
          adopt: true,
          create: true,
          update: true,
          transition: true,
          relationshipMutation: true,
          recurrenceMutation: true,
          convert: true,
          recovery: true,
        }
      : capabilities,
    source: "operon-runtime",
    stale: false,
    limitations: ["read-only"],
  };
}

function validationPayload() {
  state.validationCalls += 1;
  const P0 = state.mode === "p0" ? 1 : 0;
  return {
    ok: P0 === 0,
    contractVersion: "1",
    source: "operon-runtime",
    stale: false,
    taskCount: tasks.length,
    generation:
      state.mode === "validation-drift"
        ? state.generation + 1
        : state.generation,
    settingsSignature: "fnv1a32:settings",
    summary: { P0, P1: 0, P2: 0 },
    violations: P0 ? [{ severity: "P0", code: "fixture_p0" }] : [],
    limitations: ["read-only"],
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

const server = http.createServer((request, response) => {
  if (state.mode === "offline") {
    sendJson(response, 503, { error: "offline" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname.endsWith("/status")) {
    sendJson(response, 200, statusPayload());
    return;
  }
  if (request.method === "GET" && url.pathname.endsWith("/configuration")) {
    sendJson(response, 200, configurationPayload());
    return;
  }
  if (request.method === "GET" && url.pathname.endsWith("/validate")) {
    sendJson(response, 200, validationPayload());
    return;
  }
  const nativeReadOperation =
    request.method === "GET" && url.pathname.endsWith("/diagnostics")
      ? "diagnostics"
      : request.method === "GET" && url.pathname.endsWith("/timers")
        ? "timers"
        : request.method === "POST" && url.pathname.endsWith("/tasks/finder")
          ? "finder"
          : request.method === "POST" &&
              url.pathname.endsWith("/entities/resolve")
            ? "resolve"
            : request.method === "POST" &&
                url.pathname.endsWith("/relationships") &&
                !url.pathname.includes("/tasks/")
              ? "relationships"
              : request.method === "POST" && url.pathname.endsWith("/context")
                ? "context"
                : null;
  if (nativeReadOperation) {
    sendJson(response, 200, {
      ok: true,
      contractVersion: "1",
      source: "operon-live",
      stale: false,
      operation: nativeReadOperation,
      result: {
        ok: true,
        kind: `${nativeReadOperation}-test-result`,
        state:
          nativeReadOperation === "timers"
            ? { active: null, transition: null }
            : undefined,
      },
      limitations: ["read-only"],
    });
    return;
  }
  const taskGetMatch =
    request.method === "GET" &&
    /\/extensions\/optimike-operon-bridge\/v1\/tasks\/([^/]+)$/u.exec(
      url.pathname,
    );
  if (taskGetMatch) {
    const task = tasks.find(
      (candidate) => candidate.operonId === taskGetMatch[1],
    );
    sendJson(
      response,
      task ? 200 : 404,
      task ? { task } : { error: "not_found" },
    );
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/tasks/query")) {
    state.postCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      const incomplete = state.mode === "incomplete";
      const generationDrift = state.mode === "generation-drift";
      const secondPage = String(params.cursor ?? "0") === "1";
      const pageTasks = incomplete
        ? [tasks[0]]
        : generationDrift
          ? [secondPage ? tasks[1] : tasks[0]]
          : tasks;
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        source: "operon-live",
        stale: false,
        generation:
          generationDrift && secondPage
            ? state.generation + 1
            : state.generation,
        settingsSignature: "fnv1a32:settings",
        total: tasks.length,
        count: pageTasks.length,
        cursor: String(params.cursor ?? "0"),
        nextCursor: generationDrift && !secondPage ? "1" : undefined,
        hasMore: generationDrift && !secondPage,
        tasks: pageTasks,
        limitations: ["read-only"],
      });
    });
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/tasks/filter")) {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      if (params.filterSetId === "missing-filter") {
        sendJson(response, 404, {
          ok: false,
          error: { code: "not-found", message: "Saved filter was not found." },
        });
        return;
      }
      if (params.filterSetId === "invalid-filter") {
        sendJson(response, 422, {
          ok: false,
          error: {
            code: "invalid-request",
            message: "Saved filter request is invalid.",
          },
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        source: "operon-live",
        stale: false,
        generation: state.generation,
        settingsSignature: "fnv1a32:settings",
        total: tasks.length,
        count: 1,
        cursor: String(params.cursor ?? ""),
        nextCursor: params.cursor ? undefined : "filter-page-2",
        hasMore: !params.cursor,
        tasks: [params.cursor ? tasks[1] : tasks[0]],
        limitations: ["read-only"],
      });
    });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname.endsWith("/mutations/recover")
  ) {
    state.recoveryCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-recovery-${state.recoveryCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: "already-applied",
        before: null,
        requested: { recoveryRef: params.recoveryRef },
        after: null,
        planDigest: "plan-recovery-test",
        recoveryRef: params.recoveryRef,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (
    request.method === "POST" &&
    /\/tasks\/([^/]+)\/transition$/u.test(url.pathname)
  ) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      const operonId =
        /\/tasks\/([^/]+)\/transition$/u.exec(url.pathname)?.[1] ?? "abc1234";
      const before =
        tasks.find((candidate) => candidate.operonId === operonId) ?? tasks[0];
      const after = makeTask(operonId, {
        status: "Project.Done",
        statusId: "st_project_done",
        statusLabel: "Done",
        fields: { ...before.fields, status: "Project.Done" },
      });
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-transition-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: "applied",
        before,
        requested: params,
        after,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (
    request.method === "POST" &&
    /\/tasks\/([^/]+)\/relationships$/u.test(url.pathname)
  ) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      const operonId =
        /\/tasks\/([^/]+)\/relationships$/u.exec(url.pathname)?.[1] ??
        "abc1234";
      const before = tasks[0];
      const desired = params.relationships ?? {};
      const after = makeTask(operonId, {
        parentTask: Object.hasOwn(desired, "parentTask")
          ? desired.parentTask
          : before.parentTask,
        blocking: Object.hasOwn(desired, "blocking")
          ? desired.blocking
          : before.blocking,
        blockedBy: Object.hasOwn(desired, "blockedBy")
          ? desired.blockedBy
          : before.blockedBy,
      });
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-relationships-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: params.dryRun === false ? "applied" : "planned",
        before,
        requested: desired,
        after: params.dryRun === false ? after : null,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (
    request.method === "POST" &&
    /\/tasks\/([^/]+)\/recurrence$/u.test(url.pathname)
  ) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      const operonId =
        /\/tasks\/([^/]+)\/recurrence$/u.exec(url.pathname)?.[1] ?? "abc1234";
      const before = tasks[0];
      const fields = { ...before.fields };
      for (const [field, value] of Object.entries(params.changes ?? {})) {
        if (value === null) delete fields[field];
        else fields[field] = String(value);
      }
      const repeating = typeof fields.repeat === "string" && fields.repeat.length > 0;
      const after = makeTask(operonId, {
        fields,
        recurrence: {
          repeating,
          seriesId: repeating ? "rsabc12" : null,
          occurrenceDate: repeating ? (fields.dateScheduled ?? "2026-08-10") : null,
        },
      });
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-recurrence-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: params.dryRun === false ? "applied" : "planned",
        before,
        requested: { scope: params.scope, changes: params.changes },
        after: params.dryRun === false ? after : null,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/tasks/adopt")) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-adopt-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: "planned",
        before: null,
        requested: params.adoption,
        after: null,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/tasks")) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-create-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: "planned",
        before: null,
        requested: params.task,
        after: null,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Test server did not bind.");

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_API_KEY = "test-operon-key";
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.OBSIDIAN_VERIFY_SSL = "false";
process.env.OBSIDIAN_VAULT = tempRoot;
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = dbPath;
process.env.MCP_WRITE_MODE = "readonly";
process.env.OPERON_MUTATION_ALLOWED_PATH_PREFIXES = "Efforts/Projets";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { OperonService } = await import("../dist/services/operon/service.js");
const { config } = await import("../dist/config/index.js");

try {
  const service = new OperonService();

  const first = await service.ensureSnapshot(true);
  assert.equal(first.source, "operon-live");
  assert.equal(first.stale, false);
  assert.equal(first.tasks.length, 2);
  assert.equal(state.postCalls, 1);
  assert.equal(state.validationCalls, 1);
  const firstSnapshotAt = first.snapshotAt;

  const reused = await service.ensureSnapshot(false);
  assert.equal(reused.source, "operon-live");
  assert.equal(reused.snapshotAt, firstSnapshotAt);
  assert.equal(
    state.postCalls,
    1,
    "unchanged generation must not repage all tasks",
  );
  assert.equal(
    state.validationCalls,
    1,
    "unchanged generation must not rerun full validation",
  );

  const propertyQuery = await service.query({
    propertyEquals: { north_star: true },
    includeProperties: true,
    limit: 10,
  });
  assert.equal(propertyQuery.total, 1);
  assert.equal(propertyQuery.tasks[0].operonId, "abc1234");
  const stripped = await service.query({
    operonIds: ["abc1234"],
    includeProperties: false,
    limit: 1,
  });
  assert.equal("properties" in stripped.tasks[0], false);

  assert.equal((await service.diagnostics()).operation, "diagnostics");
  assert.equal(
    (await service.findTasks({ text: "bridge", limit: 10 })).operation,
    "finder",
  );
  assert.equal(
    (
      await service.resolveTask({
        selector: { kind: "operon-id", operonId: "abc1234" },
      })
    ).operation,
    "resolve",
  );
  assert.equal(
    (await service.relationships({ operonId: "abc1234" })).operation,
    "relationships",
  );
  assert.equal(
    (
      await service.context({
        purpose: "analysis",
        projection: "task-neighborhood",
        operonId: "abc1234",
      })
    ).operation,
    "context",
  );
  assert.equal(
    (
      await service.context({
        purpose: "read",
        projection: "exact-task",
        operonId: "abc1234",
      })
    ).operation,
    "context",
    "exact-task context must preserve Operon's projection-specific defaults",
  );
  assert.equal((await service.timers()).operation, "timers");

  const firstFilterPage = await service.querySavedFilter({
    filterSetId: "elysia-now",
    limit: 1,
  });
  assert.equal(firstFilterPage.count, 1);
  assert.equal(firstFilterPage.hasMore, true);
  assert.equal(firstFilterPage.tasks[0].operonId, "abc1234");
  const secondFilterPage = await service.querySavedFilter({
    filterSetId: "elysia-now",
    limit: 1,
    cursor: firstFilterPage.nextCursor,
  });
  assert.equal(secondFilterPage.count, 1);
  assert.equal(secondFilterPage.hasMore, false);
  assert.equal(secondFilterPage.tasks[0].operonId, "bcd2345");
  await assert.rejects(
    () =>
      service.querySavedFilter({ filterSetId: "missing-filter", limit: 1 }),
    (error) =>
      error?.code === "NOT_FOUND" &&
      error?.message === "Saved filter was not found.",
  );
  await assert.rejects(
    () =>
      service.querySavedFilter({ filterSetId: "invalid-filter", limit: 1 }),
    (error) =>
      error?.code === "VALIDATION_ERROR" &&
      error?.message === "Saved filter request is invalid.",
  );

  state.mode = "offline";
  const offline = await service.ensureSnapshot(false);
  assert.equal(offline.source, "operon-cache");
  assert.equal(offline.stale, true);
  assert.equal(offline.tasks.length, 2);

  assert.equal(offline.capabilities.create, false);
  assert.equal(offline.capabilities.update, false);
  assert.equal(offline.capabilities.relocate, false);
  state.mode = "duplicate";
  state.generation = 2;
  const afterDuplicate = await service.ensureSnapshot(true);
  assert.equal(afterDuplicate.source, "operon-cache");
  assert.equal(afterDuplicate.stale, true);
  assert.equal(afterDuplicate.snapshotAt, firstSnapshotAt);
  assert.equal(afterDuplicate.tasks.length, 2);

  state.mode = "p0";
  state.generation = 3;
  const afterP0 = await service.ensureSnapshot(true);
  assert.equal(afterP0.source, "operon-cache");
  assert.equal(afterP0.snapshotAt, firstSnapshotAt);
  assert.equal(afterP0.tasks.length, 2);

  state.mode = "incomplete";
  state.generation = 4;
  const afterIncomplete = await service.ensureSnapshot(true);
  assert.equal(afterIncomplete.source, "operon-cache");
  assert.equal(afterIncomplete.snapshotAt, firstSnapshotAt);
  assert.equal(afterIncomplete.tasks.length, 2);

  state.mode = "initializing";
  state.generation = 0;
  const duringStartup = await service.ensureSnapshot(true);
  assert.equal(duringStartup.source, "operon-cache");
  assert.equal(duringStartup.snapshotAt, firstSnapshotAt);
  assert.equal(duringStartup.tasks.length, 2);

  state.mode = "generation-drift";
  state.generation = 5;
  const afterGenerationDrift = await service.ensureSnapshot(true);
  assert.equal(afterGenerationDrift.source, "operon-cache");
  assert.equal(afterGenerationDrift.snapshotAt, firstSnapshotAt);
  assert.equal(afterGenerationDrift.tasks.length, 2);

  state.mode = "validation-drift";
  state.generation = 6;
  const afterValidationDrift = await service.ensureSnapshot(true);
  assert.equal(afterValidationDrift.source, "operon-cache");
  assert.equal(afterValidationDrift.snapshotAt, firstSnapshotAt);
  assert.equal(afterValidationDrift.tasks.length, 2);

  state.mode = "status-drift";
  state.generation = 7;
  state.statusCalls = 0;
  const afterStatusDrift = await service.ensureSnapshot(true);
  assert.equal(afterStatusDrift.source, "operon-cache");
  assert.equal(afterStatusDrift.snapshotAt, firstSnapshotAt);
  assert.equal(afterStatusDrift.tasks.length, 2);

  state.mode = "normal";
  state.mutations = true;
  state.generation = 8;
  const planned = await service.createTask({
    idempotencyKey: "test-create-idempotency",
    dryRun: true,
    task: {
      source: "file",
      description: "Dry run task",
      targetFolder: "Efforts/Projets/Internes/Operon Pilot",
    },
  });
  assert.equal(planned.status, "planned");
  assert.equal(state.mutationCalls, 1);

  const adoptionPlanned = await service.adoptTask({
    idempotencyKey: "test-adopt-idempotency",
    dryRun: true,
    adoption: {
      targetPath: "Efforts/Projets/Internes/Operon Pilot/Pilot.md",
      line: 3,
      expectedLine: "- [ ] Legacy task 📅 2026-07-31",
      statusId: "st_project_planned",
    },
  });
  assert.equal(adoptionPlanned.status, "planned");
  assert.equal(state.mutationCalls, 2);
  const replayed = await service.createTask({
    idempotencyKey: "test-create-idempotency",
    dryRun: true,
    task: {
      source: "file",
      description: "Dry run task",
      targetFolder: "Efforts/Projets/Internes/Operon Pilot",
    },
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.operationId, planned.operationId);
  assert.equal(
    state.mutationCalls,
    2,
    "journal replay must not call the Bridge twice",
  );

  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-create-idempotency",
      dryRun: true,
      task: {
        source: "file",
        description: "Different request",
        targetFolder: "Efforts/Projets/Internes/Operon Pilot",
      },
    }),
    (error) => error?.code === "CONFLICT",
  );
  assert.equal(
    state.mutationCalls,
    2,
    "mismatched idempotency reuse must be rejected locally",
  );

  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-apply-opt-in",
      dryRun: false,
      task: {
        source: "file",
        description: "Apply disabled by default",
        targetFolder: "Efforts/Projets/Internes/Operon Pilot",
      },
    }),
    (error) => error?.code === "FORBIDDEN",
  );

  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-scope-traversal",
      dryRun: true,
      task: {
        source: "inline",
        description: "Traversal",
        targetPath: "Efforts/Projets/../../Atlas/Test.md",
      },
    }),
  );
  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-protected-frontmatter",
      dryRun: true,
      task: {
        source: "file",
        description: "Protected property",
        targetFolder: "Efforts/Projets/Internes/Operon Pilot",
        properties: { création: "2020-01-01" },
      },
    }),
    (error) => error?.code === "FORBIDDEN",
  );

  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-scope-outside",
      dryRun: true,
      task: {
        source: "file",
        description: "Outside scope",
        targetFolder: "Atlas",
      },
    }),
    (error) => error?.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-scope-inline",
      dryRun: true,
      task: { source: "inline", description: "No explicit scoped destination" },
    }),
    (error) => error?.code === "FORBIDDEN",
  );
  assert.equal(
    state.mutationCalls,
    2,
    "scope rejection must happen before the Bridge call",
  );

  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-canonical-path-preservation",
      dryRun: false,
      task: {
        source: "inline",
        description: "Must never be normalized into a valid destination",
        targetPath: "Efforts/Projets/Internes/Operon Pilot/Pilot.md ",
      },
    }),
    (error) => error?.name === "ZodError",
  );
  assert.equal(
    state.mutationCalls,
    2,
    "non-canonical paths must be rejected before any Bridge request",
  );

  const scopedInline = await service.createTask({
    idempotencyKey: "test-scope-inline-target",
    dryRun: true,
    task: {
      source: "inline",
      description: "Explicit scoped inline target",
      targetPath: "Efforts/Projets/Internes/Operon Pilot/Pilot.md",
    },
  });
  assert.equal(scopedInline.status, "planned");
  assert.equal(
    state.mutationCalls,
    3,
    "explicit allowed inline target must reach the Bridge",
  );

  // Enable the guarded apply path only for the explicit postflight/recovery
  // checks below; the earlier assertion proves the default remains fail-closed.
  config.operonMutationsEnabled = true;
  config.mcpWriteMode = "guarded";

  const relationshipsInput = {
    idempotencyKey: "test-relationships-apply",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    relationships: { parentTask: null, blocking: ["bcd2345"], blockedBy: [] },
  };
  const relationshipsApplied =
    await service.setRelationships(relationshipsInput);
  assert.equal(relationshipsApplied.status, "applied");
  assert.deepEqual(relationshipsApplied.after.blocking, ["bcd2345"]);
  const callsAfterRelationshipApply = state.mutationCalls;
  const relationshipsRestartReplay = await new OperonService().setRelationships(
    relationshipsInput,
  );
  assert.equal(relationshipsRestartReplay.replayed, true);
  assert.equal(
    state.mutationCalls,
    callsAfterRelationshipApply,
    "relationship replay after restart must use the durable MCP journal",
  );

  await assert.rejects(
    service.updateRecurrence({
      idempotencyKey: "test-recurrence-guarded",
      dryRun: false,
      operonId: "abc1234",
      expectedRevision: tasks[0].revision,
      scope: "this-task",
      changes: { repeat: "mode=schedule|freq=week|interval=1" },
    }),
    (error) => error?.code === "FORBIDDEN",
    "recurrence apply must require full write mode",
  );

  config.mcpWriteMode = "full";

  const recurrenceApplied = await service.updateRecurrence({
    idempotencyKey: "test-recurrence-apply",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    scope: "this-and-following",
    changes: {
      repeat: "mode=schedule|freq=week|interval=1",
      datetimeRepeatEnd: null,
    },
  });
  assert.equal(recurrenceApplied.status, "applied");
  assert.equal(
    recurrenceApplied.after.fields.repeat,
    "mode=schedule|freq=week|interval=1",
  );
  assert.equal(recurrenceApplied.after.recurrence.repeating, true);

  const transitioned = await service.transitionTask({
    idempotencyKey: "test-transition-short-status",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    status: "Done",
  });
  assert.equal(transitioned.status, "applied");
  assert.equal(
    transitioned.after.status,
    "Project.Done",
    "a short status label must be proven against the canonical workflow value",
  );

  const recoveryInput = {
    idempotencyKey: "test-recovery-idempotency",
    recoveryRef: "dvr1_test-recovery-ref",
  };
  const recovered = await service.recoverMutation(recoveryInput);
  assert.equal(recovered.status, "already-applied");
  assert.equal(state.recoveryCalls, 1);
  state.mode = "offline";
  const restartedRecovery = await new OperonService().recoverMutation(
    recoveryInput,
  );
  assert.equal(restartedRecovery.replayed, true);
  assert.equal(
    state.recoveryCalls,
    1,
    "completed recovery must replay from the MCP journal after restart",
  );
  state.mode = "normal";

  const concurrentInput = {
    idempotencyKey: "test-concurrent-idempotency",
    dryRun: true,
    task: {
      source: "file",
      description: "Concurrent dry run",
      targetFolder: "Efforts/Projets/Internes/Operon Pilot",
    },
  };
  const mutationCallsBeforeConcurrent = state.mutationCalls;
  const [concurrentA, concurrentB] = await Promise.all([
    service.createTask(concurrentInput),
    service.createTask(concurrentInput),
  ]);
  assert.equal(concurrentA.operationId, concurrentB.operationId);
  assert.equal(
    state.mutationCalls,
    mutationCallsBeforeConcurrent + 1,
    "concurrent identical requests must share one Bridge operation",
  );

  const interruptedInput = {
    idempotencyKey: "test-restart-uncertain-idempotency",
    dryRun: true,
    task: {
      source: "file",
      description: "Interrupted dry run",
      targetFolder: "Efforts/Projets/Internes/Operon Pilot",
    },
  };
  const interruptedDb = new DatabaseSync(dbPath);
  try {
    interruptedDb
      .prepare(
        "INSERT INTO operon_mutation_journal (" +
          "operation_id, idempotency_key, operon_id, action, requested_json, " +
          "result_json, status, created_at, completed_at" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "pending:" + interruptedInput.idempotencyKey,
        interruptedInput.idempotencyKey,
        null,
        "create",
        stableJson(interruptedInput),
        "null",
        "in_progress",
        Date.now(),
        Date.now(),
      );
  } finally {
    interruptedDb.close();
  }
  const restartedService = new OperonService();
  const callsBeforeRestartRetry = state.mutationCalls;
  await assert.rejects(
    restartedService.createTask(interruptedInput),
    (error) =>
      error?.code === "CONFLICT" && /uncertain outcome/.test(error.message),
  );
  assert.equal(
    state.mutationCalls,
    callsBeforeRestartRetry,
    "restart-safe reservation must block a blind Bridge retry",
  );

  console.log(
    "PASS: Operon snapshot refresh, readiness gating, generation reuse, stale fallback, property gating, duplicate/P0 refusal, pagination/validation drift preservation, short-status postflight, durable recovery replay, scoped mutations, and durable/concurrent mutation idempotency",
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(tempRoot, { recursive: true, force: true });
}
