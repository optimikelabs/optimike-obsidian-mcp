import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
	OPERON_BRIDGE_BLOCKED_MUTATIONS,
	OPERON_BRIDGE_DENIED_DEVELOPER_API_VERSIONS,
	OPERON_BRIDGE_DEVELOPER_API_VERSIONS,
	filterTasks,
	isCanonicalVaultMarkdownPath,
	isCanonicalVaultRelativePath,
	isCertifiedDeveloperApiVersion,
  isIndexReady,
  managedFieldOutcomeMatches,
  MutationReservationRegistry,
  isVersionCompatible,
  normalizeTask,
  resolvePriorityStableId,
  resolveOperonCompatibility,
  paginateTasks,
  queryTasks,
  resolveWorkflow,
  resolveWorkflowStatus,
  workflowStatusMatches,
  settingsSignature,
  stablePriorityOutcomeMatches,
	shouldAttemptIndexValidation,
  mutationPathValidationError,
  normalizeExpectedManagedFieldValue,
  resolveMutationPreflight,
  interruptedMutationPayload,
  type OperonBridgeTask,
  type RuntimeIndexedTask,
} from "./contract";

let bridgePluginClassPromise: Promise<any> | undefined;

function loadBridgePluginClassForTest(): Promise<any> {
  bridgePluginClassPromise ??= (async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: ["obsidian"],
      write: false,
      logLevel: "silent",
    });
    const loadedModule = { exports: {} as Record<string, unknown> };
    const nativeRequire = createRequire(import.meta.url);
    const obsidianStub = {
      Plugin: class {},
      PluginSettingTab: class {},
      Setting: class {},
      TFile: class {},
    };
    const testRequire = (id: string) =>
      id === "obsidian" ? obsidianStub : nativeRequire(id);
    new Function("module", "exports", "require", bundle.outputFiles[0].text)(
      loadedModule,
      loadedModule.exports,
      testRequire,
    );
    return (loadedModule.exports as { default: any }).default;
  })();
  return bridgePluginClassPromise;
}

test("stable task reads retry one transient generation or settings change", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const oneTask = BridgePlugin.prototype.oneTask as Function;

  for (const scenario of ["generation", "settings"] as const) {
    const generations =
      scenario === "generation" ? [1, 2, 2, 2] : [1, 1, 1, 1];
    const signatures =
      scenario === "settings" ? ["a", "b", "b", "b"] : ["a", "a", "a", "a"];
    let taskReads = 0;
    const runtime = {
      indexer: {
        getTask: () => {
          taskReads += 1;
          return { operonId: "task-1" };
        },
      },
    };
    const fake = {
      requireRuntime: () => runtime,
      indexState: async () => ({
        ready: true,
        generation: generations.shift(),
      }),
      currentSettingsSignature: () => signatures.shift(),
      normalizeRuntimeTask: (_runtime: unknown, task: unknown) => task,
    };

    const result = await oneTask.call(fake, "task-1", true);
    assert.equal(result.task.operonId, "task-1");
    assert.equal(result.generation, scenario === "generation" ? 2 : 1);
    assert.equal(result.settingsSignature, scenario === "settings" ? "b" : "a");
    assert.equal(taskReads, 2);
  }
});

test("stable task collections retry one transient settings change", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const allTasksSnapshot = BridgePlugin.prototype.allTasksSnapshot as Function;
  const signatures = ["a", "b", "b", "b"];
  let taskReads = 0;
  const runtime = {
    indexer: {
      getAllTasks: () => {
        taskReads += 1;
        return [{ operonId: "task-1" }];
      },
    },
  };
  const fake = {
    requireRuntime: () => runtime,
    indexState: async () => ({
      ready: true,
      generation: 7,
      diagnostics: { taskCount: 1 },
    }),
    currentSettingsSignature: () => signatures.shift(),
    normalizeRuntimeTask: (_runtime: unknown, task: unknown) => task,
  };

  const result = await allTasksSnapshot.call(fake, true);
  assert.equal(result.generation, 7);
  assert.equal(result.settingsSignature, "b");
  assert.deepEqual(result.tasks, [{ operonId: "task-1" }]);
  assert.equal(taskReads, 2);
});

test("continuous snapshot churn fails not-ready before native dispatch", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const oneTask = BridgePlugin.prototype.oneTask as Function;
  const executeExistingMutation = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const failReservedMutation = BridgePlugin.prototype
    .failReservedMutation as Function;
  let nativeDispatches = 0;
  let fallbackDispatches = 0;
  const generations = [1, 2, 3, 4];
  const runtime = {
    developerApi: {
      executeMutation: async () => {
        nativeDispatches += 1;
        return { ok: true };
      },
    },
    indexer: { getTask: () => ({ operonId: "task-1" }) },
  };
  const reservation = {
    operationId: "operation-1",
    requested: { description: "updated" },
    signature: "signature-1",
  };
  const fake: Record<string, any> = {
    mutationResults: { get: () => undefined },
    mutationPreflight: async () => ({ kind: "continue" }),
    requireMutationRuntime: () => runtime,
    requireRuntime: () => runtime,
    indexState: async () => ({
      ready: true,
      generation: generations.shift(),
    }),
    currentSettingsSignature: () => "settings-1",
    normalizeRuntimeTask: (_runtime: unknown, task: unknown) => task,
    mutationReservations: { get: () => reservation },
    cacheMutation: () => undefined,
  };
  fake.oneTask = (...args: unknown[]) => oneTask.call(fake, ...args);

  let churnError: unknown;
  try {
    await executeExistingMutation.call(
      fake,
      "update",
      "task-1",
      { idempotencyKey: "key-1", expectedRevision: "revision-1" },
      { description: "updated" },
      async () => {
        fallbackDispatches += 1;
        return { ok: true };
      },
    );
  } catch (error) {
    churnError = error;
  }
  assert.match(String(churnError), /generation or settings changed/);
  assert.equal(nativeDispatches, 0);
  assert.equal(fallbackDispatches, 0);

  const failed = failReservedMutation.call(
    fake,
    { idempotencyKey: "key-1" },
    churnError,
  );
  assert.equal(failed.httpStatus, 503);
  assert.equal(failed.payload.status, "not-ready");
  assert.equal(failed.payload.error.code, "mutation_unavailable");
  assert.equal(failed.payload.retryable, true);
  assert.equal(failed.payload.mutationMayHaveApplied, false);
});

test("lookup and revision validation happen before durable reservation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executeExistingMutation = BridgePlugin.prototype
    .executeExistingMutation as Function;

  for (const scenario of ["missing-task", "missing-revision"] as const) {
    let reservationCalls = 0;
    let taskReads = 0;
    const task =
      scenario === "missing-task"
        ? null
        : { operonId: "task-1", revision: "revision-1" };
    const fake = {
      mutationResults: { get: () => undefined },
      mutationPreflight: async () => {
        reservationCalls += 1;
        return { kind: "continue" };
      },
      requireMutationRuntime: () => ({}),
      oneTask: async () => {
        taskReads += 1;
        return { task };
      },
      mutationOperationId: () => "fallback-operation",
    };
    const result = await executeExistingMutation.call(
      fake,
      "update",
      "task-1",
      {
        idempotencyKey: `key-${scenario}`,
        ...(scenario === "missing-task"
          ? { expectedRevision: "revision-1" }
          : {}),
      },
      { description: "updated" },
      async () => ({ ok: true }),
    );

    assert.equal(result.httpStatus, scenario === "missing-task" ? 404 : 400);
    assert.equal(reservationCalls, 0);
    assert.equal(taskReads, scenario === "missing-task" ? 1 : 0);
  }
});

test("periodic update validates lookup and revision before durable reservation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executePeriodicUpdateMutation = BridgePlugin.prototype
    .executePeriodicUpdateMutation as Function;

  for (const scenario of ["missing-task", "missing-revision"] as const) {
    let reservationCalls = 0;
    let taskReads = 0;
    const task =
      scenario === "missing-task"
        ? null
        : { operonId: "task-1", revision: "revision-1" };
    const fake = {
      mutationResults: { get: () => undefined },
      mutationPreflight: async () => {
        reservationCalls += 1;
        return { kind: "continue" };
      },
      mutationOperationId: () => "periodic-operation",
      requireRuntime: () => ({}),
      indexState: async () => undefined,
      requireTaskWorkflowRuntime: () => ({}),
      oneTask: async () => {
        taskReads += 1;
        return { task };
      },
    };
    const result = await executePeriodicUpdateMutation.call(fake, "task-1", {
      idempotencyKey: `periodic-${scenario}`,
      ...(scenario === "missing-task"
        ? { expectedRevision: "revision-1" }
        : {}),
      patch: { fields: { dateScheduled: "2026-08-25" } },
    });

    assert.equal(result.httpStatus, scenario === "missing-task" ? 404 : 400);
    assert.equal(reservationCalls, 0);
    assert.equal(taskReads, scenario === "missing-task" ? 1 : 0);
  }
});

test("legacy adoption validates the source file before durable reservation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executeAdoptMutation = BridgePlugin.prototype.executeAdoptMutation as Function;
  let reservationCalls = 0;
  const fake = {
    mutationResults: { get: () => undefined },
    mutationPreflight: async () => {
      reservationCalls += 1;
      return { kind: "continue" };
    },
    mutationOperationId: () => "adoption-operation",
    requireRuntime: () => ({}),
    indexState: async () => undefined,
    requireMutationRuntime: () => ({ developerApi: null, api: {} }),
    app: {
      vault: {
        getAbstractFileByPath: () => null,
      },
    },
  };
  const result = await executeAdoptMutation.call(fake, {
    idempotencyKey: "legacy-adoption-missing-file",
    adoption: {
      targetPath: "Missing.md",
      line: 1,
      expectedLine: "- [ ] Missing task",
    },
  });

  assert.equal(result.httpStatus, 404);
  assert.equal(reservationCalls, 0);
});

test("task-workflow replay identities survive plugin-data persistence", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype.restoreTaskWorkflowIdentities as Function;
  const entries = BridgePlugin.prototype.taskWorkflowIdentityEntries as Function;
  const identityStore = BridgePlugin.prototype.taskWorkflowIdentityStore as Function;
  const persist = BridgePlugin.prototype.persistPluginData as Function;
  const key = `periodic-create:${"a".repeat(64)}`;
  const updatedAt = new Date().toISOString();
  const fake: Record<string, any> = {
    settings: { mutationsEnabled: true },
    taskWorkflowIdentities: new Map(),
    dataWriteChain: Promise.resolve(),
    dataWriteFailed: false,
    mutationJournalEntries: () => [],
    queuePersistPluginData() {
      this.dataWriteChain = Promise.resolve();
    },
    saveData: async (value: unknown) => {
      fake.saved = value;
    },
  };

  restore.call(fake, {
    version: 1,
    entries: [{ key, operonId: "day1234", updatedAt }],
  });
  assert.equal(fake.taskWorkflowIdentities.get(key)?.operonId, "day1234");
  fake.taskWorkflowIdentityEntries = () => entries.call(fake);
  await persist.call(fake);
  assert.deepEqual(fake.saved.taskWorkflowIdentities.entries, [
    { key, operonId: "day1234", updatedAt },
  ]);

  const store = identityStore.call(fake);
  const secondKey = `adopt:${"b".repeat(64)}`;
  await store.set(secondKey, "adp1234");
  assert.equal(store.get(secondKey), "adp1234");
});

test("generic REST mutations expose only the adapter's bounded native proof", () => {
  const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const executeStart = mainSource.indexOf(
    "private async executeExistingMutation(",
  );
  const executeEnd = mainSource.indexOf(
    "private async executeCreateMutation(",
    executeStart,
  );
  assert.notEqual(executeStart, -1);
  assert.notEqual(executeEnd, -1);
  const executeSource = mainSource.slice(executeStart, executeEnd);
  const proofProjection =
    /\.\.\.\(native\.nativeProof \? \{ nativeProof: native\.nativeProof \} : \{\}\)/g;

  // Refusal/outcome-unknown, unreadable postflight, and the final typed-update
  // response all use the same already-validated, closed adapter projection.
  assert.equal([...executeSource.matchAll(proofProjection)].length, 3);

  const dryRunEnd = executeSource.indexOf("if (!native.ok || !native.operonId)");
  const postDispatchStart = executeSource.indexOf(
    "if (!native.ok || !native.operonId)",
  );
  const postDispatchEnd = executeSource.indexOf("let afterRead:", postDispatchStart);
  const finalPayloadStart = executeSource.indexOf(
    "const payload = {",
    executeSource.indexOf("const applied ="),
  );
  assert.equal(executeSource.slice(0, dryRunEnd).includes("nativeProof"), false);
  assert.match(
    executeSource.slice(postDispatchStart, postDispatchEnd),
    /recoveryRef[\s\S]+planDigest[\s\S]+nativeProof/,
  );
  assert.match(
    executeSource.slice(finalPayloadStart),
    /planDigest[\s\S]+recoveryRef[\s\S]+nativeProof/,
  );
  assert.match(executeSource, /native\.plan\s*\?/);
  assert.equal(
    /native\.plan\s*\?/.test(executeSource.slice(postDispatchStart)),
    false,
  );
});

test("managed field postflight preserves null clears instead of stringifying them", () => {
  assert.equal(normalizeExpectedManagedFieldValue(null), null);
  assert.equal(normalizeExpectedManagedFieldValue(undefined), null);
  assert.equal(normalizeExpectedManagedFieldValue("null"), "null");
  assert.deepEqual(normalizeExpectedManagedFieldValue(["one", "two"]), [
    "one",
    "two",
  ]);
  assert.equal(managedFieldOutcomeMatches(undefined, null), true);
  assert.equal(managedFieldOutcomeMatches(undefined, "null"), false);
  assert.equal(managedFieldOutcomeMatches("2026-08-25", null), false);
});

test("periodic create postflight compares the requested stable priority id", () => {
  assert.equal(stablePriorityOutcomeMatches("priority-a", "priority-a"), true);
  assert.equal(stablePriorityOutcomeMatches("priority-b", "priority-a"), false);
  assert.equal(stablePriorityOutcomeMatches(null, undefined), true);
});

test("concurrent identical mutations join one atomic reservation", async () => {
  const registry = new MutationReservationRegistry();
  const first = registry.reserve({
    idempotencyKey: "same-key",
    signature: "same-signature",
    operationId: "operation-one",
    requested: { fields: { dateScheduled: "2026-08-25" } },
    startedAt: "2026-08-24T00:00:00.000Z",
  });
  const second = registry.reserve({
    idempotencyKey: "same-key",
    signature: "same-signature",
    operationId: "operation-two",
    requested: {},
    startedAt: "2026-08-24T00:00:01.000Z",
  });
  const conflict = registry.reserve({
    idempotencyKey: "same-key",
    signature: "different-signature",
    operationId: "operation-three",
    requested: {},
    startedAt: "2026-08-24T00:00:02.000Z",
  });
  assert.equal(first.kind, "reserved");
  assert.equal(second.kind, "join");
  assert.equal(conflict.kind, "conflict");
  assert.equal(second.reservation.operationId, "operation-one");
  const terminal = { ok: true, operationId: "operation-one", status: "applied" };
  registry.complete("same-key", "same-signature", terminal);
  assert.equal(await second.reservation.promise, terminal);
});

test("durable terminal replay preserves HTTP and interrupted reservations recover uncertainty", () => {
  const replay = resolveMutationPreflight({
    cached: {
      signature: "signature",
      payload: { ok: false, operationId: "operation-one", status: "outcome-unknown" },
      httpStatus: 500,
    },
    idempotencyKey: "same-key",
    signature: "signature",
    requested: {},
    validate: () => null,
    operationId: () => "unused",
  });
  assert.equal(replay.kind, "response");
  if (replay.kind === "response") {
    assert.equal(replay.response.httpStatus, 500);
    assert.equal(replay.response.payload.operationId, "operation-one");
    assert.equal(replay.response.payload.replayed, true);
  }
  const interrupted = interruptedMutationPayload({
    idempotencyKey: "same-key",
    operationId: "operation-one",
    requested: { operonId: "task123" },
  });
  assert.equal(interrupted.status, "outcome-unknown");
  assert.equal(interrupted.mutationMayHaveApplied, true);
  assert.equal(interrupted.recoveryRequired, true);
});

test("resolves a requested priority label to the stable id used by postflight", () => {
  const priorities = [
    { id: "pr_a", label: "A" },
    { id: "pr_f", label: "F" },
  ];
  assert.equal(resolvePriorityStableId("F", priorities), "pr_f");
  assert.equal(resolvePriorityStableId(" pr_f ", priorities), "pr_f");
  assert.equal(resolvePriorityStableId("unknown", priorities), null);
});

test("resolves bare workflow labels for postflight status matching", () => {
  const workflowPipelines = [
    {
      id: "pl_project",
      name: "Project",
      statuses: [{ id: "st_project_done", label: "Done" }],
    },
  ];
  assert.deepEqual(resolveWorkflowStatus("Done", workflowPipelines), {
    pipeline: "Project",
    label: "Done",
    value: "Project.Done",
    id: "st_project_done",
  });
  const after = {
    status: "Project.Done",
    statusId: "st_project_done",
    statusLabel: "Done",
    pipeline: "Project",
    pipelineId: "pl_project",
  };
  assert.equal(workflowStatusMatches(after, "Done", workflowPipelines), true);
  assert.equal(workflowStatusMatches(after, "st_project_done", workflowPipelines), true);
  assert.equal(workflowStatusMatches(after, "Project.Done", workflowPipelines), true);
  assert.equal(workflowStatusMatches(after, "Planned", workflowPipelines), false);

  const ambiguousPipelines = [
    ...workflowPipelines,
    { id: "pl_pipeline", name: "Pipeline", statuses: [{ id: "st_pipeline_done", label: "Done" }] },
  ];
  assert.equal(resolveWorkflowStatus("Done", ambiguousPipelines), null);
  assert.equal(workflowStatusMatches(after, "Done", ambiguousPipelines), false);
});

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

test("task revision is invariant across the unmanaged-properties projection", () => {
  const options = {
    task: {
      ...task,
      primary: { ...task.primary, format: "yaml" as const },
    },
    pipelines,
    keyMappings: [
      { canonicalKey: "status", visiblePropertyName: "status" },
      { canonicalKey: "priority", visiblePropertyName: "priority" },
    ],
    frontmatter: {
      status: "Project.InProgress",
      priority: "A",
      rang: 4,
      north_star: true,
    },
    sourceMtime: 1234,
    operonVersion: "3.1.1",
    bridgeVersion: "0.5.1",
  };
  const projected = normalizeTask({ ...options, includeProperties: true });
  const redacted = normalizeTask({ ...options, includeProperties: false });

  assert.deepEqual(projected.properties, { rang: 4, north_star: true });
  assert.equal(redacted.properties, undefined);
  assert.equal(redacted.revision, projected.revision);
});

test("legacy version compatibility remains an explicit tested-version allowlist", () => {
  assert.equal(isVersionCompatible("operon", "2.4.0"), true);
  assert.equal(isVersionCompatible("operon", "2.5.0"), true);
  assert.equal(isVersionCompatible("operon", "3.0.0"), false);
  assert.equal(isVersionCompatible("operon", "3.0.1"), true);
  assert.equal(isVersionCompatible("operon", "3.1.0"), true);
  assert.equal(isVersionCompatible("operon", "3.1.1"), true);
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
  assert.equal(isVersionCompatible("kairelys", "2.6.3"), true);
  assert.equal(isVersionCompatible("kairelys", "2.6.4"), false);
});

test("certified Developer API versions and known mutation exceptions remain explicit", () => {
	assert.deepEqual(OPERON_BRIDGE_DEVELOPER_API_VERSIONS, [
		"3.0.1",
		"3.1.0",
		"3.1.1",
		"3.2.0",
		"3.2.1",
	]);
	assert.equal(isCertifiedDeveloperApiVersion("3.0.1"), true);
	assert.equal(isCertifiedDeveloperApiVersion("3.1.0"), true);
	assert.equal(isCertifiedDeveloperApiVersion("3.1.1"), true);
	assert.equal(isCertifiedDeveloperApiVersion("3.2.0"), true);
	assert.equal(isCertifiedDeveloperApiVersion("3.2.1"), true);
	assert.deepEqual(OPERON_BRIDGE_BLOCKED_MUTATIONS["3.0.1"], ["transition"]);
	assert.deepEqual(OPERON_BRIDGE_BLOCKED_MUTATIONS["3.1.0"], []);
	assert.deepEqual(OPERON_BRIDGE_BLOCKED_MUTATIONS["3.1.1"], []);
	assert.deepEqual(OPERON_BRIDGE_BLOCKED_MUTATIONS["3.2.0"], []);
	assert.deepEqual(OPERON_BRIDGE_BLOCKED_MUTATIONS["3.2.1"], []);
});

test("unknown Operon versions are admitted provisionally by the Developer API V1 contract", () => {
	assert.deepEqual(
		resolveOperonCompatibility({
			pluginId: "operon",
			version: "3.3.0",
			hasDeveloperApiV1: true,
		}),
		{
			state: "compatible-provisional",
			admission: "developer-api-v1",
			reason:
				"The loaded Operon version is not yet certified, but it exposes the negotiated Developer API V1 boundary; runtime capability and schema checks remain mandatory.",
		},
	);
	assert.equal(
		resolveOperonCompatibility({
			pluginId: "operon",
			version: "3.3.0",
			hasDeveloperApiV1: false,
		}).state,
		"incompatible",
	);
});

test("certified and denied Developer API versions keep deterministic admission", () => {
	assert.equal(
		resolveOperonCompatibility({
			pluginId: "operon",
			version: "3.2.1",
			hasDeveloperApiV1: true,
		}).state,
		"certified",
	);
	assert.match(OPERON_BRIDGE_DENIED_DEVELOPER_API_VERSIONS["3.0.0"] ?? "", /predates/u);
	assert.equal(
		resolveOperonCompatibility({
			pluginId: "operon",
			version: "3.0.0",
			hasDeveloperApiV1: true,
		}).state,
		"incompatible",
	);
});

test("mutation paths are rejected instead of normalized at the Bridge boundary", () => {
	assert.equal(isCanonicalVaultRelativePath("Efforts/Projets"), true);
	assert.equal(isCanonicalVaultMarkdownPath("Efforts/Projets/Test.md"), true);
	for (const invalidPath of [
		" Efforts/Projets/Test.md",
		"Efforts/Projets/Test.md ",
		"Efforts\\Projets\\Test.md",
		"/Efforts/Projets/Test.md",
		"C:/Efforts/Projets/Test.md",
		"Efforts//Projets/Test.md",
		"Efforts/./Projets/Test.md",
		"Efforts/Projets/../Atlas/Test.md",
	]) {
		assert.equal(isCanonicalVaultMarkdownPath(invalidPath), false);
	}
	assert.match(
		mutationPathValidationError("create", {
			source: "inline",
			targetPath: "Efforts/Projets/Test.md ",
		}) ?? "",
		/targetPath/u,
	);
	assert.match(
		mutationPathValidationError("convert", {
			target: "file",
			targetFolder: "Efforts/Projets/ ",
		}) ?? "",
		/targetFolder/u,
	);
	assert.match(
		mutationPathValidationError("convert", { target: "inline" }) ?? "",
		/required/u,
	);
	assert.match(
		mutationPathValidationError("create", {
			source: "file",
			targetPath: "Efforts/Projets/Test.md",
		}) ?? "",
		/only for inline/u,
	);
	assert.match(
		mutationPathValidationError("convert", {
			target: "file",
			targetPath: "Efforts/Projets/Test.md",
		}) ?? "",
		/only for file-to-inline/u,
	);
	assert.match(
		mutationPathValidationError("relocate", {
			targetPath: "Efforts/Projets/Test.md ",
		}) ?? "",
		/targetPath/u,
	);
	assert.equal(
		mutationPathValidationError("create", {
			source: "inline",
			targetPath: "Efforts/Projets/Test.md",
		}),
		null,
	);
	assert.equal(
		mutationPathValidationError("convert", {
			target: "inline",
			targetPath: "Efforts/Projets/Test.md",
		}),
		null,
	);
});

test("consumed idempotency keys take precedence over replacement validation", () => {
	const cached = {
		signature: "original-signature",
		payload: { ok: true, status: "planned", operationId: "original-operation" },
	};
	let validationCalled = false;
	const conflict = resolveMutationPreflight({
		cached,
		idempotencyKey: "stable-idempotency-key",
		signature: "different-signature",
		requested: { targetPath: "Efforts/Projets/Test.md " },
		validate: () => {
			validationCalled = true;
			return "invalid path";
		},
		operationId: () => "conflict-operation",
	});
	assert.equal(conflict.kind, "response");
	if (conflict.kind === "response") {
		assert.equal(conflict.response.httpStatus, 409);
		assert.equal(
			(conflict.response.payload.error as { code?: string }).code,
			"idempotency_key_reused",
		);
	}
	assert.equal(validationCalled, false);

	const replay = resolveMutationPreflight({
		cached,
		idempotencyKey: "stable-idempotency-key",
		signature: "original-signature",
		requested: { targetPath: "Efforts/Projets/Test.md" },
		validate: () => {
			validationCalled = true;
			return "must not run";
		},
		operationId: () => "unused-operation",
	});
	assert.equal(replay.kind, "response");
	if (replay.kind === "response") {
		assert.equal(replay.response.httpStatus, 200);
		assert.equal(replay.response.payload.replayed, true);
	}
	assert.equal(validationCalled, false);

	const invalidFreshRequest = resolveMutationPreflight({
		cached: undefined,
		idempotencyKey: "fresh-idempotency-key",
		signature: "fresh-signature",
		requested: { targetPath: "Efforts/Projets/Test.md " },
		validate: () => "invalid path",
		operationId: () => "unused-operation",
	});
	assert.deepEqual(invalidFreshRequest, {
		kind: "validation-error",
		message: "invalid path",
	});
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

test("valid Developer API V1 releases do not need a product-version mutation allowlist", () => {
  assert.deepEqual(
    resolveOperonCompatibility({
      pluginId: "operon",
      version: "99.0.0",
      hasDeveloperApiV1: true,
    }),
    {
      state: "compatible-provisional",
      admission: "developer-api-v1",
      reason:
        "The loaded Operon version is not yet certified, but it exposes the negotiated Developer API V1 boundary; runtime capability and schema checks remain mandatory.",
    },
  );
});

test("direct mutation guards rely on negotiated capabilities instead of product versions", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const guards: Array<[string, Function, unknown[]]> = [
    [
      "mutation",
      BridgePlugin.prototype.requireMutationRuntime as Function,
      ["update"],
    ],
    [
      "task workflow",
      BridgePlugin.prototype.requireTaskWorkflowRuntime as Function,
      ["periodic-update"],
    ],
    [
      "recovery",
      BridgePlugin.prototype.requireDeveloperApiMutationRuntime as Function,
      [],
    ],
  ];

  for (const [label, guard, args] of guards) {
    const runtime = {
      version: "99.0.0",
      compatible: true,
      developerApi: {
        hasMutationCapability: () => true,
        hasTaskWorkflowCapability: () => true,
        hasRecoverySupport: () => true,
        hasTaskWorkflowRecoverySupport: () => true,
      },
    };
    const fake = {
      settings: { mutationsEnabled: true },
      requireRuntime: () => runtime,
      indexState: async () => ({ ready: true }),
    };
    assert.equal(
      await guard.call(fake, ...args),
      runtime,
      `${label} must remain available for a future version with the negotiated contract`,
    );
  }

  let negotiated = false;
  const coldRuntime = {
    version: "99.0.0",
    compatible: true,
    developerApi: {
      hasMutationCapability: () => negotiated,
      hasTaskWorkflowCapability: () => negotiated,
      hasRecoverySupport: () => negotiated,
      hasTaskWorkflowRecoverySupport: () => negotiated,
    },
  };
  const cold = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => coldRuntime,
    indexState: async () => {
      negotiated = true;
      return { ready: true };
    },
  };
  assert.equal(
    await BridgePlugin.prototype.requireMutationRuntime.call(cold, "create"),
    coldRuntime,
  );
  negotiated = false;
  assert.equal(
    await BridgePlugin.prototype.requireTaskWorkflowRuntime.call(
      cold,
      "periodic-create",
    ),
    coldRuntime,
  );

  const missingCapabilityRuntime = {
    version: "99.0.0",
    compatible: true,
    developerApi: {
      hasMutationCapability: () => false,
      hasTaskWorkflowCapability: () => false,
      hasRecoverySupport: () => false,
      hasTaskWorkflowRecoverySupport: () => false,
    },
  };
  const missingCapability = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => missingCapabilityRuntime,
    indexState: async () => ({ ready: true }),
  };
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireMutationRuntime.call(
        missingCapability,
        "update",
      ),
    /mutation or recovery capability is unavailable: update/u,
  );
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireTaskWorkflowRuntime.call(
        missingCapability,
        "periodic-update",
      ),
    /task-workflow Developer API capability or recovery support is unavailable: periodic-update/u,
  );

  const missingRecoveryRuntime = {
    version: "99.0.0",
    compatible: true,
    developerApi: {
      hasMutationCapability: () => true,
      hasTaskWorkflowCapability: () => true,
      hasRecoverySupport: () => false,
      hasTaskWorkflowRecoverySupport: () => false,
    },
  };
  const missingRecovery = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => missingRecoveryRuntime,
    indexState: async () => ({ ready: true }),
  };
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireMutationRuntime.call(
        missingRecovery,
        "update",
      ),
    /mutation or recovery capability is unavailable: update/u,
  );
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireTaskWorkflowRuntime.call(
        missingRecovery,
        "periodic-create",
      ),
    /task-workflow Developer API capability or recovery support is unavailable: periodic-create/u,
  );

  const legacyRuntime = {
    version: "2.6.0",
    api: {
      capabilities: () => ({ ready: true, update: true }),
    },
  };
  const legacy = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => legacyRuntime,
  };
  assert.equal(
    await BridgePlugin.prototype.requireMutationRuntime.call(legacy, "update"),
    legacyRuntime,
  );
});

test("future contract-compatible Operon releases project read-write capabilities", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const adapter = {
    hasMutationCapability: () => true,
    hasTaskWorkflowCapability: () => true,
    hasReadCapability: () => true,
    hasFilterQueryCapability: () => true,
    hasRecoverySupport: () => true,
    hasTaskWorkflowRecoverySupport: () => true,
  };
  const runtime = {
    version: "99.0.0",
    compatible: true,
    developerApi: adapter,
  };
  const fake = { settings: { mutationsEnabled: true } };
  const capabilities = BridgePlugin.prototype.capabilities.call(
    fake,
    runtime,
    true,
  );
  assert.equal(capabilities.update, true);
  assert.equal(capabilities.adopt, true);
  assert.equal(capabilities.periodicCreate, true);
  assert.equal(capabilities.periodicUpdate, true);
  assert.equal(capabilities.recovery, true);
  assert.equal(capabilities.taskWorkflowRecovery, true);

  const invalidCapabilities = BridgePlugin.prototype.capabilities.call(
    fake,
    { ...runtime, compatible: false },
    true,
  );
  assert.equal(invalidCapabilities.update, false);
  assert.equal(invalidCapabilities.adopt, false);
  assert.equal(invalidCapabilities.recovery, false);

  const noRecoveryAdapter = {
    ...adapter,
    hasRecoverySupport: () => false,
    hasTaskWorkflowRecoverySupport: () => false,
  };
  const noRecoveryCapabilities = BridgePlugin.prototype.capabilities.call(
    fake,
    { ...runtime, developerApi: noRecoveryAdapter },
    true,
  );
  assert.equal(noRecoveryCapabilities.update, false);
  assert.equal(noRecoveryCapabilities.adopt, false);
  assert.equal(noRecoveryCapabilities.periodicCreate, false);
  assert.equal(noRecoveryCapabilities.periodicUpdate, false);
});

test("normalization and filtering preserve ordered list fields without scalar coercion", () => {
  const listTask: RuntimeIndexedTask = {
    ...task,
    operonId: "lst1234",
    fieldValues: {
      ...task.fieldValues,
      taskType: "article",
      taskImage: "[[Cover.png]]",
      taskGallery: ["[[A;B.png]]", "[[Second.png]]"],
    },
  };
  const normalized = normalizeTask({
    task: listTask,
    pipelines,
    keyMappings: [
      { canonicalKey: "status", visiblePropertyName: "status" },
      { canonicalKey: "priority", visiblePropertyName: "priority" },
      { canonicalKey: "taskType", visiblePropertyName: "Task Type" },
      { canonicalKey: "taskImage", visiblePropertyName: "Task Image" },
      { canonicalKey: "taskGallery", visiblePropertyName: "Task Gallery" },
    ],
    operonVersion: "3.5.3",
    bridgeVersion: "0.8.1",
    includeProperties: false,
  });
  assert.deepEqual(normalized.fields.taskGallery, [
    "[[A;B.png]]",
    "[[Second.png]]",
  ]);
  assert.equal(
    filterTasks([normalized], {
      fieldEquals: {
        taskGallery: ["[[A;B.png]]", "[[Second.png]]"],
      },
    }).length,
    1,
  );
  assert.equal(
    filterTasks([normalized], {
      fieldEquals: {
        taskGallery: ["[[Second.png]]", "[[A;B.png]]"],
      },
    }).length,
    0,
    "taskGallery order is semantic and must be compared exactly",
  );
  assert.equal(filterTasks([normalized], { search: "A;B.png" }).length, 1);
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
