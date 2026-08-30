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

async function attachPassThroughCoordination(
  fake: Record<string, any>,
): Promise<void> {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const replay = BridgePlugin.prototype.mutationReplayOrValidation as Function;
  const preflight = BridgePlugin.prototype.mutationPreflight as Function;
  fake.mutationReplayOrValidation ??= (...args: unknown[]) =>
    replay.call(fake, ...args);
  fake.mutationPreflight ??= (...args: unknown[]) =>
    preflight.call(fake, ...args);
  fake.coordinatedMutationPreflight = async (options: {
    idempotencyKey: string;
    signature: string;
    requested: Record<string, unknown>;
    failureScope?: Record<string, unknown>;
    prepare: () => Promise<
      | { kind: "ready"; value: unknown }
      | { kind: "response"; response: Record<string, unknown> }
    >;
  }) => {
    const active = fake.activeMutationReservationResponse
      ? await fake.activeMutationReservationResponse(
          options.idempotencyKey,
          options.signature,
          options.requested,
        )
      : null;
    if (active) return { kind: "response", response: active };
    const prepared = await options.prepare();
    if (prepared.kind === "response") return prepared;
    const preflight = await fake.mutationPreflight(
      options.idempotencyKey,
      options.signature,
      options.requested,
      () => null,
      options.failureScope,
    );
    if (preflight.kind === "response") {
      return { kind: "response", response: await preflight.response };
    }
    return { kind: "leader", value: prepared.value };
  };
}

function existingMutationSignature(
  capability: string,
  requested: Record<string, unknown>,
): string {
  return JSON.stringify({
    capability,
    dryRun: true,
    expectedRevision: "revision-1",
    operonId: "task-1",
    requested,
  });
}

async function durableExistingMutationFake(options: {
  native: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}): Promise<{ fake: Record<string, any>; nativeCalls: () => number }> {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const cacheMutation = BridgePlugin.prototype.cacheMutation as Function;
  const mutationHttpStatus = BridgePlugin.prototype
    .mutationHttpStatus as Function;
  const mutationJournalEntries = BridgePlugin.prototype
    .mutationJournalEntries as Function;
  const taskWorkflowIdentityEntries = BridgePlugin.prototype
    .taskWorkflowIdentityEntries as Function;
  const persistPluginData = BridgePlugin.prototype
    .persistPluginData as Function;
  const queuePersistPluginData = BridgePlugin.prototype
    .queuePersistPluginData as Function;
  let operation = 0;
  let calls = 0;
  const fake: Record<string, any> = {
    settings: { mutationsEnabled: true },
    mutationResults: new Map(),
    mutationResultTimes: new Map(),
    mutationReservations: new MutationReservationRegistry(),
    mutationPreflightFlights: new Map(),
    taskWorkflowIdentities: new Map(),
    dataWriteChain: Promise.resolve(),
    dataWriteFailed: false,
    saved: [] as Record<string, unknown>[],
    mutationOperationId: () => `receipt-operation-${++operation}`,
    mutationHttpStatus(payload: Record<string, unknown>) {
      return mutationHttpStatus.call(this, payload);
    },
    mutationJournalEntries() {
      return mutationJournalEntries.call(this);
    },
    taskWorkflowIdentityEntries() {
      return taskWorkflowIdentityEntries.call(this);
    },
    persistPluginData() {
      return persistPluginData.call(this);
    },
    queuePersistPluginData() {
      return queuePersistPluginData.call(this);
    },
    saveData: async (value: Record<string, unknown>) => {
      fake.saved.push(structuredClone(value));
    },
    cacheMutation(...args: unknown[]) {
      return cacheMutation.call(this, ...args);
    },
    requireMutationRuntime: async () => ({
      developerApi: {
        executeMutation: async () => {
          calls += 1;
          return options.native();
        },
      },
    }),
    oneTask: async () => ({
      task: { operonId: "task-1", revision: "revision-1" },
    }),
  };
  await attachPassThroughCoordination(fake);
  return { fake, nativeCalls: () => calls };
}

test("stable task reads retry one transient generation or settings change", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const oneTask = BridgePlugin.prototype.oneTask as Function;

  for (const scenario of ["generation", "settings"] as const) {
    const generations = scenario === "generation" ? [1, 2, 2, 2] : [1, 1, 1, 1];
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
    activeMutationReservationResponse: async () => null,
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
  await attachPassThroughCoordination(fake);

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
    {
      idempotencyKey: "key-1",
      signature: "signature-1",
      reservationOperationId: "operation-1",
    },
    churnError,
  );
  assert.equal(failed.httpStatus, 500);
  assert.equal(failed.payload.status, "outcome-unknown");
  assert.equal(failed.payload.error.code, "outcome_unverified");
  assert.equal(failed.payload.retryable, false);
  assert.equal(failed.payload.mutationMayHaveApplied, true);
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
      activeMutationReservationResponse: async () => null,
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
    await attachPassThroughCoordination(fake);
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

test("an in-flight identical existing mutation joins before transient runtime probes", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executeExistingMutation = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const activeMutationReservationResponse = BridgePlugin.prototype
    .activeMutationReservationResponse as Function;
  const reservations = new MutationReservationRegistry();
  const idempotencyKey = "in-flight-existing-key";
  const requested = { description: "updated" };
  const signature =
    '{"capability":"update","dryRun":false,"expectedRevision":"revision-1","operonId":"task-1","requested":{"description":"updated"}}';
  const activePayload = {
    ok: true,
    contractVersion: "1",
    operationId: "dispatched-operation",
    idempotencyKey,
    status: "applied",
    requested,
    mutationMayHaveApplied: true,
  };
  const reserved = reservations.reserve({
    idempotencyKey,
    signature,
    operationId: "dispatched-operation",
    requested,
    startedAt: "2026-08-30T00:00:00.000Z",
  });
  assert.equal(reserved.kind, "reserved");

  let finishNative: (() => void) | undefined;
  let nativeCalls = 0;
  const nativeExecution = (async () => {
    nativeCalls += 1;
    await new Promise<void>((resolve) => {
      finishNative = resolve;
    });
    return activePayload;
  })();
  void nativeExecution.then((payload) => {
    reservations.complete(idempotencyKey, signature, payload);
  });

  let runtimeProbes = 0;
  const fake: Record<string, any> = {
    mutationResults: { get: () => undefined },
    mutationReservations: reservations,
    mutationHttpStatus: () => 200,
    mutationOperationId: () => "unexpected-operation",
    requireMutationRuntime: () => {
      runtimeProbes += 1;
      throw new Error("runtime became unavailable after dispatch");
    },
    oneTask: () => {
      throw new Error("an in-flight replay must not re-read the task");
    },
  };
  fake.activeMutationReservationResponse = (...args: unknown[]) =>
    activeMutationReservationResponse.call(fake, ...args);
  fake.mutationPreflight = async () => ({ kind: "continue" });
  await attachPassThroughCoordination(fake);

  const joined = executeExistingMutation.call(
    fake,
    "update",
    "task-1",
    {
      idempotencyKey,
      expectedRevision: "revision-1",
      dryRun: false,
    },
    requested,
    async () => {
      throw new Error(
        "a joined mutation must not dispatch a second native call",
      );
    },
  );
  await Promise.resolve();
  assert.equal(nativeCalls, 1);
  assert.equal(runtimeProbes, 0);

  const conflicting = await executeExistingMutation.call(
    fake,
    "update",
    "task-1",
    {
      idempotencyKey,
      expectedRevision: "revision-1",
      dryRun: false,
    },
    { description: "different" },
    async () => {
      throw new Error("a conflicting key must not dispatch a native call");
    },
  );
  assert.equal(conflicting.httpStatus, 409);
  assert.equal(runtimeProbes, 0);

  const malformed = await executeExistingMutation.call(
    fake,
    "update",
    "task-1",
    { idempotencyKey, dryRun: false },
    requested,
    async () => {
      throw new Error("a malformed replay must not dispatch a native call");
    },
  );
  assert.equal(malformed.httpStatus, 400);
  assert.equal(runtimeProbes, 0);

  finishNative?.();
  const result = await joined;
  assert.equal(result.httpStatus, 200);
  assert.equal(result.payload, activePayload);
  assert.equal(runtimeProbes, 0);
});

test("same-key callers atomically cross asynchronous preflight into one durable reservation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const coordinated = BridgePlugin.prototype
    .coordinatedMutationPreflight as Function;
  const active = BridgePlugin.prototype
    .activeMutationReservationResponse as Function;
  const preflight = BridgePlugin.prototype.mutationPreflight as Function;
  const replay = BridgePlugin.prototype.mutationReplayOrValidation as Function;
  const settle = BridgePlugin.prototype
    .settleMutationPreflightFlight as Function;
  const promote = BridgePlugin.prototype
    .promoteMutationPreflightFlight as Function;

  for (const route of [
    "update",
    "create",
    "recovery",
    "workflow-recovery",
    "adopt",
    "periodic-create",
    "periodic-update",
  ]) {
    const reservations = new MutationReservationRegistry();
    let operationSequence = 0;
    const fake: Record<string, any> = {
      mutationResults: new Map(),
      mutationResultTimes: new Map(),
      mutationReservations: reservations,
      mutationPreflightFlights: new Map(),
      dataWriteChain: Promise.resolve(),
      dataWriteFailed: false,
      mutationOperationId: () => `${route}-operation-${++operationSequence}`,
      mutationHttpStatus: () => 200,
      queuePersistPluginData() {
        this.dataWriteChain = Promise.resolve();
      },
    };
    fake.activeMutationReservationResponse = (...args: unknown[]) =>
      active.call(fake, ...args);
    fake.mutationReplayOrValidation = (...args: unknown[]) =>
      replay.call(fake, ...args);
    fake.mutationPreflight = (...args: unknown[]) =>
      preflight.call(fake, ...args);
    fake.settleMutationPreflightFlight = (...args: unknown[]) =>
      settle.call(fake, ...args);
    fake.promoteMutationPreflightFlight = (...args: unknown[]) =>
      promote.call(fake, ...args);

    let releaseGate!: () => void;
    let reportGateEntered!: () => void;
    const gateEntered = new Promise<void>((resolve) => {
      reportGateEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let prepareCalls = 0;
    const idempotencyKey = `${route}-same-key`;
    const signature = `${route}-same-signature`;
    const requested = { route };
    const prepare = async () => {
      prepareCalls += 1;
      reportGateEntered();
      await gate;
      return { kind: "ready" as const, value: { route } };
    };

    const leader = coordinated.call(fake, {
      idempotencyKey,
      signature,
      requested,
      failureScope: {},
      prepare,
    });
    await gateEntered;
    const follower = coordinated.call(fake, {
      idempotencyKey,
      signature,
      requested,
      failureScope: {},
      prepare,
    });
    const conflict = await coordinated.call(fake, {
      idempotencyKey,
      signature: `${route}-different-signature`,
      requested: { route, different: true },
      failureScope: {},
      prepare: async () => {
        throw new Error("a conflicting request must not enter readiness");
      },
    });
    assert.equal(conflict.kind, "response");
    assert.equal(conflict.response.httpStatus, 409);
    assert.equal(prepareCalls, 1, `${route} must have one preflight leader`);

    releaseGate();
    const leaderResult = await leader;
    assert.equal(leaderResult.kind, "leader");
    assert.equal(prepareCalls, 1);
    const reservation = reservations.get(idempotencyKey);
    assert.ok(reservation, `${route} must promote to a durable reservation`);

    const terminal = {
      ok: true,
      operationId: reservation.operationId,
      idempotencyKey,
      status: "applied",
    };
    reservations.complete(idempotencyKey, signature, terminal);
    const followerResult = await follower;
    assert.equal(followerResult.kind, "response");
    assert.equal(followerResult.response.payload, terminal);
    assert.equal(fake.mutationPreflightFlights.size, 0);
  }
});

test("an existing-task replay arriving inside the runtime await joins the leader", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executeExisting = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const coordinated = BridgePlugin.prototype
    .coordinatedMutationPreflight as Function;
  const active = BridgePlugin.prototype
    .activeMutationReservationResponse as Function;
  const preflight = BridgePlugin.prototype.mutationPreflight as Function;
  const replay = BridgePlugin.prototype.mutationReplayOrValidation as Function;
  const settle = BridgePlugin.prototype
    .settleMutationPreflightFlight as Function;
  const promote = BridgePlugin.prototype
    .promoteMutationPreflightFlight as Function;
  const reservations = new MutationReservationRegistry();
  let operationSequence = 0;
  let runtimeCalls = 0;
  let nativeCalls = 0;
  let reportRuntimeEntered!: () => void;
  let releaseRuntime!: () => void;
  let reportNativeEntered!: () => void;
  let releaseNative!: () => void;
  const runtimeEntered = new Promise<void>((resolve) => {
    reportRuntimeEntered = resolve;
  });
  const runtimeGate = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  const nativeEntered = new Promise<void>((resolve) => {
    reportNativeEntered = resolve;
  });
  const nativeGate = new Promise<void>((resolve) => {
    releaseNative = resolve;
  });
  const runtime = {
    developerApi: {
      executeMutation: async () => {
        nativeCalls += 1;
        reportNativeEntered();
        await nativeGate;
        return { ok: true, code: "planned", planDigest: "digest" };
      },
    },
  };
  const fake: Record<string, any> = {
    mutationResults: new Map(),
    mutationResultTimes: new Map(),
    mutationReservations: reservations,
    mutationPreflightFlights: new Map(),
    dataWriteChain: Promise.resolve(),
    dataWriteFailed: false,
    mutationOperationId: () => `existing-${++operationSequence}`,
    mutationHttpStatus: () => 200,
    queuePersistPluginData() {
      this.dataWriteChain = Promise.resolve();
    },
    requireMutationRuntime: async () => {
      runtimeCalls += 1;
      reportRuntimeEntered();
      await runtimeGate;
      return runtime;
    },
    oneTask: async () => ({
      task: { operonId: "task-1", revision: "revision-1" },
    }),
    cacheMutation(
      idempotencyKey: string,
      signature: string,
      payload: Record<string, unknown>,
    ) {
      this.mutationResults.set(idempotencyKey, { signature, payload });
      reservations.complete(idempotencyKey, signature, payload);
    },
  };
  fake.activeMutationReservationResponse = (...args: unknown[]) =>
    active.call(fake, ...args);
  fake.mutationReplayOrValidation = (...args: unknown[]) =>
    replay.call(fake, ...args);
  fake.mutationPreflight = (...args: unknown[]) =>
    preflight.call(fake, ...args);
  fake.settleMutationPreflightFlight = (...args: unknown[]) =>
    settle.call(fake, ...args);
  fake.promoteMutationPreflightFlight = (...args: unknown[]) =>
    promote.call(fake, ...args);
  fake.coordinatedMutationPreflight = (...args: unknown[]) =>
    coordinated.call(fake, ...args);

  const body = {
    idempotencyKey: "interleaving-key",
    expectedRevision: "revision-1",
    dryRun: true,
  };
  const requested = { description: "updated" };
  const leader = executeExisting.call(
    fake,
    "update",
    "task-1",
    body,
    requested,
    async () => ({ ok: true }),
    {},
  );
  await runtimeEntered;
  const follower = executeExisting.call(
    fake,
    "update",
    "task-1",
    body,
    requested,
    async () => {
      throw new Error("the follower must not dispatch a fallback mutation");
    },
    {},
  );
  await Promise.resolve();
  assert.equal(runtimeCalls, 1);
  assert.equal(nativeCalls, 0);

  releaseRuntime();
  await nativeEntered;
  assert.equal(runtimeCalls, 1);
  assert.equal(nativeCalls, 1);
  releaseNative();

  const [leaderResult, followerResult] = await Promise.all([leader, follower]);
  assert.equal(leaderResult.httpStatus, 200);
  assert.equal(followerResult.httpStatus, 200);
  assert.equal(followerResult.payload, leaderResult.payload);
  assert.equal(runtimeCalls, 1);
  assert.equal(nativeCalls, 1);
});

test("a rejected ephemeral preflight releases the key without durable uncertainty", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const coordinated = BridgePlugin.prototype
    .coordinatedMutationPreflight as Function;
  const active = BridgePlugin.prototype
    .activeMutationReservationResponse as Function;
  const preflight = BridgePlugin.prototype.mutationPreflight as Function;
  const replay = BridgePlugin.prototype.mutationReplayOrValidation as Function;
  const settle = BridgePlugin.prototype
    .settleMutationPreflightFlight as Function;
  const promote = BridgePlugin.prototype
    .promoteMutationPreflightFlight as Function;
  const reservations = new MutationReservationRegistry();
  let operationSequence = 0;
  const fake: Record<string, any> = {
    mutationResults: new Map(),
    mutationResultTimes: new Map(),
    mutationReservations: reservations,
    mutationPreflightFlights: new Map(),
    dataWriteChain: Promise.resolve(),
    dataWriteFailed: false,
    mutationOperationId: () => `pre-dispatch-${++operationSequence}`,
    mutationHttpStatus: () => 200,
    queuePersistPluginData() {
      this.dataWriteChain = Promise.resolve();
    },
  };
  fake.activeMutationReservationResponse = (...args: unknown[]) =>
    active.call(fake, ...args);
  fake.mutationReplayOrValidation = (...args: unknown[]) =>
    replay.call(fake, ...args);
  fake.mutationPreflight = (...args: unknown[]) =>
    preflight.call(fake, ...args);
  fake.settleMutationPreflightFlight = (...args: unknown[]) =>
    settle.call(fake, ...args);
  fake.promoteMutationPreflightFlight = (...args: unknown[]) =>
    promote.call(fake, ...args);

  let releaseGate!: () => void;
  let reportGateEntered!: () => void;
  const gateEntered = new Promise<void>((resolve) => {
    reportGateEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const safeFailure = new Error("runtime unavailable before dispatch");
  const request = {
    idempotencyKey: "safe-retry-key",
    signature: "safe-retry-signature",
    requested: { route: "create" },
    failureScope: {},
  };
  const prepareFailure = async () => {
    reportGateEntered();
    await gate;
    throw safeFailure;
  };
  const leader = coordinated.call(fake, {
    ...request,
    prepare: prepareFailure,
  });
  await gateEntered;
  const follower = coordinated.call(fake, {
    ...request,
    prepare: prepareFailure,
  });
  releaseGate();
  await assert.rejects(leader, /runtime unavailable before dispatch/u);
  await assert.rejects(follower, /runtime unavailable before dispatch/u);
  assert.equal(reservations.get(request.idempotencyKey), undefined);
  assert.equal(fake.mutationPreflightFlights.size, 0);

  const retry = await coordinated.call(fake, {
    ...request,
    prepare: async () => ({ kind: "ready", value: "runtime-restored" }),
  });
  assert.equal(retry.kind, "leader");
  const reservation = reservations.get(request.idempotencyKey);
  assert.ok(
    reservation,
    "the same key must be safely reservable after recovery",
  );
  reservations.complete(request.idempotencyKey, request.signature, {
    ok: true,
    status: "applied",
  });
  await Promise.resolve();
  assert.equal(fake.mutationPreflightFlights.size, 0);
});

test("every replayable native mutation route coordinates before asynchronous readiness gates", () => {
  const mainSource = readFileSync(
    new URL("./main.ts", import.meta.url),
    "utf8",
  );
  const routes = [
    [
      "executeRecoveryMutation",
      "private taskWorkflowKind(",
      "requireDeveloperApiMutationRuntime()",
    ],
    [
      "executeTaskWorkflowRecoveryMutation",
      "private async executeAdoptMutation(",
      "requireTaskWorkflowRecoveryRuntime(kind)",
    ],
    [
      "executeAdoptMutation",
      "private async executePeriodicCreateMutation(",
      'requireMutationRuntime("adopt")',
    ],
    [
      "executePeriodicCreateMutation",
      "private async executePeriodicUpdateMutation(",
      'requireTaskWorkflowRuntime("periodic-create")',
    ],
    [
      "executePeriodicUpdateMutation",
      "private async taskWorkflowMutationPayload(",
      "requireTaskWorkflowRuntime(",
    ],
    [
      "executeExistingMutation",
      "private async executeCreateMutation(",
      "requireMutationRuntime(capability)",
    ],
    [
      "executeCreateMutation",
      "private tryMountRestExtension(",
      'requireMutationRuntime("create")',
    ],
  ] as const;

  for (const [method, nextMethod, runtimeGate] of routes) {
    const start = mainSource.indexOf(`private async ${method}(`);
    const end = mainSource.indexOf(nextMethod, start);
    assert.notEqual(start, -1, `${method} must exist`);
    assert.notEqual(end, -1, `${method} must have a bounded source slice`);
    const source = mainSource.slice(start, end);
    const coordination = source.indexOf("coordinatedMutationPreflight");
    const readiness = source.indexOf(runtimeGate);
    assert.notEqual(
      coordination,
      -1,
      `${method} must coordinate its asynchronous preflight`,
    );
    assert.notEqual(readiness, -1, `${method} must retain its runtime gate`);
    assert.ok(
      coordination < readiness,
      `${method} must claim the same-key preflight before readiness`,
    );
    assert.equal(
      source.includes("activeMutationReservationResponse("),
      false,
      `${method} must not reopen a check-then-await race outside coordination`,
    );
    assert.equal(
      source.includes("this.mutationPreflight("),
      false,
      `${method} must not create a durable reservation outside coordination`,
    );
    assert.match(
      source,
      /coordinatedMutationPreflight[\s\S]+failureScope,[\s\S]+prepare: async/u,
      `${method} must pass its route failure scope and asynchronous gates to coordination`,
    );
  }
});

test("periodic-create negotiates its exact grant before durable reservation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executePeriodicCreateMutation = BridgePlugin.prototype
    .executePeriodicCreateMutation as Function;
  let grantAvailable = false;
  let reservationCalls = 0;
  let nativeDispatches = 0;
  const runtime = {
    developerApi: {
      executeTaskWorkflow: async () => {
        nativeDispatches += 1;
        return { status: "planned" };
      },
    },
  };
  const fake: Record<string, any> = {
    mutationResults: { get: () => undefined },
    activeMutationReservationResponse: async () => null,
    mutationOperationId: () => "periodic-operation",
    requireTaskWorkflowRuntime: async () => {
      if (!grantAvailable) throw new Error("exact grant pending");
      return runtime;
    },
    mutationPreflight: async () => {
      reservationCalls += 1;
      return { kind: "continue" };
    },
    taskWorkflowMutationPayload: () => ({
      httpStatus: 200,
      payload: { status: "planned" },
    }),
  };
  await attachPassThroughCoordination(fake);
  const request = {
    idempotencyKey: "periodic-first-use",
    dryRun: true,
    periodic: {
      description: "Cold exact grant",
      periodicKind: "daily",
    },
  };

  await assert.rejects(
    () => executePeriodicCreateMutation.call(fake, request),
    /exact grant pending/u,
  );
  assert.equal(
    reservationCalls,
    0,
    "a pending consent must not create a durable idempotency reservation",
  );
  assert.equal(nativeDispatches, 0);

  grantAvailable = true;
  const result = await executePeriodicCreateMutation.call(fake, request);
  assert.equal(result.httpStatus, 200);
  assert.equal(reservationCalls, 1);
  assert.equal(nativeDispatches, 1);
});

test("a pending exact workflow grant is marked as a proven pre-dispatch failure", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const requireTaskWorkflowRuntime = BridgePlugin.prototype
    .requireTaskWorkflowRuntime as Function;
  const sendMutationFailure = BridgePlugin.prototype
    .sendMutationFailure as Function;
  const runtime = {
    compatible: true,
    indexer: { getAllTasks: () => [] },
    developerApi: {
      hasTaskWorkflowCapability: () => false,
      hasTaskWorkflowRecoverySupport: () => false,
      refreshTaskWorkflow: async () => false,
    },
  };
  const guard = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => runtime,
    requireSettledMutationIndex: async () => undefined,
  };
  let pendingError: unknown;
  try {
    await requireTaskWorkflowRuntime.call(guard, "periodic-create");
  } catch (error) {
    pendingError = error;
  }
  assert.ok(pendingError instanceof Error);

  let statusCode = 0;
  let payload: Record<string, any> | undefined;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: Record<string, any>) {
      payload = value;
    },
  };
  await sendMutationFailure.call(
    {
      failReservedMutation: () => {
        throw new Error(
          "a pre-dispatch grant failure must not touch another reservation",
        );
      },
      preDispatchMutationFailure: (
        _body: Record<string, unknown>,
        code: string,
      ) => ({
        httpStatus: 503,
        payload: {
          ok: false,
          contractVersion: "1",
          operationId: "8b7e2b7d-4c63-4470-8c28-2af9ddb0de61",
          idempotencyKey: "workflow-pre-dispatch-key",
          status: "not-ready",
          requested: {},
          retryable: true,
          mutationMayHaveApplied: false,
          source: "operon-live",
          stale: false,
          error: { code, message: "unavailable" },
        },
      }),
    },
    response,
    { idempotencyKey: "workflow-pre-dispatch-key" },
    pendingError,
    "mutation_unavailable",
    {},
  );
  assert.equal(statusCode, 503);
  assert.equal(payload?.error?.code, "task_workflow_capability_unavailable");
  assert.equal(payload?.retryable, true);
  assert.equal(payload?.mutationMayHaveApplied, false);
});

test("an active periodic-create reservation is joined before grant negotiation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executePeriodicCreateMutation = BridgePlugin.prototype
    .executePeriodicCreateMutation as Function;
  const activeMutationReservationResponse = BridgePlugin.prototype
    .activeMutationReservationResponse as Function;
  const requested = {
    description: "Concurrent periodic create",
    periodicKind: "daily",
  };
  const signature = JSON.stringify({
    capability: "periodic-create",
    dryRun: true,
    requested,
  });
  const activePayload = {
    ok: true,
    contractVersion: "1",
    operationId: "active-operation",
    idempotencyKey: "active-periodic-key",
    status: "planned",
    before: null,
    requested,
    after: null,
    source: "operon-live",
    stale: false,
  };
  let grantNegotiations = 0;
  const fake: Record<string, any> = {
    mutationResults: { get: () => undefined },
    mutationReservations: {
      get: () => ({
        signature,
        promise: Promise.resolve(activePayload),
      }),
    },
    mutationOperationId: () => "unused-operation",
    mutationHttpStatus: () => 200,
    requireTaskWorkflowRuntime: async () => {
      grantNegotiations += 1;
      throw new Error("must not negotiate while an operation is active");
    },
  };
  fake.activeMutationReservationResponse = (...args: unknown[]) =>
    activeMutationReservationResponse.call(fake, ...args);
  fake.mutationPreflight = async () => ({ kind: "continue" });
  await attachPassThroughCoordination(fake);

  const result = await executePeriodicCreateMutation.call(fake, {
    idempotencyKey: "active-periodic-key",
    dryRun: true,
    periodic: requested,
  });
  assert.equal(result.payload.operationId, "active-operation");
  assert.equal(grantNegotiations, 0);
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
      activeMutationReservationResponse: async () => null,
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
    await attachPassThroughCoordination(fake);
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
  const executeAdoptMutation = BridgePlugin.prototype
    .executeAdoptMutation as Function;
  let reservationCalls = 0;
  const fake = {
    mutationResults: { get: () => undefined },
    activeMutationReservationResponse: async () => null,
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
  await attachPassThroughCoordination(fake);
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

test("v1 and unproven v2 not-ready receipts remain terminal after reload", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype.restoreMutationJournal as Function;
  const executeExisting = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const requested = { description: "retry must stay closed" };
  const signature = existingMutationSignature("update", requested);
  const updatedAt = new Date().toISOString();

  for (const journal of [
    {
      label: "v1 with injected provenance",
      version: 1,
      entry: { dispatchProvenance: "proven-pre-dispatch" },
      payload: { ok: false },
    },
    {
      label: "v2 without provenance",
      version: 2,
      entry: {},
      payload: { ok: false },
    },
    {
      label: "v2 unknown provenance",
      version: 2,
      entry: { dispatchProvenance: "unknown-or-dispatched" },
      payload: { ok: false },
    },
    {
      label: "v2 proven marker without explicit ok false",
      version: 2,
      entry: { dispatchProvenance: "proven-pre-dispatch" },
      payload: {},
    },
    {
      label: "v2 proven marker with contradictory ok true",
      version: 2,
      entry: { dispatchProvenance: "proven-pre-dispatch" },
      payload: { ok: true },
    },
  ]) {
    const { fake, nativeCalls } = await durableExistingMutationFake({
      native: () => ({ ok: true, code: "planned", retryable: false }),
    });
    restore.call(fake, {
      version: journal.version,
      entries: [
        {
          idempotencyKey: `terminal-${journal.label}`,
          signature,
          state: "terminal",
          updatedAt,
          operationId: "prior-operation",
          payload: {
            ...journal.payload,
            operationId: "prior-operation",
            status: "not-ready",
            mutationMayHaveApplied: false,
          },
          httpStatus: 503,
          ...journal.entry,
        },
      ],
    });

    const result = await executeExisting.call(
      fake,
      "update",
      "task-1",
      {
        idempotencyKey: `terminal-${journal.label}`,
        expectedRevision: "revision-1",
        dryRun: true,
      },
      requested,
      async () => {
        throw new Error("terminal receipts must not use the legacy fallback");
      },
    );
    assert.equal(result.httpStatus, 503, journal.label);
    assert.equal(result.payload.replayed, true, journal.label);
    assert.equal(nativeCalls(), 0, journal.label);
  }
});

test("journal versions are not coerced into the v2 provenance contract", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype.restoreMutationJournal as Function;
  const fake = {
    mutationResults: new Map(),
    mutationResultTimes: new Map(),
    mutationReservations: new MutationReservationRegistry(),
    taskWorkflowIdentities: new Map(),
    queuePersistPluginData: () => undefined,
  };
  restore.call(fake, {
    version: "2",
    entries: [
      {
        idempotencyKey: "coerced-version",
        signature: "coerced-signature",
        state: "terminal",
        updatedAt: new Date().toISOString(),
        operationId: "coerced-operation",
        payload: {
          ok: false,
          status: "not-ready",
          mutationMayHaveApplied: false,
        },
        dispatchProvenance: "proven-pre-dispatch",
      },
    ],
  });
  assert.equal(fake.mutationResults.size, 0);
});

test("a proven v2 pre-dispatch receipt is released durably before one native retry", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype.restoreMutationJournal as Function;
  const executeExisting = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const requested = {
    description: "retry after restored pre-dispatch receipt",
  };
  const signature = existingMutationSignature("update", requested);
  const { fake, nativeCalls } = await durableExistingMutationFake({
    native: () => ({ ok: true, code: "planned", retryable: false }),
  });
  restore.call(fake, {
    version: 2,
    entries: [
      {
        idempotencyKey: "proven-reload-key",
        signature,
        state: "terminal",
        updatedAt: new Date().toISOString(),
        operationId: "pre-dispatch-operation",
        payload: {
          ok: false,
          operationId: "pre-dispatch-operation",
          status: "not-ready",
          mutationMayHaveApplied: false,
        },
        httpStatus: 503,
        dispatchProvenance: "proven-pre-dispatch",
      },
    ],
  });

  const result = await executeExisting.call(
    fake,
    "update",
    "task-1",
    {
      idempotencyKey: "proven-reload-key",
      expectedRevision: "revision-1",
      dryRun: true,
    },
    requested,
    async () => ({ ok: true }),
  );
  assert.equal(result.httpStatus, 200);
  assert.equal(nativeCalls(), 1);
  assert.ok(
    fake.saved.some((snapshot: Record<string, any>) => {
      const entries = snapshot.mutationJournal?.entries ?? [];
      return (
        !entries.some(
          (entry: Record<string, unknown>) =>
            entry.idempotencyKey === "proven-reload-key" &&
            entry.state === "terminal",
        ) &&
        entries.some(
          (entry: Record<string, unknown>) =>
            entry.idempotencyKey === "proven-reload-key" &&
            entry.state === "in-progress",
        )
      );
    }),
    "the old terminal receipt must be durably released before native dispatch",
  );
});

test("concurrent retries of one restored proven receipt dispatch exactly once", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype.restoreMutationJournal as Function;
  const executeExisting = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const coordinated = BridgePlugin.prototype
    .coordinatedMutationPreflight as Function;
  const active = BridgePlugin.prototype
    .activeMutationReservationResponse as Function;
  const settle = BridgePlugin.prototype
    .settleMutationPreflightFlight as Function;
  const promote = BridgePlugin.prototype
    .promoteMutationPreflightFlight as Function;
  let reportNativeEntered!: () => void;
  let releaseNative!: () => void;
  const nativeEntered = new Promise<void>((resolve) => {
    reportNativeEntered = resolve;
  });
  const nativeGate = new Promise<void>((resolve) => {
    releaseNative = resolve;
  });
  const requested = { description: "one concurrent retry" };
  const signature = existingMutationSignature("update", requested);
  const runtime = await durableExistingMutationFake({
    native: async () => {
      reportNativeEntered();
      await nativeGate;
      return { ok: true, code: "planned", retryable: false };
    },
  });
  runtime.fake.activeMutationReservationResponse = (...args: unknown[]) =>
    active.call(runtime.fake, ...args);
  runtime.fake.settleMutationPreflightFlight = (...args: unknown[]) =>
    settle.call(runtime.fake, ...args);
  runtime.fake.promoteMutationPreflightFlight = (...args: unknown[]) =>
    promote.call(runtime.fake, ...args);
  runtime.fake.coordinatedMutationPreflight = (options: unknown) =>
    coordinated.call(runtime.fake, options);
  restore.call(runtime.fake, {
    version: 2,
    entries: [
      {
        idempotencyKey: "concurrent-proven-reload",
        signature,
        state: "terminal",
        updatedAt: new Date().toISOString(),
        operationId: "prior-proven-operation",
        payload: {
          ok: false,
          status: "not-ready",
          mutationMayHaveApplied: false,
        },
        httpStatus: 503,
        dispatchProvenance: "proven-pre-dispatch",
      },
    ],
  });
  const body = {
    idempotencyKey: "concurrent-proven-reload",
    expectedRevision: "revision-1",
    dryRun: true,
  };
  const leader = executeExisting.call(
    runtime.fake,
    "update",
    "task-1",
    body,
    requested,
    async () => ({ ok: true }),
  );
  await nativeEntered;
  const follower = executeExisting.call(
    runtime.fake,
    "update",
    "task-1",
    body,
    requested,
    async () => ({ ok: true }),
  );
  releaseNative();
  const [leaderResult, followerResult] = await Promise.all([leader, follower]);
  assert.equal(runtime.nativeCalls(), 1);
  assert.equal(leaderResult.httpStatus, 200);
  assert.equal(followerResult.httpStatus, 200);
  assert.equal(
    followerResult.payload.operationId,
    leaderResult.payload.operationId,
  );
});

test("generic existing-task routes retry only proven pre-dispatch not-ready receipts", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executeExisting = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const routes = [
    ["update", { description: "updated" }],
    ["transition", { status: "Project.Done" }],
    ["relationships", { blockedBy: [] }],
    ["recurrence", { scope: "this-task", changes: {} }],
    ["convert", { target: "file", targetFolder: "Tasks" }],
    ["relocate", { targetPath: "Tasks/Relocated.md" }],
  ] as const;

  for (const [capability, requested] of routes) {
    const successful = await durableExistingMutationFake({
      native: (() => {
        const outcomes = [
          {
            ok: false,
            code: "not-ready",
            retryable: true,
            mutationMayHaveApplied: false,
          },
          { ok: true, code: "planned", retryable: false },
        ];
        return () => outcomes.shift()!;
      })(),
    });
    const body = {
      idempotencyKey: `${capability}-proven-retry`,
      expectedRevision: "revision-1",
      dryRun: true,
    };
    const first = await executeExisting.call(
      successful.fake,
      capability,
      "task-1",
      body,
      requested,
      async () => ({ ok: true }),
    );
    const retry = await executeExisting.call(
      successful.fake,
      capability,
      "task-1",
      body,
      requested,
      async () => ({ ok: true }),
    );
    assert.equal(first.httpStatus, 503, capability);
    assert.equal(retry.httpStatus, 200, capability);
    assert.equal(successful.nativeCalls(), 2, capability);

    for (const mutationMayHaveApplied of [true, undefined]) {
      const ambiguous = await durableExistingMutationFake({
        native: () => ({
          ok: false,
          code: "not-ready",
          retryable: true,
          ...(mutationMayHaveApplied === undefined
            ? {}
            : { mutationMayHaveApplied }),
        }),
      });
      const ambiguousBody = {
        ...body,
        idempotencyKey: `${capability}-ambiguous-${String(
          mutationMayHaveApplied,
        )}`,
      };
      const ambiguousFirst = await executeExisting.call(
        ambiguous.fake,
        capability,
        "task-1",
        ambiguousBody,
        requested,
        async () => ({ ok: true }),
      );
      const ambiguousReplay = await executeExisting.call(
        ambiguous.fake,
        capability,
        "task-1",
        ambiguousBody,
        requested,
        async () => ({ ok: true }),
      );
      assert.equal(ambiguousFirst.httpStatus, 503, capability);
      assert.equal(ambiguousReplay.httpStatus, 503, capability);
      assert.equal(ambiguousReplay.payload.replayed, true, capability);
      assert.equal(ambiguous.nativeCalls(), 1, capability);
    }
  }
});

test("malformed native booleans never mint pre-dispatch provenance", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const executeExisting = BridgePlugin.prototype
    .executeExistingMutation as Function;
  const requested = { description: "malformed native response" };

  for (const nativeOk of [undefined, 0, true]) {
    const runtime = await durableExistingMutationFake({
      native: () => ({
        ok: nativeOk,
        code: "not-ready",
        retryable: true,
        mutationMayHaveApplied: false,
      }),
    });
    const body = {
      idempotencyKey: `malformed-native-ok-${String(nativeOk)}`,
      expectedRevision: "revision-1",
      dryRun: true,
    };
    const first = await executeExisting.call(
      runtime.fake,
      "update",
      "task-1",
      body,
      requested,
      async () => ({ ok: true }),
    );
    const replay = await executeExisting.call(
      runtime.fake,
      "update",
      "task-1",
      body,
      requested,
      async () => ({ ok: true }),
    );
    assert.equal(runtime.nativeCalls(), 1, String(nativeOk));
    assert.equal(replay.payload.replayed, true, String(nativeOk));
    assert.equal(
      runtime.fake.mutationResults.get(body.idempotencyKey)?.dispatchProvenance,
      "unknown-or-dispatched",
      String(nativeOk),
    );
    assert.equal(replay.httpStatus, first.httpStatus, String(nativeOk));
  }
});

test("a failed durable release preserves the proven receipt and creates no reservation", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const preflight = BridgePlugin.prototype.mutationPreflight as Function;
  const cached = {
    signature: "safe-release-signature",
    payload: {
      ok: false,
      status: "not-ready",
      mutationMayHaveApplied: false,
    },
    httpStatus: 503,
    dispatchProvenance: "proven-pre-dispatch",
  };
  const fake: Record<string, any> = {
    mutationResults: new Map([["safe-release-key", cached]]),
    mutationResultTimes: new Map([
      ["safe-release-key", new Date().toISOString()],
    ]),
    mutationReservations: new MutationReservationRegistry(),
    dataWriteChain: Promise.resolve(),
    dataWriteFailed: false,
    mutationOperationId: () => "must-not-reserve",
    mutationReplayOrValidation: () => ({ kind: "continue" }),
    queuePersistPluginData() {
      this.dataWriteChain = Promise.resolve().then(() => {
        this.dataWriteFailed = true;
      });
    },
  };

  await assert.rejects(
    preflight.call(
      fake,
      "safe-release-key",
      "safe-release-signature",
      { description: "same request" },
      () => null,
    ),
    /could not be released durably/u,
  );
  assert.equal(fake.mutationResults.get("safe-release-key"), cached);
  assert.equal(fake.mutationReservations.get("safe-release-key"), undefined);
});

test("journal v1 migration preserves terminal receipts and promotes interrupted work to unknown", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype.restoreMutationJournal as Function;
  const mutationJournalEntries = BridgePlugin.prototype
    .mutationJournalEntries as Function;
  const persist = BridgePlugin.prototype.persistPluginData as Function;
  const queue = BridgePlugin.prototype.queuePersistPluginData as Function;
  const mutationHttpStatus = BridgePlugin.prototype
    .mutationHttpStatus as Function;
  const updatedAt = new Date().toISOString();
  const fake: Record<string, any> = {
    settings: { mutationsEnabled: true },
    mutationResults: new Map(),
    mutationResultTimes: new Map(),
    mutationReservations: new MutationReservationRegistry(),
    taskWorkflowIdentities: new Map(),
    dataWriteChain: Promise.resolve(),
    dataWriteFailed: false,
    saved: undefined,
    mutationHttpStatus(payload: Record<string, unknown>) {
      return mutationHttpStatus.call(this, payload);
    },
    mutationJournalEntries() {
      return mutationJournalEntries.call(this);
    },
    taskWorkflowIdentityEntries: () => [],
    persistPluginData() {
      return persist.call(this);
    },
    queuePersistPluginData() {
      return queue.call(this);
    },
    saveData: async (value: Record<string, unknown>) => {
      fake.saved = structuredClone(value);
    },
  };
  restore.call(fake, {
    version: 1,
    entries: [
      {
        idempotencyKey: "v1-applied",
        signature: "applied-signature",
        state: "terminal",
        updatedAt,
        operationId: "applied-operation",
        payload: { ok: true, status: "applied" },
        httpStatus: 200,
      },
      {
        idempotencyKey: "v1-unknown",
        signature: "unknown-signature",
        state: "terminal",
        updatedAt,
        operationId: "unknown-operation",
        payload: {
          ok: false,
          status: "outcome-unknown",
          mutationMayHaveApplied: true,
        },
        httpStatus: 500,
      },
      {
        idempotencyKey: "v1-interrupted",
        signature: "interrupted-signature",
        state: "in-progress",
        updatedAt,
        operationId: "interrupted-operation",
        requested: { description: "interrupted" },
      },
    ],
  });
  await fake.dataWriteChain;

  assert.equal(
    fake.mutationResults.get("v1-applied")?.payload.status,
    "applied",
  );
  assert.equal(
    fake.mutationResults.get("v1-unknown")?.payload.status,
    "outcome-unknown",
  );
  assert.equal(
    fake.mutationResults.get("v1-interrupted")?.payload.status,
    "outcome-unknown",
  );
  assert.equal(
    fake.mutationResults.get("v1-interrupted")?.payload.recoveryRequired,
    true,
  );
  const persisted = fake.saved?.mutationJournal;
  assert.equal(persisted?.version, 2);
  const persistedStates = new Map(
    persisted.entries.map((entry: Record<string, unknown>) => {
      const payload = entry.payload as Record<string, unknown> | undefined;
      return [entry.idempotencyKey, payload?.status];
    }),
  );
  assert.equal(persistedStates.get("v1-applied"), "applied");
  assert.equal(persistedStates.get("v1-unknown"), "outcome-unknown");
  assert.equal(persistedStates.get("v1-interrupted"), "outcome-unknown");
});

test("adopt, periodic, and generic mutation paths all delegate replay policy to the bridge helper", () => {
  const mainSource = readFileSync(
    new URL("./main.ts", import.meta.url),
    "utf8",
  );
  const methods = [
    "executeAdoptMutation",
    "executePeriodicCreateMutation",
    "executePeriodicUpdateMutation",
    "executeExistingMutation",
  ];
  for (const method of methods) {
    const start = mainSource.indexOf(`private async ${method}(`);
    const end = mainSource.indexOf("\n  private ", start + 1);
    assert.notEqual(start, -1, `${method} must exist`);
    assert.notEqual(end, -1, `${method} must have a bounded source slice`);
    assert.match(
      mainSource.slice(start, end),
      /(?:await\s+)?this\.mutationReplayOrValidation\(/u,
      `${method} must use the common durable replay policy`,
    );
  }
});

test("task-workflow replay identities survive plugin-data persistence", async () => {
  const BridgePlugin = await loadBridgePluginClassForTest();
  const restore = BridgePlugin.prototype
    .restoreTaskWorkflowIdentities as Function;
  const entries = BridgePlugin.prototype
    .taskWorkflowIdentityEntries as Function;
  const identityStore = BridgePlugin.prototype
    .taskWorkflowIdentityStore as Function;
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
  const mainSource = readFileSync(
    new URL("./main.ts", import.meta.url),
    "utf8",
  );
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

  const dryRunEnd = executeSource.indexOf(
    "if (!native.ok || !native.operonId)",
  );
  const postDispatchStart = executeSource.indexOf(
    "if (!native.ok || !native.operonId)",
  );
  const postDispatchEnd = executeSource.indexOf(
    "let afterRead:",
    postDispatchStart,
  );
  const finalPayloadStart = executeSource.indexOf(
    "const payload = {",
    executeSource.indexOf("const applied ="),
  );
  assert.equal(
    executeSource.slice(0, dryRunEnd).includes("nativeProof"),
    false,
  );
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
  const terminal = {
    ok: true,
    operationId: "operation-one",
    status: "applied",
  };
  registry.complete("same-key", "same-signature", terminal);
  assert.equal(await second.reservation.promise, terminal);
});

test("durable terminal replay preserves HTTP and interrupted reservations recover uncertainty", () => {
  const replay = resolveMutationPreflight({
    cached: {
      signature: "signature",
      payload: {
        ok: false,
        operationId: "operation-one",
        status: "outcome-unknown",
      },
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
  assert.equal(
    workflowStatusMatches(after, "st_project_done", workflowPipelines),
    true,
  );
  assert.equal(
    workflowStatusMatches(after, "Project.Done", workflowPipelines),
    true,
  );
  assert.equal(
    workflowStatusMatches(after, "Planned", workflowPipelines),
    false,
  );

  const ambiguousPipelines = [
    ...workflowPipelines,
    {
      id: "pl_pipeline",
      name: "Pipeline",
      statuses: [{ id: "st_pipeline_done", label: "Done" }],
    },
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
  indexing: {
    excludedFolders: [],
    fullReindexOnStartup: false,
    indexEventDebounceMs: 250,
  },
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
  primary: {
    filePath: "Efforts/Projets/Bridge.md",
    lineNumber: 4,
    format: "inline",
  },
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
    frontmatter: {
      status: "Project.InProgress",
      priority: "A",
      rang: 4,
      north_star: true,
    },
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
  assert.match(
    OPERON_BRIDGE_DENIED_DEVELOPER_API_VERSIONS["3.0.0"] ?? "",
    /predates/u,
  );
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
  assert.equal(
    isIndexReady({ compatible: true, generation: 1, diagnostics: healthy }),
    true,
  );
  assert.equal(
    isIndexReady({ compatible: true, generation: 0, diagnostics: healthy }),
    false,
  );
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
  assert.equal(
    isIndexReady({ compatible: true, generation: 1, diagnostics: null }),
    false,
  );
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
      "task workflow recovery",
      BridgePlugin.prototype.requireTaskWorkflowRecoveryRuntime as Function,
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
      indexer: { getAllTasks: () => [] },
      developerApi: {
        hasMutationCapability: () => true,
        hasTaskWorkflowCapability: () => true,
        hasRecoverySupport: () => true,
        refreshRecovery: async () => true,
        hasTaskWorkflowRecoverySupport: () => true,
        refreshTaskWorkflowRecovery: async () => true,
      },
    };
    const fake = {
      settings: { mutationsEnabled: true },
      requireRuntime: () => runtime,
      indexState: async () => ({
        ready: true,
        diagnostics: { taskCount: 0 },
      }),
      runtimeTaskCount: BridgePlugin.prototype.runtimeTaskCount,
      isSettledRuntimeIndex: BridgePlugin.prototype.isSettledRuntimeIndex,
      requireSettledMutationIndex:
        BridgePlugin.prototype.requireSettledMutationIndex,
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
    indexer: { getAllTasks: () => [] },
    developerApi: {
      hasMutationCapability: () => negotiated,
      hasTaskWorkflowCapability: () => negotiated,
      hasRecoverySupport: () => negotiated,
      hasTaskWorkflowRecoverySupport: () => negotiated,
      refreshTaskWorkflowRecovery: async () => {
        negotiated = true;
        return true;
      },
    },
  };
  const cold = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => coldRuntime,
    indexState: async () => {
      negotiated = true;
      return { ready: true, diagnostics: { taskCount: 0 } };
    },
    runtimeTaskCount: BridgePlugin.prototype.runtimeTaskCount,
    isSettledRuntimeIndex: BridgePlugin.prototype.isSettledRuntimeIndex,
    requireSettledMutationIndex:
      BridgePlugin.prototype.requireSettledMutationIndex,
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

  let exactWorkflowNegotiation: string | null = null;
  let workflowNegotiated = false;
  const workflowColdRuntime = {
    version: "99.0.0",
    compatible: true,
    indexer: { getAllTasks: () => [] },
    developerApi: {
      hasTaskWorkflowCapability: () => workflowNegotiated,
      hasTaskWorkflowRecoverySupport: () => workflowNegotiated,
      refreshTaskWorkflow: async (kind: string) => {
        exactWorkflowNegotiation = kind;
        workflowNegotiated = true;
        return true;
      },
    },
  };
  const workflowCold = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => workflowColdRuntime,
    indexState: async () => ({
      ready: true,
      diagnostics: { taskCount: 0 },
    }),
    runtimeTaskCount: BridgePlugin.prototype.runtimeTaskCount,
    isSettledRuntimeIndex: BridgePlugin.prototype.isSettledRuntimeIndex,
    requireSettledMutationIndex:
      BridgePlugin.prototype.requireSettledMutationIndex,
  };
  assert.equal(
    await BridgePlugin.prototype.requireTaskWorkflowRuntime.call(
      workflowCold,
      "periodic-create",
    ),
    workflowColdRuntime,
    "the first exact task-workflow operation must negotiate its additive grant",
  );
  assert.equal(exactWorkflowNegotiation, "periodic-create");
  workflowNegotiated = false;
  exactWorkflowNegotiation = null;
  assert.equal(
    await BridgePlugin.prototype.requireMutationRuntime.call(
      workflowCold,
      "adopt",
    ),
    workflowColdRuntime,
    "adoption must negotiate only its exact task-workflow grant on first use",
  );
  assert.equal(exactWorkflowNegotiation, "adopt");

  const unsettled = {
    ...cold,
    indexState: async () => ({
      ready: false,
      diagnostics: { taskCount: 0 },
    }),
  };
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireMutationRuntime.call(unsettled, "create"),
    /live index is not settled/u,
  );
  const countMismatch = {
    ...cold,
    indexState: async () => ({
      ready: true,
      diagnostics: { taskCount: 1 },
    }),
  };
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireTaskWorkflowRuntime.call(
        countMismatch,
        "periodic-create",
      ),
    /live index is not settled/u,
  );
  assert.equal(
    await BridgePlugin.prototype.requireTaskWorkflowRecoveryRuntime.call(
      unsettled,
      "periodic-create",
    ),
    coldRuntime,
    "task-workflow recovery must remain available while the live index is unsettled",
  );

  const missingCapabilityRuntime = {
    version: "99.0.0",
    compatible: true,
    indexer: { getAllTasks: () => [] },
    developerApi: {
      hasMutationCapability: () => false,
      hasTaskWorkflowCapability: () => false,
      hasRecoverySupport: () => false,
      hasTaskWorkflowRecoverySupport: () => false,
      refreshTaskWorkflow: async () => false,
      refreshTaskWorkflowRecovery: async () => false,
    },
  };
  const missingCapability = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => missingCapabilityRuntime,
    indexState: async () => ({
      ready: true,
      diagnostics: { taskCount: 0 },
    }),
    runtimeTaskCount: BridgePlugin.prototype.runtimeTaskCount,
    isSettledRuntimeIndex: BridgePlugin.prototype.isSettledRuntimeIndex,
    requireSettledMutationIndex:
      BridgePlugin.prototype.requireSettledMutationIndex,
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
    indexer: { getAllTasks: () => [] },
    developerApi: {
      hasMutationCapability: () => true,
      hasTaskWorkflowCapability: () => true,
      hasRecoverySupport: () => false,
      hasTaskWorkflowRecoverySupport: () => false,
      refreshTaskWorkflow: async () => false,
      refreshTaskWorkflowRecovery: async () => false,
    },
  };
  const missingRecovery = {
    settings: { mutationsEnabled: true },
    requireRuntime: () => missingRecoveryRuntime,
    indexState: async () => ({
      ready: true,
      diagnostics: { taskCount: 0 },
    }),
    runtimeTaskCount: BridgePlugin.prototype.runtimeTaskCount,
    isSettledRuntimeIndex: BridgePlugin.prototype.isSettledRuntimeIndex,
    requireSettledMutationIndex:
      BridgePlugin.prototype.requireSettledMutationIndex,
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
  await assert.rejects(
    async () =>
      BridgePlugin.prototype.requireTaskWorkflowRecoveryRuntime.call(
        missingRecovery,
        "periodic-create",
      ),
    /task-workflow Developer API recovery support is unavailable: periodic-create/u,
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
  let recoveryRefreshes = 0;
  const workflowRecoveryRefreshes: string[] = [];
  const adapter = {
    hasMutationCapability: () => true,
    hasTaskWorkflowCapability: () => true,
    hasReadCapability: () => true,
    hasFilterQueryCapability: () => true,
    hasRecoverySupport: () => true,
    hasTaskWorkflowRecoverySupport: () => true,
    refreshRecovery: async () => {
      recoveryRefreshes += 1;
      return true;
    },
    refreshTaskWorkflowRecovery: async (kind: string) => {
      workflowRecoveryRefreshes.push(kind);
      return true;
    },
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

  const dirtyIndexCapabilities = BridgePlugin.prototype.capabilities.call(
    fake,
    runtime,
    false,
  );
  assert.equal(dirtyIndexCapabilities.update, false);
  assert.equal(dirtyIndexCapabilities.adopt, false);
  assert.equal(
    dirtyIndexCapabilities.recovery,
    true,
    "core recovery must remain advertised while the live index is unsettled",
  );
  assert.equal(
    dirtyIndexCapabilities.taskWorkflowRecovery,
    true,
    "workflow recovery must remain advertised while the live index is unsettled",
  );
  assert.equal(recoveryRefreshes, 0);
  assert.deepEqual(
    workflowRecoveryRefreshes,
    [],
    "ordinary status must not negotiate optional recovery grants",
  );
  const recoveryStatus =
    await BridgePlugin.prototype.recoveryStatusPayload.call({
      getOperonRuntime: () => runtime,
      app: { plugins: {} },
      manifest: { id: "optimike-operon-bridge", version: "0.8.3" },
      settings: { mutationsEnabled: true },
      capabilities: BridgePlugin.prototype.capabilities,
    });
  assert.equal(recoveryStatus.ok, true);
  assert.deepEqual(recoveryStatus.capabilities, {
    recovery: true,
    taskWorkflowRecovery: true,
  });
  assert.equal(
    recoveryRefreshes,
    1,
    "the recovery-only status must negotiate without invoking indexState",
  );
  assert.deepEqual(workflowRecoveryRefreshes, [
    "adopt",
    "periodic-create",
    "periodic-update",
  ]);

  const disabledRecoveryCapabilities = BridgePlugin.prototype.capabilities.call(
    { settings: { mutationsEnabled: false } },
    runtime,
    false,
  );
  assert.equal(disabledRecoveryCapabilities.recovery, false);
  assert.equal(disabledRecoveryCapabilities.taskWorkflowRecovery, false);

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
    bridgeVersion: "0.8.3",
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
  assert.equal(
    filterTasks(tasks, { pathIncludes: ["Efforts/Projets"] }).length,
    1,
  );
  assert.equal(filterTasks(tasks, { tagsAll: ["elysia", "bridge"] }).length, 1);
  assert.equal(
    filterTasks(tasks, { fieldEquals: { custom: "signal" } }).length,
    1,
  );
  assert.equal(
    filterTasks(tasks, { propertyEquals: { north_star: true } }).length,
    1,
  );
  assert.equal(
    filterTasks(tasks, { dates: [{ field: "due", before: "2026-08-01" }] })
      .length,
    1,
  );
  assert.equal(filterTasks(tasks, { search: "ship bridge" }).length, 1);
  assert.equal(filterTasks(tasks, { statuses: ["Project.Planned"] }).length, 0);
  assert.equal(
    filterTasks(tasks, { statusIds: ["st_project_in_progress"] }).length,
    1,
  );
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
  const next = paginateTasks([second, first], {
    cursor: result.nextCursor,
    limit: 1,
  });
  assert.equal(next.tasks[0].operonId, "abc1234");
});

test("settings signature changes when the workflow contract changes", () => {
  const before = settingsSignature(semanticConfiguration);
  const after = settingsSignature({
    ...semanticConfiguration,
    workflow: {
      ...semanticConfiguration.workflow,
      defaultPipelineName: "ÉLYSIA",
    },
  });
  assert.notEqual(before, after);
});
