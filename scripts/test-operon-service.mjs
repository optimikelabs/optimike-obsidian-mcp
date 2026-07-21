import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "optimike-operon-service-"));
const dbPath = path.join(tempRoot, "shared-cache.sqlite");

const capabilities = {
  status: true,
	configuration: true,
  list: true,
  get: true,
  query: true,
  validate: true,
  create: false,
  update: false,
  transition: false,
  convert: false,
};

const semanticConfiguration = {
  language: "fr",
  workflow: { language: "fr", defaultPipelineName: "Project", pipelines: [] },
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
  indexing: { excludedFolders: ["tmp"], fullReindexOnStartup: false, indexEventDebounceMs: 250 },
  docs: { folder: "X/Logiciels/Obsidian/Plugins/Operon/Docs", autoUpdateEnabled: true },
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
    statusLabel: "InProgress",
    pipeline: "Project",
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
    properties: { north_star: operonId === "a" },
    revision: `fnv1a32:${operonId.padEnd(8, "0").slice(0, 8)}`,
    sourceKind: "operon-index",
    operonVersion: "2.4.0",
    bridgeVersion: "0.1.0",
    ...overrides,
  };
}

const tasks = [makeTask("a"), makeTask("b")];
const state = {
  mode: "normal",
  generation: 1,
  statusCalls: 0,
  postCalls: 0,
  validationCalls: 0,
  mutationCalls: 0,
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
    bridge: { id: "optimike-operon-bridge", version: "0.1.0", mode: "read-only" },
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
      ? { ...capabilities, create: true, update: true, transition: true, convert: true }
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
    generation: state.mode === "validation-drift" ? state.generation + 1 : state.generation,
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
        generation: generationDrift && secondPage ? state.generation + 1 : state.generation,
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
if (!address || typeof address === "string") throw new Error("Test server did not bind.");

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_API_KEY = "test-operon-key";
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.OBSIDIAN_VERIFY_SSL = "false";
process.env.OBSIDIAN_VAULT = tempRoot;
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = dbPath;
process.env.MCP_WRITE_MODE = "readonly";
process.env.OPERON_MUTATION_ALLOWED_PATH_PREFIXES = "Efforts/Projets/Internes/Operon Pilot";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { OperonService } = await import("../dist/services/operon/service.js");

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
  assert.equal(state.postCalls, 1, "unchanged generation must not repage all tasks");
  assert.equal(state.validationCalls, 1, "unchanged generation must not rerun full validation");

  const propertyQuery = await service.query({
    propertyEquals: { north_star: true },
    includeProperties: true,
    limit: 10,
  });
  assert.equal(propertyQuery.total, 1);
  assert.equal(propertyQuery.tasks[0].operonId, "a");
  const stripped = await service.query({ operonIds: ["a"], includeProperties: false, limit: 1 });
  assert.equal("properties" in stripped.tasks[0], false);

  state.mode = "offline";
  const offline = await service.ensureSnapshot(false);
  assert.equal(offline.source, "operon-cache");
  assert.equal(offline.stale, true);
  assert.equal(offline.tasks.length, 2);

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
  assert.equal(state.mutationCalls, 1, "journal replay must not call the Bridge twice");

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
  assert.equal(state.mutationCalls, 1, "mismatched idempotency reuse must be rejected locally");

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
  assert.equal(state.mutationCalls, 1, "scope rejection must happen before the Bridge call");

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
  assert.equal(state.mutationCalls, 2, "explicit allowed inline target must reach the Bridge");

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

  console.log(
    "PASS: Operon snapshot refresh, readiness gating, generation reuse, stale fallback, property gating, duplicate/P0 refusal, pagination/validation drift preservation, scoped mutations, and bound/concurrent mutation idempotency",
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(tempRoot, { recursive: true, force: true });
}
