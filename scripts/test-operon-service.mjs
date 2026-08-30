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
const taskWorkflowPlanDigest = "a".repeat(64);
const alternateTaskWorkflowPlanDigest = "b".repeat(64);
const state = {
  mode: "normal",
  generation: 1,
  statusCalls: 0,
  postCalls: 0,
  validationCalls: 0,
  mutationCalls: 0,
  pendingRecoveryCalls: 0,
  recoveryCalls: 0,
  lastTaskWorkflowRecoveryBody: null,
  mutations: false,
  bridgeModeOverride: null,
  omitMutationsEnabled: false,
  workflowCold: false,
  filterCold: false,
  workflowGrantPending: false,
  preDispatchUpdatePending: false,
  preDispatchReceiptOverride: null,
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
    lifecycle: {
      state: "ready",
      running: true,
      mountGeneration: 2,
      unloadGeneration: 1,
      consecutiveFailures: 0,
      nextProbeDelayMs: 1_000,
    },
    bridge: {
      id: "optimike-operon-bridge",
      version: "0.1.0",
      mode:
        state.bridgeModeOverride ??
        (state.mutations ? "read-write" : "read-only"),
      ...(state.omitMutationsEnabled
        ? {}
        : { mutationsEnabled: state.mutations }),
    },
    operon: {
      present: state.mode !== "absent",
      version: "2.4.0",
      compatible: state.mode !== "incompatible",
      compatibilityState:
        state.mode === "incompatible" ? "incompatible" : "certified",
      compatibilityAdmission:
        state.mode === "incompatible" ? "none" : "legacy-version",
      compatibilityReason:
        state.mode === "incompatible"
          ? "Incompatible fixture runtime."
          : "Certified fixture runtime.",
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
    capabilities:
      state.mode === "missing-read-capability"
        ? { ...capabilities, list: false }
        : state.mutations
          ? {
              ...capabilities,
              filterQuery: !state.filterCold,
              adopt: !state.workflowCold,
              periodicCreate: !state.workflowCold,
              periodicUpdate: !state.workflowCold,
              taskWorkflowRecovery: !state.workflowCold,
              create: true,
              update: true,
              transition: true,
              relationshipMutation: true,
              recurrenceMutation: true,
              convert: true,
              recovery: true,
            }
          : { ...capabilities, filterQuery: !state.filterCold },
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
  if (request.method === "GET" && url.pathname.endsWith("/recovery-status")) {
    const status = statusPayload();
    sendJson(response, 200, {
      ok:
        status.operon.compatible &&
        (status.capabilities.recovery ||
          status.capabilities.taskWorkflowRecovery),
      contractVersion: "1",
      bridge: {
        id: status.bridge.id,
        version: status.bridge.version,
      },
      operon: {
        present: status.operon.present,
        version: status.operon.version,
        compatible: status.operon.compatible,
      },
      capabilities: {
        recovery: status.capabilities.recovery,
        taskWorkflowRecovery: status.capabilities.taskWorkflowRecovery,
      },
      source: "operon-runtime",
      stale: false,
    });
    return;
  }
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
    request.method === "GET" &&
    url.pathname.endsWith("/mutations/pending-recoveries")
  ) {
    state.pendingRecoveryCalls += 1;
    sendJson(response, 200, {
      ok: true,
      contractVersion: "1",
      source: "operon-live",
      stale: false,
      recoveries: [{ recoveryRef: "legacy-recovery" }],
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
      if (state.preDispatchReceiptOverride) {
        sendJson(response, 503, state.preDispatchReceiptOverride(params));
        return;
      }
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-recovery-${state.recoveryCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: "already-applied",
        before: null,
        requested: { recoveryRef: params.recoveryRef },
        after: null,
        planDigest: "d".repeat(64),
        recoveryRef: params.recoveryRef,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname.endsWith("/task-workflows/pending-recoveries")
  ) {
    state.pendingRecoveryCalls += 1;
    sendJson(response, 200, {
      ok: true,
      contractVersion: "1",
      source: "operon-live",
      stale: false,
      recoveries: [
        {
          ...(url.searchParams.get("kind")
            ? { kind: url.searchParams.get("kind") }
            : { workflowKind: "periodic-update" }),
          planDigest: taskWorkflowPlanDigest,
        },
      ],
    });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname.endsWith("/task-workflows/recover")
  ) {
    state.recoveryCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      if (state.preDispatchReceiptOverride) {
        sendJson(response, 503, state.preDispatchReceiptOverride(params));
        return;
      }
      state.lastTaskWorkflowRecoveryBody = params;
      const nativeProof = {
        contractVersion: 1,
        kind: "mutation-result",
        status:
          params.idempotencyKey === "test-workflow-recovery-malformed"
            ? "committed"
            : "already-applied",
        mutationMayHaveApplied: true,
        retryAllowed: false,
        groupResults: [],
        receipt: {
          contractVersion: 1,
          planDigest: params.planDigest,
          mutationKind: "task.update",
          targetDigest: "c".repeat(64),
          terminalOutcome: "already-applied",
          effectiveAt: "2026-08-24T08:00:00.000Z",
          completedAt: "2026-08-24T08:00:01.000Z",
          expiresAt: "2026-08-24T09:00:01.000Z",
        },
        postflight: { status: "receipt-replay" },
      };
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-workflow-recovery-${state.recoveryCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: "already-applied",
        before: null,
        requested: { recoveryRef: params.recoveryRef, kind: params.kind },
        after: null,
        recoveryRef: params.recoveryRef,
        nativeProof,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/tasks/periodic")) {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      if (state.workflowGrantPending) {
        sendJson(response, 503, {
          ok: false,
          contractVersion: "1",
          operationId: "2d50a121-7d6e-43ad-895d-2f8772d4a6dd",
          idempotencyKey: params.idempotencyKey,
          status: "not-ready",
          requested: {},
          error: {
            code: "task_workflow_capability_unavailable",
            reasonCode: "workflow_capability_unavailable",
            message: "The exact periodic-create grant is pending.",
          },
          retryable: true,
          mutationMayHaveApplied: false,
          source: "operon-live",
          stale: false,
        });
        return;
      }
      state.mutationCalls += 1;
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-periodic-create-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: params.dryRun === false ? "applied" : "planned",
        before: null,
        requested: params.periodic,
        after:
          params.dryRun === false
            ? makeTask("per1234", {
                description: params.periodic.description,
                fields: params.periodic.fields ?? {},
                // Operon owns periodic routing. Keep the result outside the
                // configured-prefix fixture: scoped apply must be rejected
                // before POST, while unscoped apply still validates the
                // returned canonical vault-relative path.
                path: "Periodic/Daily/2026-08-24.md",
              })
            : null,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (
    request.method === "POST" &&
    /\/tasks\/([^/]+)\/periodic-update$/u.test(url.pathname)
  ) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      const operonId =
        /\/tasks\/([^/]+)\/periodic-update$/u.exec(url.pathname)?.[1] ??
        "abc1234";
      const before = tasks[0];
      const scheduled = params.patch.fields.dateScheduled;
      const after = makeTask(operonId, {
        dates: { ...before.dates, scheduled },
        fields: {
          ...before.fields,
          ...(scheduled === null ? {} : { dateScheduled: scheduled }),
        },
      });
      if (scheduled === null) delete after.fields.dateScheduled;
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-periodic-update-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: params.dryRun === false ? "applied" : "planned",
        before,
        requested: params.patch,
        after: params.dryRun === false ? after : null,
        source: "operon-live",
        stale: false,
      });
    });
    return;
  }
  if (
    request.method === "POST" &&
    /\/tasks\/([^/]+)\/update$/u.test(url.pathname)
  ) {
    state.mutationCalls += 1;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const params = body ? JSON.parse(body) : {};
      const operonId =
        /\/tasks\/([^/]+)\/update$/u.exec(url.pathname)?.[1] ?? "abc1234";
      if (state.preDispatchReceiptOverride) {
        sendJson(response, 503, state.preDispatchReceiptOverride(params));
        return;
      }
      if (state.preDispatchUpdatePending) {
        sendJson(response, 503, {
          ok: false,
          contractVersion: "1",
          operationId: "0a7f1eb6-529a-4dd2-861c-9152e6054ff0",
          idempotencyKey: params.idempotencyKey,
          status: "not-ready",
          requested: {},
          retryable: true,
          mutationMayHaveApplied: false,
          source: "operon-live",
          stale: false,
          error: {
            code: "operon_index_not_settled",
            reasonCode: "index_not_settled",
            message:
              "The Operon live index is not settled yet; retry the mutation.",
          },
        });
        return;
      }
      if (params.idempotencyKey === "test-public-outcome-unknown") {
        sendJson(response, 500, {
          // This is the exact safe shape produced by the Bridge's public
          // mutation-failure projection: correlations/recovery survive, while
          // the failed request itself is deliberately opaque.
          ok: false,
          contractVersion: "1",
          operationId: "9db2462c-3fc1-4e68-8e10-2a119dd9bd4f",
          idempotencyKey: params.idempotencyKey,
          status: "outcome-unknown",
          requested: {},
          retryable: false,
          mutationMayHaveApplied: true,
          recoveryRequired: true,
          recoveryRef: `dvr1_${"f".repeat(48)}`,
          planDigest: "e".repeat(64),
          source: "operon-live",
          stale: false,
          error: {
            code: "outcome_unverified",
            reasonCode: "outcome_unverified",
            message:
              "The mutation outcome could not be verified. Use the recovery reference before retrying.",
          },
        });
        return;
      }
      const requestedFields = params.patch.fields ?? {};
      const fields = { ...tasks[0].fields, ...requestedFields };
      if (
        state.mode === "gallery-reordered" &&
        Array.isArray(fields.taskGallery)
      ) {
        fields.taskGallery = [...fields.taskGallery].reverse();
      }
      sendJson(response, 200, {
        ok: true,
        contractVersion: "1",
        operationId: `operation-update-${state.mutationCalls}`,
        idempotencyKey: params.idempotencyKey,
        status: params.dryRun === false ? "applied" : "planned",
        before: tasks[0],
        requested: params.patch,
        after: params.dryRun === false ? makeTask(operonId, { fields }) : null,
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
      const repeating =
        typeof fields.repeat === "string" && fields.repeat.length > 0;
      const after = makeTask(operonId, {
        fields,
        recurrence: {
          repeating,
          seriesId: repeating ? "rsabc12" : null,
          occurrenceDate: repeating
            ? (fields.dateScheduled ?? "2026-08-10")
            : null,
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

  state.mode = "initializing";
  const initializingStatus = await service.status();
  assert.equal(initializingStatus.ok, false);
  assert.equal(initializingStatus.source, "operon-live");
  assert.equal(initializingStatus.live.lifecycle.state, "ready");
  assert.equal(initializingStatus.live.index.ready, false);

  state.mode = "duplicate";
  const duplicateStatus = await service.status();
  assert.equal(duplicateStatus.ok, false);
  assert.equal(duplicateStatus.source, "operon-live");
  assert.equal(duplicateStatus.stale, false);
  assert.equal(duplicateStatus.live.ok, true);
  assert.equal(duplicateStatus.live.index.duplicateConflictCount, 1);

  state.mode = "missing-read-capability";
  const missingReadCapabilityStatus = await service.status();
  assert.equal(missingReadCapabilityStatus.ok, false);
  assert.equal(missingReadCapabilityStatus.source, "operon-live");
  assert.equal(missingReadCapabilityStatus.stale, false);
  assert.equal(missingReadCapabilityStatus.live.capabilities.list, false);
  state.mode = "normal";

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

  state.filterCold = true;
  const firstFilterPage = await service.querySavedFilter({
    filterSetId: "elysia-now",
    limit: 1,
  });
  assert.equal(firstFilterPage.count, 1);
  assert.equal(firstFilterPage.hasMore, true);
  assert.equal(firstFilterPage.tasks[0].operonId, "abc1234");
  assert.equal(
    firstFilterPage.capabilities.filterQuery,
    true,
    "a successful exact negotiation must override the preceding cold snapshot",
  );
  state.filterCold = false;
  const secondFilterPage = await service.querySavedFilter({
    filterSetId: "elysia-now",
    limit: 1,
    cursor: firstFilterPage.nextCursor,
  });
  assert.equal(secondFilterPage.count, 1);
  assert.equal(secondFilterPage.hasMore, false);
  assert.equal(secondFilterPage.tasks[0].operonId, "bcd2345");
  await assert.rejects(
    () => service.querySavedFilter({ filterSetId: "missing-filter", limit: 1 }),
    (error) =>
      error?.code === "NOT_FOUND" &&
      error?.message ===
        "The requested Operon Bridge resource was not found." &&
      error?.details?.httpStatus === 404 &&
      error?.details?.reasonCode === "OPERON_BRIDGE_RESOURCE_NOT_FOUND" &&
      error?.details?.hasBridgeCode === true,
  );
  await assert.rejects(
    () => service.querySavedFilter({ filterSetId: "invalid-filter", limit: 1 }),
    (error) =>
      error?.code === "VALIDATION_ERROR" &&
      error?.message === "The Operon Bridge rejected the request." &&
      error?.details?.httpStatus === 422 &&
      error?.details?.reasonCode === "OPERON_BRIDGE_REQUEST_INVALID" &&
      error?.details?.hasBridgeCode === true,
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
  const periodicPlanned = await service.createPeriodicTask({
    idempotencyKey: "test-periodic-create-idempotency",
    dryRun: true,
    periodic: {
      description: "Daily task through sealed routing",
      periodicKind: "daily",
      routeDate: "2026-08-23",
      fields: { taskGallery: ["media/a,b.png", "media/c;d.png"] },
    },
  });
  assert.equal(periodicPlanned.status, "planned");
  assert.equal(state.mutationCalls, 3);

  state.workflowCold = true;
  const coldPeriodicPlanned = await service.createPeriodicTask({
    idempotencyKey: "test-periodic-create-cold-idempotency",
    dryRun: true,
    periodic: {
      description: "Cold Daily grant negotiation",
      periodicKind: "daily",
      routeDate: "2026-08-23",
    },
  });
  assert.equal(coldPeriodicPlanned.status, "planned");
  assert.equal(
    state.mutationCalls,
    4,
    "an additive task-workflow route must reach the Bridge when status is cold",
  );
  state.workflowCold = false;
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
    4,
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
    4,
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
    4,
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
    4,
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
    5,
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

  const configuredMutationPrefixes = [
    ...config.operonMutationAllowedPathPrefixes,
  ];
  const callsBeforeScopedPeriodicApply = state.mutationCalls;
  await assert.rejects(
    service.createPeriodicTask({
      idempotencyKey: "test-periodic-create-guarded-configured-prefixes",
      dryRun: false,
      periodic: {
        description: "Daily task with opaque Operon routing",
        periodicKind: "daily",
        routeDate: "2026-08-24",
      },
    }),
    (error) =>
      error?.code === "FORBIDDEN" &&
      /requires verifiable route evidence/u.test(error.message),
    "guarded periodic apply must fail closed when configured prefixes cannot be checked against route evidence",
  );
  assert.equal(
    state.mutationCalls,
    callsBeforeScopedPeriodicApply,
    "scoped periodic apply must be rejected before the Bridge POST",
  );

  config.operonMutationAllowedPathPrefixes = [];
  const guardedPeriodicWithoutPrefixes = await service.createPeriodicTask({
    idempotencyKey: "test-periodic-create-guarded-empty-prefixes",
    dryRun: false,
    periodic: {
      description: "Weekly task with Operon-owned routing",
      periodicKind: "weekly",
      routeDate: "2026-08-24",
    },
  });
  assert.equal(guardedPeriodicWithoutPrefixes.status, "applied");
  assert.equal(
    guardedPeriodicWithoutPrefixes.after.path,
    "Periodic/Daily/2026-08-24.md",
    "guarded periodic creation must not require arbitrary path prefixes",
  );
  config.operonMutationAllowedPathPrefixes = configuredMutationPrefixes;

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

  // A public Bridge failure must remain a terminal MCP receipt (not a parsing
  // error), replay by its original mutation key, and retain enough evidence
  // for a separate durable recovery request.
  config.operonMutationAllowedPathPrefixes = [];
  const publicFailureInput = {
    idempotencyKey: "test-public-outcome-unknown",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    patch: { fields: { priority: "B" } },
  };
  const mutationCallsBeforePublicFailure = state.mutationCalls;
  const publicFailure = await service.updateTask(publicFailureInput);
  assert.equal(publicFailure.ok, false);
  assert.equal(publicFailure.status, "outcome-unknown");
  assert.equal(publicFailure.idempotencyKey, publicFailureInput.idempotencyKey);
  assert.deepEqual(publicFailure.requested, {});
  assert.equal(publicFailure.mutationMayHaveApplied, true);
  assert.equal(publicFailure.recoveryRequired, true);
  assert.equal(publicFailure.planDigest, "e".repeat(64));
  assert.equal(publicFailure.recoveryRef, `dvr1_${"f".repeat(48)}`);
  const publicFailureDb = new DatabaseSync(dbPath);
  try {
    const entry = publicFailureDb
      .prepare(
        "SELECT status FROM operon_mutation_journal WHERE idempotency_key = ?",
      )
      .get(publicFailureInput.idempotencyKey);
    assert.equal(
      entry?.status,
      "outcome-unknown",
      "a post-dispatch uncertainty must remain journaled for replay/recovery",
    );
  } finally {
    publicFailureDb.close();
  }
  const publicFailureReplay = await new OperonService().updateTask(
    publicFailureInput,
  );
  assert.equal(publicFailureReplay.replayed, true);
  assert.equal(publicFailureReplay.status, "outcome-unknown");
  assert.equal(
    state.mutationCalls,
    mutationCallsBeforePublicFailure + 1,
    "an outcome-unknown failure must replay from the durable MCP journal",
  );
  const publicFailureRecovery = await service.recoverMutation({
    idempotencyKey: "test-public-outcome-recovery",
    recoveryRef: publicFailure.recoveryRef,
    recovery: { kind: "developer-api" },
  });
  assert.equal(publicFailureRecovery.status, "already-applied");
  assert.equal(
    publicFailureRecovery.recoveryRef,
    publicFailure.recoveryRef,
    "the public failure recovery reference must reach the recovery route",
  );

  // The durable target is intentionally separate from requested intent here.
  // This models journal rows written by callers that pass task identity via
  // the route rather than duplicating it in the request body.
  const journalTargetA = "abc1234";
  const journalTargetB = "bcd2345";
  const sameTargetIndependentIntent = {
    dryRun: false,
    expectedRevision: tasks[0].revision,
    patch: { fields: { priority: "B" } },
  };
  const executeTargetIntent = (instance, operonId, idempotencyKey) =>
    instance.executeMutation(
      "update",
      operonId,
      idempotencyKey,
      false,
      `/extensions/optimike-operon-bridge/v1/tasks/${operonId}/update`,
      { idempotencyKey, ...sameTargetIndependentIntent },
    );
  const readJournalTarget = (idempotencyKey) => {
    const db = new DatabaseSync(dbPath);
    try {
      return db
        .prepare(
          `SELECT operon_id as operonId, status
           FROM operon_mutation_journal WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey);
    } finally {
      db.close();
    }
  };

  const terminalTargetKey = "test-idempotency-target-terminal";
  const callsBeforeTargetTerminal = state.mutationCalls;
  const terminalTargetA = await executeTargetIntent(
    service,
    journalTargetA,
    terminalTargetKey,
  );
  await assert.rejects(
    executeTargetIntent(new OperonService(), journalTargetB, terminalTargetKey),
    (error) => error?.code === "CONFLICT",
    "a terminal Task A result must not replay for Task B with the same intent",
  );
  assert.equal(
    state.mutationCalls,
    callsBeforeTargetTerminal + 1,
    "a target-mismatched terminal replay must not mutate Task B",
  );
  assert.equal(terminalTargetA.after.operonId, journalTargetA);

  const inProgressTargetKey = "test-idempotency-target-in-progress";
  const journalService = service;
  assert.equal(
    journalService.reserveMutationJournal(
      "update",
      journalTargetA,
      inProgressTargetKey,
      { idempotencyKey: inProgressTargetKey, ...sameTargetIndependentIntent },
    ),
    null,
  );
  const callsBeforeTargetInProgress = state.mutationCalls;
  await assert.rejects(
    executeTargetIntent(
      new OperonService(),
      journalTargetB,
      inProgressTargetKey,
    ),
    (error) => error?.code === "CONFLICT",
    "a concurrent Task B request must not join Task A's in-progress reservation",
  );
  assert.equal(state.mutationCalls, callsBeforeTargetInProgress);

  const preDispatchTargetKey = "test-idempotency-target-pre-dispatch";
  const preDispatchTargetIntent = {
    idempotencyKey: preDispatchTargetKey,
    ...sameTargetIndependentIntent,
  };
  assert.equal(
    journalService.reserveMutationJournal(
      "update",
      journalTargetA,
      preDispatchTargetKey,
      preDispatchTargetIntent,
    ),
    null,
  );
  assert.equal(
    journalService.releasePreDispatchMutationReservation(
      "transition",
      journalTargetA,
      preDispatchTargetKey,
      preDispatchTargetIntent,
    ),
    false,
    "a mismatched action must not release another mutation reservation",
  );
  assert.equal(
    journalService.releasePreDispatchMutationReservation(
      "update",
      journalTargetA,
      preDispatchTargetKey,
      {
        ...preDispatchTargetIntent,
        patch: { fields: { priority: "C" } },
      },
    ),
    false,
    "a mismatched intent must not release another mutation reservation",
  );
  assert.equal(
    journalService.releasePreDispatchMutationReservation(
      "update",
      journalTargetB,
      preDispatchTargetKey,
      preDispatchTargetIntent,
    ),
    false,
    "a Task B pre-dispatch release must not delete Task A's reservation",
  );
  assert.equal(
    readJournalTarget(preDispatchTargetKey)?.operonId,
    journalTargetA,
  );
  assert.equal(readJournalTarget(preDispatchTargetKey)?.status, "in_progress");
  assert.equal(
    journalService.releasePreDispatchMutationReservation(
      "update",
      journalTargetA,
      preDispatchTargetKey,
      preDispatchTargetIntent,
    ),
    true,
  );

  const finalizationTargetKey = "test-idempotency-target-finalization";
  const finalizationTargetIntent = {
    idempotencyKey: finalizationTargetKey,
    ...sameTargetIndependentIntent,
  };
  assert.equal(
    journalService.reserveMutationJournal(
      "update",
      journalTargetA,
      finalizationTargetKey,
      finalizationTargetIntent,
    ),
    null,
  );
  const finalizationTargetResult = {
    ...terminalTargetA,
    operationId: "operation-target-finalization",
    idempotencyKey: finalizationTargetKey,
  };
  assert.throws(
    () =>
      journalService.writeMutationJournal(
        "transition",
        journalTargetA,
        finalizationTargetIntent,
        finalizationTargetResult,
      ),
    (error) => error?.code === "CONFLICT",
    "a mismatched action must not finalize another mutation reservation",
  );
  assert.throws(
    () =>
      journalService.writeMutationJournal(
        "update",
        journalTargetA,
        {
          ...finalizationTargetIntent,
          patch: { fields: { priority: "C" } },
        },
        finalizationTargetResult,
      ),
    (error) => error?.code === "CONFLICT",
    "a mismatched intent must not finalize another mutation reservation",
  );
  assert.throws(
    () =>
      journalService.writeMutationJournal(
        "update",
        journalTargetB,
        finalizationTargetIntent,
        finalizationTargetResult,
      ),
    (error) => error?.code === "CONFLICT",
    "a Task B finalization must not complete Task A's reservation",
  );
  assert.equal(
    readJournalTarget(finalizationTargetKey)?.operonId,
    journalTargetA,
  );
  assert.equal(readJournalTarget(finalizationTargetKey)?.status, "in_progress");
  journalService.writeMutationJournal(
    "update",
    journalTargetA,
    finalizationTargetIntent,
    finalizationTargetResult,
  );

  const restartTargetKey = "test-idempotency-target-restart";
  await executeTargetIntent(service, journalTargetA, restartTargetKey);
  const callsBeforeTargetRestart = state.mutationCalls;
  await assert.rejects(
    executeTargetIntent(new OperonService(), journalTargetB, restartTargetKey),
    (error) => error?.code === "CONFLICT",
    "a restarted service must retain the durable task identity fence",
  );
  assert.equal(
    state.mutationCalls,
    callsBeforeTargetRestart,
    "a restarted target-mismatched replay must not mutate Task B",
  );
  config.operonMutationAllowedPathPrefixes = configuredMutationPrefixes;

  const preDispatchInput = {
    idempotencyKey: "test-pre-dispatch-update-same-key",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    patch: { fields: { priority: "B" } },
  };
  const callsBeforePreDispatch = state.mutationCalls;
  state.preDispatchUpdatePending = true;
  await assert.rejects(
    service.updateTask(preDispatchInput),
    (error) =>
      error?.code === "SERVICE_UNAVAILABLE" &&
      /live index is not settled/u.test(error.message) &&
      error?.details?.preDispatchReason === "operon_index_not_settled",
  );
  assert.equal(state.mutationCalls, callsBeforePreDispatch + 1);
  const preDispatchDb = new DatabaseSync(dbPath);
  try {
    const entry = preDispatchDb
      .prepare(
        "SELECT status FROM operon_mutation_journal WHERE idempotency_key = ?",
      )
      .get(preDispatchInput.idempotencyKey);
    assert.equal(
      entry,
      undefined,
      "pre-dispatch failures must not strand a journal row",
    );
  } finally {
    preDispatchDb.close();
  }
  state.preDispatchUpdatePending = false;
  const preDispatchReplay = await service.updateTask(preDispatchInput);
  assert.equal(preDispatchReplay.status, "applied");
  assert.equal(
    state.mutationCalls,
    callsBeforePreDispatch + 2,
    "the same key must reach the Bridge again after a proven pre-dispatch failure",
  );

  const preDispatchReceipt = (params, overrides = {}) => ({
    ok: false,
    contractVersion: "1",
    operationId: "5e4a9e98-1a59-4db6-9c91-2d8a0f9f6b48",
    idempotencyKey: params.idempotencyKey,
    status: "not-ready",
    requested: {},
    retryable: true,
    mutationMayHaveApplied: false,
    source: "operon-live",
    stale: false,
    error: {
      code: "operon_index_not_settled",
      reasonCode: "index_not_settled",
      message: "The Operon live index is not settled yet; retry the mutation.",
    },
    ...overrides,
  });
  const readJournalStatus = (idempotencyKey) => {
    const db = new DatabaseSync(dbPath);
    try {
      return db
        .prepare(
          "SELECT status FROM operon_mutation_journal WHERE idempotency_key = ?",
        )
        .get(idempotencyKey)?.status;
    } finally {
      db.close();
    }
  };
  const prefixesBeforePreDispatchRecovery = [
    ...config.operonMutationAllowedPathPrefixes,
  ];
  config.operonMutationAllowedPathPrefixes = [];

  const developerRecoveryPreDispatch = {
    idempotencyKey: "test-recovery-pre-dispatch-same-key",
    recoveryRef: `dvr1_${"9".repeat(48)}`,
    recovery: { kind: "developer-api" },
  };
  state.preDispatchReceiptOverride = (params) => preDispatchReceipt(params);
  await assert.rejects(
    service.recoverMutation(developerRecoveryPreDispatch),
    (error) =>
      error?.code === "SERVICE_UNAVAILABLE" &&
      error?.details?.preDispatch === true,
  );
  assert.equal(
    readJournalStatus(developerRecoveryPreDispatch.idempotencyKey),
    undefined,
    "a proven recovery pre-dispatch failure must release its journal row",
  );
  state.preDispatchReceiptOverride = null;
  const developerRecoveryReplay = await service.recoverMutation(
    developerRecoveryPreDispatch,
  );
  assert.equal(developerRecoveryReplay.status, "already-applied");

  const workflowRecoveryPreDispatch = {
    idempotencyKey: "test-workflow-recovery-pre-dispatch-same-key",
    recoveryRef: `dvr1_${"8".repeat(48)}`,
    recovery: {
      kind: "periodic-update",
      planDigest: taskWorkflowPlanDigest,
    },
  };
  state.preDispatchReceiptOverride = (params) => preDispatchReceipt(params);
  await assert.rejects(
    service.recoverMutation(workflowRecoveryPreDispatch),
    (error) =>
      error?.code === "SERVICE_UNAVAILABLE" &&
      error?.details?.preDispatchReason === "operon_index_not_settled",
  );
  assert.equal(
    readJournalStatus(workflowRecoveryPreDispatch.idempotencyKey),
    undefined,
    "a proven workflow-recovery pre-dispatch failure must release its journal row",
  );
  state.preDispatchReceiptOverride = null;
  const workflowRecoveryReplay = await service.recoverMutation(
    workflowRecoveryPreDispatch,
  );
  assert.equal(workflowRecoveryReplay.status, "already-applied");

  const hostilePreDispatchCases = [
    ["wrong-key", { idempotencyKey: "other-key" }],
    ["wrong-version", { contractVersion: "2" }],
    ["wrong-status", { status: "outcome-unknown" }],
    ["wrong-code", { error: { code: "unapproved", message: "ignored" } }],
    ["wrong-retryable", { retryable: false }],
    ["recovery-evidence", { recoveryRef: `dvr1_${"7".repeat(48)}` }],
    ["malformed-shape", { requested: { unexpected: true } }],
  ];
  for (const [name, overrides] of hostilePreDispatchCases) {
    const idempotencyKey = `test-hostile-pre-dispatch-${name}`;
    state.preDispatchReceiptOverride = (params) =>
      preDispatchReceipt(params, overrides);
    await assert.rejects(
      service.updateTask({
        idempotencyKey,
        dryRun: false,
        operonId: "abc1234",
        expectedRevision: tasks[0].revision,
        patch: { fields: { priority: "B" } },
      }),
      (error) => error?.code === "PARSING_ERROR",
      `${name} must not be accepted as pre-dispatch proof`,
    );
    assert.equal(
      readJournalStatus(idempotencyKey),
      "in_progress",
      `${name} must preserve the uncertain MCP reservation`,
    );
  }
  state.preDispatchReceiptOverride = null;

  const hostileRecoveryKey = "test-hostile-recovery-pre-dispatch";
  state.preDispatchReceiptOverride = (params) =>
    preDispatchReceipt(params, { idempotencyKey: "misrouted-recovery-key" });
  await assert.rejects(
    service.recoverMutation({
      idempotencyKey: hostileRecoveryKey,
      recoveryRef: `dvr1_${"6".repeat(48)}`,
      recovery: { kind: "developer-api" },
    }),
    (error) => error?.code === "PARSING_ERROR",
  );
  assert.equal(
    readJournalStatus(hostileRecoveryKey),
    "in_progress",
    "a misrouted recovery receipt must not release the recovery journal",
  );
  state.preDispatchReceiptOverride = null;
  config.operonMutationAllowedPathPrefixes = prefixesBeforePreDispatchRecovery;

  const orderedGallery = ["media/a,b.png", "media\\c;d.png", "media/a,b.png"];
  const normalizedOrderedGallery = ["media/a,b.png", "media\\c;d.png"];
  const galleryApplied = await service.updateTask({
    idempotencyKey: "test-gallery-ordered-apply",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    patch: { fields: { taskGallery: orderedGallery } },
  });
  assert.deepEqual(
    galleryApplied.after.fields.taskGallery,
    normalizedOrderedGallery,
    "MCP must preserve list punctuation/order and apply Operon's first-occurrence deduplication",
  );

  state.mode = "gallery-reordered";
  await assert.rejects(
    service.updateTask({
      idempotencyKey: "test-gallery-reordered-conflict",
      dryRun: false,
      operonId: "abc1234",
      expectedRevision: tasks[0].revision,
      patch: { fields: { taskGallery: orderedGallery } },
    }),
    (error) =>
      error?.code === "CONFLICT" && /value or order/u.test(error.message),
    "MCP postflight must reject a reordered taskGallery",
  );
  state.mode = "normal";

  const mutationCallsBeforeScheduledDateExclusivity = state.mutationCalls;
  await assert.rejects(
    service.createTask({
      idempotencyKey: "test-create-scheduled-date-rejected",
      dryRun: false,
      task: {
        source: "inline",
        description: "Scheduled task must use the periodic update workflow",
        fields: { dateScheduled: "2026-08-30" },
      },
    }),
    /dateScheduled.*operon_update_periodic_scheduling/u,
    "task creation must reject dateScheduled before any Bridge POST",
  );
  await assert.rejects(
    service.updateRecurrence({
      idempotencyKey: "test-recurrence-scheduled-date-rejected",
      dryRun: false,
      operonId: "abc1234",
      expectedRevision: tasks[0].revision,
      scope: "this-task",
      changes: { dateScheduled: "2026-08-30" },
    }),
    /Unrecognized key/u,
    "recurrence updates must reject dateScheduled before any Bridge POST",
  );
  await assert.rejects(
    service.updateTask({
      idempotencyKey: "test-update-scheduled-date-rejected",
      dryRun: false,
      operonId: "abc1234",
      expectedRevision: tasks[0].revision,
      patch: { fields: { dateScheduled: "2026-08-30" } },
    }),
    /dateScheduled.*operon_update_periodic_scheduling/u,
    "generic updates must reject dateScheduled before any Bridge POST",
  );
  assert.equal(
    state.mutationCalls,
    mutationCallsBeforeScheduledDateExclusivity,
    "non-periodic dateScheduled inputs must not reach the Bridge",
  );

  const periodicUpdated = await service.updatePeriodicScheduling({
    idempotencyKey: "test-periodic-update-apply",
    dryRun: false,
    operonId: "abc1234",
    expectedRevision: tasks[0].revision,
    patch: { fields: { dateScheduled: "2026-08-30" } },
  });
  assert.equal(periodicUpdated.after.dates.scheduled, "2026-08-30");
  assert.equal(
    state.mutationCalls,
    mutationCallsBeforeScheduledDateExclusivity + 1,
    "only periodic scheduling may send a dateScheduled update to the Bridge",
  );

  const pendingCallsBeforeScopedRecovery = state.pendingRecoveryCalls;
  const recoveryCallsBeforeScopedRecovery = state.recoveryCalls;
  await assert.rejects(
    service.pendingRecoveries({ kind: "periodic-update" }),
    (error) =>
      error?.code === "FORBIDDEN" &&
      /do not expose canonical route evidence/u.test(error.message),
    "configured path prefixes must hide recovery references whose route cannot be proven",
  );
  await assert.rejects(
    service.recoverMutation({
      idempotencyKey: "test-scoped-recovery-bypass",
      recoveryRef: "dvr1_scoped-recovery-bypass",
      recovery: {
        kind: "periodic-update",
        planDigest: taskWorkflowPlanDigest,
      },
    }),
    (error) =>
      error?.code === "FORBIDDEN" &&
      /before listing, replay, or Bridge apply/u.test(error.message),
    "configured path prefixes must fail closed before recovery can reach the durable replay or Bridge",
  );
  assert.equal(state.pendingRecoveryCalls, pendingCallsBeforeScopedRecovery);
  assert.equal(state.recoveryCalls, recoveryCallsBeforeScopedRecovery);

  config.operonMutationAllowedPathPrefixes = [];

  const workflowRecoveries = await service.pendingRecoveries({
    kind: "periodic-update",
  });
  assert.equal(workflowRecoveries.recoveries[0].kind, "periodic-update");
  assert.equal(
    workflowRecoveries.recoveries[0].planDigest,
    taskWorkflowPlanDigest,
  );
  assert.equal(
    workflowRecoveries.recoveries[0].recoveryFamily,
    "task-workflow",
  );
  const allRecoveries = await service.pendingRecoveries();
  assert.deepEqual(
    allRecoveries.recoveries.map((entry) => entry.recoveryFamily),
    ["developer-api", "task-workflow"],
    "unfiltered recovery listing must aggregate legacy and task-workflow families",
  );
  assert.deepEqual(
    allRecoveries.recoveries.map((entry) => entry.kind),
    ["developer-api", "periodic-update"],
    "every pending recovery must expose the exact required recover kind without caller inference",
  );

  state.mode = "initializing";
  const unsettledRecoveries = await service.pendingRecoveries({
    kind: "periodic-update",
  });
  assert.equal(
    unsettledRecoveries.recoveries[0].kind,
    "periodic-update",
    "pending recovery must remain reachable while the live index is unsettled",
  );
  const unsettledRecovered = await service.recoverMutation({
    idempotencyKey: "test-unsettled-workflow-recovery",
    recoveryRef: "dvr1_unsettled-workflow-recovery",
    recovery: {
      kind: "periodic-update",
      planDigest: taskWorkflowPlanDigest,
    },
  });
  assert.equal(unsettledRecovered.status, "already-applied");
  state.mode = "normal";

  const workflowRecovered = await service.recoverMutation({
    idempotencyKey: "test-workflow-recovery",
    recoveryRef: "dvr1_workflow-recovery",
    recovery: {
      kind: "periodic-update",
      planDigest: taskWorkflowPlanDigest,
    },
  });
  assert.equal(workflowRecovered.status, "already-applied");
  assert.equal(
    state.lastTaskWorkflowRecoveryBody.planDigest,
    taskWorkflowPlanDigest,
    "task-workflow recovery must forward only the caller-provided pending plan digest",
  );
  assert.equal(
    workflowRecovered.nativeProof.receipt.planDigest,
    taskWorkflowPlanDigest,
    "the validated native receipt proof must survive the MCP boundary",
  );
  const recoveryCallsAfterBoundWorkflow = state.recoveryCalls;
  await assert.rejects(
    service.recoverMutation({
      idempotencyKey: "test-workflow-recovery",
      recoveryRef: "dvr1_workflow-recovery",
      recovery: {
        kind: "periodic-update",
        planDigest: alternateTaskWorkflowPlanDigest,
      },
    }),
    (error) => error?.code === "CONFLICT",
    "the durable idempotency binding must reject a different digest for the same recovery request",
  );
  assert.equal(
    state.recoveryCalls,
    recoveryCallsAfterBoundWorkflow,
    "a digest substitution must be rejected before the Bridge POST",
  );
  await assert.rejects(
    service.recoverMutation({
      idempotencyKey: "test-workflow-recovery-malformed",
      recoveryRef: "dvr1_workflow-recovery-malformed",
      recovery: {
        kind: "periodic-update",
        planDigest: taskWorkflowPlanDigest,
      },
    }),
    (error) => error?.code === "PARSING_ERROR",
    "a malformed native mutation proof must reject the Bridge response",
  );
  const flatCandidateRecoveryDb = new DatabaseSync(dbPath);
  try {
    flatCandidateRecoveryDb
      .prepare(
        `UPDATE operon_mutation_journal
         SET requested_json = ?
         WHERE idempotency_key = ?`,
      )
      .run(
        JSON.stringify({
          kind: "periodic-update",
          planDigest: taskWorkflowPlanDigest,
          recoveryRef: "dvr1_workflow-recovery",
        }),
        "test-workflow-recovery",
      );
  } finally {
    flatCandidateRecoveryDb.close();
  }
  const recoveryCallsBeforeFlatCandidateReplay = state.recoveryCalls;
  const migratedFlatCandidate = await new OperonService().recoverMutation({
    idempotencyKey: "test-workflow-recovery",
    recoveryRef: "dvr1_workflow-recovery",
    recovery: {
      kind: "periodic-update",
      planDigest: taskWorkflowPlanDigest,
    },
  });
  assert.equal(migratedFlatCandidate.replayed, true);
  assert.equal(
    state.recoveryCalls,
    recoveryCallsBeforeFlatCandidateReplay,
    "the unreleased flat 3.1 recovery journal binding must migrate without another Bridge apply",
  );

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
    recovery: { kind: "developer-api" },
  };
  const recoveryCallsBeforeLegacy = state.recoveryCalls;
  const recovered = await service.recoverMutation(recoveryInput);
  assert.equal(recovered.status, "already-applied");
  assert.equal(state.recoveryCalls, recoveryCallsBeforeLegacy + 1);
  const legacyRecoveryDb = new DatabaseSync(dbPath);
  try {
    legacyRecoveryDb
      .prepare(
        `UPDATE operon_mutation_journal
         SET requested_json = ?
         WHERE idempotency_key = ?`,
      )
      .run(
        JSON.stringify({ recoveryRef: recoveryInput.recoveryRef }),
        recoveryInput.idempotencyKey,
      );
  } finally {
    legacyRecoveryDb.close();
  }
  state.mode = "offline";
  const restartedRecovery = await new OperonService().recoverMutation(
    recoveryInput,
  );
  assert.equal(restartedRecovery.replayed, true);
  assert.equal(
    state.recoveryCalls,
    recoveryCallsBeforeLegacy + 1,
    "completed recovery must replay from the MCP journal after restart",
  );
  state.mode = "normal";
  config.operonMutationAllowedPathPrefixes = configuredMutationPrefixes;
  const recoveryCallsBeforePolicyReplay = state.recoveryCalls;
  await assert.rejects(
    new OperonService().recoverMutation(recoveryInput),
    (error) =>
      error?.code === "FORBIDDEN" &&
      /before listing, replay, or Bridge apply/u.test(error.message),
    "a stricter path policy must fence a durable recovery replay sealed under an earlier unscoped policy",
  );
  assert.equal(
    state.recoveryCalls,
    recoveryCallsBeforePolicyReplay,
    "the path-policy replay fence must not contact the Bridge",
  );

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

  const fullyColdInput = {
    idempotencyKey: "test-fully-cold-enabled-bridge",
    dryRun: true,
    periodic: {
      description: "Fully cold enabled Bridge",
      periodicKind: "daily",
      routeDate: "2026-08-23",
    },
  };
  const callsBeforeFullyCold = state.mutationCalls;
  state.workflowCold = true;
  state.bridgeModeOverride = "read-only";
  const fullyColdResult = await service.createPeriodicTask(fullyColdInput);
  assert.equal(fullyColdResult.status, "planned");
  assert.equal(state.mutationCalls, callsBeforeFullyCold + 1);
  state.workflowCold = false;
  state.bridgeModeOverride = null;

  const legacyColdInput = {
    idempotencyKey: "test-legacy-bridge-cold-workflow",
    dryRun: true,
    periodic: {
      description: "Legacy Bridge cold workflow",
      periodicKind: "daily",
      routeDate: "2026-08-23",
    },
  };
  const callsBeforeLegacyCold = state.mutationCalls;
  state.workflowCold = true;
  state.bridgeModeOverride = "read-write";
  state.omitMutationsEnabled = true;
  await assert.rejects(
    service.createPeriodicTask(legacyColdInput),
    (error) => error?.code === "SERVICE_UNAVAILABLE",
  );
  assert.equal(
    state.mutationCalls,
    callsBeforeLegacyCold,
    "an older Bridge without the explicit global gate must keep its cold capability block",
  );
  state.workflowCold = false;
  state.bridgeModeOverride = null;
  state.omitMutationsEnabled = false;

  const pendingGrantInput = {
    idempotencyKey: "test-pending-grant-same-key-retry",
    dryRun: true,
    periodic: {
      description: "Pending grant retry",
      periodicKind: "daily",
      routeDate: "2026-08-23",
    },
  };
  const callsBeforePendingGrant = state.mutationCalls;
  state.workflowGrantPending = true;
  await assert.rejects(
    service.createPeriodicTask(pendingGrantInput),
    (error) =>
      error?.code === "SERVICE_UNAVAILABLE" &&
      /grant is pending/u.test(error.message),
  );
  assert.equal(state.mutationCalls, callsBeforePendingGrant);
  state.workflowGrantPending = false;
  const approvedSameKey = await service.createPeriodicTask(pendingGrantInput);
  assert.equal(approvedSameKey.status, "planned");
  assert.equal(
    state.mutationCalls,
    callsBeforePendingGrant + 1,
    "manual approval must allow the exact same key to reach the Bridge once",
  );

  const globallyDisabledInput = {
    idempotencyKey: "test-globally-disabled-same-key-retry",
    dryRun: true,
    periodic: {
      description: "Globally disabled mutation surface",
      periodicKind: "daily",
      routeDate: "2026-08-23",
    },
  };
  const callsBeforeDisabledSurface = state.mutationCalls;
  state.mutations = false;
  await assert.rejects(
    service.createPeriodicTask(globallyDisabledInput),
    (error) => error?.code === "SERVICE_UNAVAILABLE",
  );
  assert.equal(state.mutationCalls, callsBeforeDisabledSurface);
  state.mutations = true;
  const enabledSameKey = await service.createPeriodicTask(
    globallyDisabledInput,
  );
  assert.equal(enabledSameKey.status, "planned");
  assert.equal(
    state.mutationCalls,
    callsBeforeDisabledSurface + 1,
    "global mutation disablement must not poison the same-key retry journal",
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

  const legacyDbPath = path.join(tempRoot, "legacy-v1-cache.sqlite");
  const legacySnapshotDb = new DatabaseSync(legacyDbPath);
  try {
    legacySnapshotDb.exec(`
      CREATE TABLE operon_task_snapshot (
        operon_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_mtime INTEGER,
        payload_json TEXT NOT NULL,
        operon_version TEXT NOT NULL,
        bridge_version TEXT NOT NULL,
        snapshot_at INTEGER NOT NULL
      );
      CREATE TABLE operon_snapshot_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const snapshotAt = Date.now() - 60_000;
    const insertTask = legacySnapshotDb.prepare(
      `INSERT INTO operon_task_snapshot (
        operon_id, revision, source_path, source_mtime, payload_json,
        operon_version, bridge_version, snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const current of tasks) {
      const legacyTask = {
        ...current,
        fields: {
          status: String(current.fields.status),
          priority: String(current.fields.priority),
          taskGallery: "media/a,b.png; media\\c;d.png",
        },
      };
      insertTask.run(
        legacyTask.operonId,
        legacyTask.revision,
        legacyTask.path,
        legacyTask.sourceMtime,
        JSON.stringify(legacyTask),
        "2.4.0",
        "0.1.0",
        snapshotAt,
      );
    }
    const legacyStatus = statusPayload();
    delete legacyStatus.capabilities.periodicCreate;
    delete legacyStatus.capabilities.periodicUpdate;
    delete legacyStatus.capabilities.taskWorkflowRecovery;
    const writeLegacyMeta = legacySnapshotDb.prepare(
      "INSERT INTO operon_snapshot_meta (key, value) VALUES (?, ?)",
    );
    for (const [key, value] of [
      // Real v1 snapshots predate the explicit schema marker. Its absence is
      // the durable signal the reader must safely interpret as schema v1.
      ["snapshot_at", String(snapshotAt)],
      ["generation", String(state.generation)],
      ["settings_signature", "fnv1a32:settings"],
      ["operon_version", "2.4.0"],
      ["bridge_version", "0.1.0"],
      ["contract_version", "1"],
      ["status_json", JSON.stringify(legacyStatus)],
    ]) {
      writeLegacyMeta.run(key, value);
    }
  } finally {
    legacySnapshotDb.close();
  }
  const originalDbPath = config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath = legacyDbPath;
  state.mode = "offline";
  const legacyService = new OperonService();
  const migratedLegacySnapshot = await legacyService.ensureSnapshot();
  assert.equal(migratedLegacySnapshot.snapshotSchemaVersion, 1);
  assert.equal(
    typeof migratedLegacySnapshot.tasks[0].fields.taskGallery,
    "string",
    "v1 compatibility must not invent list boundaries from a lossy delimiter string",
  );
  assert.ok(
    migratedLegacySnapshot.limitations.some((entry) =>
      entry.includes("Legacy Operon snapshot schema v1"),
    ),
    "v1 compatibility must disclose the flattened-list limitation",
  );
  tasks[0].fields.taskGallery = ["media/a,b.png", "media\\c;d.png"];
  state.mode = "normal";
  const postCallsBeforeV2Refresh = state.postCalls;
  const refreshedV2Snapshot = await legacyService.ensureSnapshot();
  assert.equal(refreshedV2Snapshot.snapshotSchemaVersion, 2);
  assert.ok(
    state.postCalls > postCallsBeforeV2Refresh,
    "a matching-generation v1 snapshot must still be replaced by a live v2 refresh",
  );
  assert.deepEqual(refreshedV2Snapshot.tasks[0].fields.taskGallery, [
    "media/a,b.png",
    "media\\c;d.png",
  ]);
  assert.ok(
    refreshedV2Snapshot.limitations.every(
      (entry) => !entry.includes("Legacy Operon snapshot schema v1"),
    ),
    "the v1 compatibility limitation must disappear after a proven live v2 refresh",
  );
  config.obsidianSharedCacheDbPath = originalDbPath;

  console.log(
    "PASS: Operon snapshot v2/v1 compatibility, typed ordered fields, periodic workflows, task-workflow recovery, readiness gating, postflight, scoped mutations, and durable/concurrent mutation idempotency",
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(tempRoot, { recursive: true, force: true });
}
