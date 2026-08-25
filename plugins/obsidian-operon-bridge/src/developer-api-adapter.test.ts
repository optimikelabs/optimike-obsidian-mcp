import assert from "node:assert/strict";
import test from "node:test";
import { OperonDeveloperApiRuntimeAdapter } from "./developer-api-adapter";

const consumer = {
  manifest: {
    id: "optimike-operon-bridge",
    name: "Optimike Operon Bridge",
    version: "0.8.1",
  },
};

function readyStatus(): Record<string, unknown> {
  return {
    availability: "available",
    reason: "ready",
    authority: "granted",
    admission: { reads: true, writes: false },
    grant: {
      state: "active",
      effectiveCapabilities: ["tasks.read", "tasks.query", "catalog.read"],
    },
  };
}

test("Operon 3 Developer API adapter reads a live task snapshot through the official accessor", async () => {
  let receivedConsumer: unknown;
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "system.diagnostics",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        lifecyclePhase: "ready",
        v8PersistencePhase: "idle",
        contextRevision: { index: { ramGeneration: 17 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({}),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-17",
        taxonomy: {
          defaultPipeline: {
            id: "pipeline-project",
            configuredValue: "Project",
          },
          pipelines: [
            {
              id: "pipeline-project",
              name: "Project",
              statuses: [{ id: "status-planned", label: "Planned" }],
            },
          ],
          priorities: [{ id: "priority-a", label: "A", isDefault: true }],
        },
        fields: [
          {
            canonicalKey: "priority",
            displayName: "priority",
            valueType: "text",
            source: "built-in",
            mappingStatus: "mapped",
            readable: true,
          },
        ],
        policies: {
          creation: {
            inlineTaskSaveMode: "active-file",
            defaultToFileTask: false,
          },
        },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [
          {
            identity: { operonId: "abc1234" },
            description: "Ship bridge",
            representation: "inline",
            locator: {
              representation: "inline",
              filePath: "Projects/Bridge.md",
              lineNumber: 4,
            },
            checkbox: "open",
            workflow: {
              pipeline: { id: "pipeline-project", label: "Project" },
              status: { id: "status-planned", label: "Planned" },
            },
            priority: { id: "priority-a", label: "A" },
            dates: { due: "2026-08-01" },
            datetimes: { modified: "2026-08-01T10:00:00Z" },
            relationships: { blockedByOperonIds: ["dep1234"] },
            customFields: { tags: ["elysia", "bridge"] },
          },
        ],
        page: { nextCursor: undefined },
        contextRevision: { index: { ramGeneration: 17 } },
      }),
    },
  };
  const operon = {
    getDeveloperApiV1: (candidate: unknown) => {
      receivedConsumer = candidate;
      return { ok: true, status: readyStatus(), api };
    },
  };

  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);
  assert.equal(await adapter.refresh(), true);
  assert.equal(receivedConsumer, consumer);
  assert.equal(adapter.indexer.getGeneration(), 17);
  assert.equal(adapter.indexer.taskCount, 1);
  assert.deepEqual(adapter.indexer.getTask("abc1234")?.tags, [
    "elysia",
    "bridge",
  ]);
  assert.equal(adapter.indexer.getTask("abc1234")?.primary.lineNumber, 4);
  assert.equal(adapter.pipelines[0]?.statuses[0]?.id, "status-planned");
  assert.equal(
    adapter.semanticConfiguration.workflow.defaultPipelineName,
    "Project",
  );
  assert.equal(
    (await adapter.indexer.getIndexV8Diagnostics()).health,
    "healthy",
  );
});

test("Operon 3.2 adapter evaluates saved filters through the additive task-workflow Developer API", async () => {
  let filterRequest: Record<string, unknown> = {};
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 32 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-32",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        filters: [
          {
            id: "filter-now",
            name: "Maintenant",
            icon: "zap",
            root: { type: "group", children: [] },
          },
        ],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { truncated: false },
        contextRevision: { index: { ramGeneration: 32 } },
      }),
    },
  };
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
    getTaskWorkflowDeveloperApiV1: (
      _candidate: unknown,
      request: { requestedCapabilities: readonly string[] },
    ) => ({
      contractVersion: 1,
      kind: "task-workflow-developer-api-access-result",
      ok: request.requestedCapabilities[0] === "tasks.filter-query",
      api: {
        contractVersion: 1,
        runtimeApi: 1,
        tasks: {
          filterQuery: async (input: Record<string, unknown>) => {
            filterRequest = input;
            return {
              contractVersion: 1,
              kind: "task-filter-query-result",
              requestId: input.requestId,
              ok: true,
              tasks: [],
              page: {
                actualCount: 0,
                returnedCount: 0,
                truncated: false,
                asOf: "2026-08-09T16:50:02Z",
              },
              contextRevision: { index: { ramGeneration: 32 } },
            };
          },
        },
      },
    }),
  };

  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);
  assert.equal(await adapter.refresh(), true);
  assert.equal(adapter.hasFilterQueryCapability(), true);
  assert.deepEqual(adapter.semanticConfiguration.views.filters[0], {
    id: "filter-now",
    name: "Maintenant",
    icon: "zap",
    definition: {
      id: "filter-now",
      name: "Maintenant",
      icon: "zap",
      root: { type: "group", children: [] },
    },
  });
  const result = await adapter.querySavedFilter({
    filterSetId: "filter-now",
    scopePath: "Efforts/Projets",
    includeProperties: true,
    limit: 25,
    cursor: "opaque-filter-cursor",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(filterRequest, {
    contractVersion: 1,
    requestId: filterRequest.requestId,
    kind: "task-filter-query",
    consistency: "live-verified",
    filterSetId: "filter-now",
    scope: { kind: "folder-tree", path: "Efforts/Projets" },
    include: ["custom-fields"],
    limit: 25,
    cursor: "opaque-filter-cursor",
  });
});

test("an unavailable Operon 3.2 filter accessor does not hide approved core reads or mutations", async () => {
  const granted = new Set([
    "system.health",
    "system.capabilities",
    "catalog.read",
    "tasks.read",
    "tasks.query",
    "tasks.update.preview",
    "tasks.update.apply",
  ]);
  const api = {
    hasCapability: (name: string) => granted.has(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 33 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-33",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { truncated: false },
        contextRevision: { index: { ramGeneration: 33 } },
      }),
    },
    mutations: {
      preview: async () => ({
        ok: true,
        plan: { planDigest: "filter-pending" },
      }),
      apply: async () => ({ status: "applied" as const }),
    },
  };
  const operon = {
    getDeveloperApiV1: (
      _candidate: unknown,
      request: { requestedCapabilities: readonly string[] },
    ) => ({
      ok: request.requestedCapabilities.every((capability) =>
        granted.has(capability),
      ),
      status: {
        ...readyStatus(),
        admission: { reads: true, writes: true },
        grant: {
          state: "active",
          grantedCapabilities: [...granted],
          effectiveCapabilities: request.requestedCapabilities,
        },
      },
      api,
    }),
    getTaskWorkflowDeveloperApiV1: () => ({
      contractVersion: 1,
      kind: "task-workflow-developer-api-access-result",
      ok: false,
      error: {
        code: "authority-insufficient",
        reason: "tasks.filter-query grant pending",
      },
    }),
  };

  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);
  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.indexer.getGeneration(), 33);
  assert.equal(adapter.hasMutationCapability("update"), true);
  assert.equal(adapter.hasFilterQueryCapability(), false);

  const throwingAdapter = new OperonDeveloperApiRuntimeAdapter(consumer, {
    ...operon,
    getTaskWorkflowDeveloperApiV1: () => {
      throw new Error("optional task-workflow accessor unavailable");
    },
  });
  assert.equal(await throwingAdapter.refresh(true), true);
  assert.equal(throwingAdapter.indexer.getGeneration(), 33);
  assert.equal(throwingAdapter.hasMutationCapability("update"), true);
  assert.equal(throwingAdapter.hasFilterQueryCapability(), false);
});

test("Operon 3 Developer API adapter stays unavailable when the host grant is pending", async () => {
  const operon = {
    getDeveloperApiV1: () => ({
      ok: false,
      status: {
        availability: "unavailable",
        reason: "grant-pending",
        grant: { state: "pending" },
      },
      error: {
        code: "authority-insufficient",
        reason: "Review the exact grant.",
      },
    }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);
  assert.equal(await adapter.refresh(), false);
  assert.equal(
    (await adapter.indexer.getIndexV8Diagnostics()).health,
    "unavailable",
  );
  assert.equal(adapter.indexer.taskCount, 0);
  assert.equal(adapter.status.reason, "grant-pending");
});

test("Operon 3 Developer API adapter retries the bounded cache-ready startup window", async () => {
  let healthCalls = 0;
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: {
      status: () =>
        healthCalls === 0
          ? {
              ...readyStatus(),
              availability: "degraded",
              reason: "cache-ready",
              retryAfterMs: 0,
            }
          : readyStatus(),
    },
    system: {
      health: async () => {
        healthCalls += 1;
        return healthCalls === 1
          ? { ok: false }
          : {
              ok: true,
              contextRevision: { index: { ramGeneration: 34 } },
            };
      },
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-34",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { truncated: false },
        contextRevision: { index: { ramGeneration: 34 } },
      }),
    },
  };
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: api.channel.status(), api }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(), true);
  assert.equal(healthCalls, 2);
  assert.equal(adapter.indexer.getGeneration(), 34);
  assert.equal(adapter.status.reason, "ready");
});

test("Operon 3 Developer API adapter turns malformed or throwing negotiation into diagnostics", async () => {
  const throwing = new OperonDeveloperApiRuntimeAdapter(consumer, {
    getDeveloperApiV1: () => {
      throw new Error("contract handshake failed");
    },
  });
  assert.equal(await throwing.refresh(), false);
  assert.equal(throwing.status.error?.reason, "contract handshake failed");
  assert.equal(throwing.negotiatedContractState, "invalid");

  const incomplete = new OperonDeveloperApiRuntimeAdapter(consumer, {
    getDeveloperApiV1: () => ({
      ok: true,
      status: readyStatus(),
      api: { hasCapability: () => true },
    }),
  });
  assert.equal(await incomplete.refresh(), false);
  assert.equal(
    incomplete.status.error?.reason,
    "Operon Developer API V1 negotiation returned an incomplete runtime contract.",
  );
  assert.equal(incomplete.negotiatedContractState, "invalid");
});

test("post-apply identity proof retries a stale live read without replaying the mutation", async () => {
  type LateTask = { identity: { operonId: string } };
  const target = {
    identity: { operonId: "late123" },
  };
  let readCalls = 0;
  const fake = {
    reloadLiveTasks: async () => ({
      tasks: [],
      rawTasks: readCalls++ === 0 ? [] : [target],
    }),
  };
  const proof = await (
    OperonDeveloperApiRuntimeAdapter.prototype as unknown as {
      findUniqueLiveTaskAfterMutation: (
        this: typeof fake,
        predicate: (task: LateTask) => boolean,
      ) => Promise<LateTask | null>;
    }
  ).findUniqueLiveTaskAfterMutation.call(
    fake,
    (task) => task.identity.operonId === "late123",
  );
  assert.equal(proof, target);
  assert.equal(readCalls, 2);
});

test("Operon 3 Developer API adapter keeps approved capabilities usable with a partial grant", async () => {
  const granted = new Set([
    "system.health",
    "system.capabilities",
    "catalog.read",
    "tasks.read",
    "tasks.query",
    "tasks.update.preview",
    "tasks.update.apply",
  ]);
  const requests: string[][] = [];
  const api = {
    hasCapability: (name: string) => granted.has(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 22 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-22",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { nextCursor: undefined, truncated: false },
        contextRevision: { index: { ramGeneration: 22 } },
      }),
    },
    mutations: {
      preview: async () => ({ ok: true, plan: { planDigest: "partial-plan" } }),
      apply: async () => ({ status: "applied" as const }),
      pendingRecoveries: async () => ({ ok: true, recoveries: [] }),
      recover: async () => ({ status: "already-applied" as const }),
    },
  };
  const operon = {
    getDeveloperApiV1: (
      _candidate: unknown,
      request: { requestedCapabilities: readonly string[] },
    ) => {
      requests.push([...request.requestedCapabilities]);
      const denied = request.requestedCapabilities.filter(
        (capability) => !granted.has(capability),
      );
      if (denied.length > 0) {
        return {
          ok: false,
          status: {
            ...readyStatus(),
            reason: "grant-pending",
            grant: {
              state: "pending",
              grantedCapabilities: [...granted],
              pendingCapabilities: denied,
            },
          },
          error: { code: "authority-insufficient", reason: "partial grant" },
        };
      }
      return {
        ok: true,
        status: {
          ...readyStatus(),
          grant: {
            state: "active",
            // The official baseline-only session does not disclose the
            // persisted non-baseline grant set; the adapter must probe core
            // capabilities independently before composing a read session.
            grantedCapabilities: request.requestedCapabilities.every(
              (capability) =>
                capability === "system.health" ||
                capability === "system.capabilities",
            )
              ? []
              : [...granted],
            effectiveCapabilities: [...request.requestedCapabilities],
          },
        },
        api,
      };
    },
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.hasMutationCapability("update"), true);
  assert.equal(adapter.hasMutationCapability("transition"), false);
  assert.equal(adapter.hasReadCapability("tasks.finder"), false);
  const missingRequests = requests
    .map((requested) =>
      requested.filter((capability) => !granted.has(capability)),
    )
    .filter((missing) => missing.length > 0);
  assert.equal(
    missingRequests.length > 0,
    true,
    "new capabilities must be requestable after a partial grant",
  );
  assert.equal(
    missingRequests.length,
    1,
    "the adapter must leave one exact capability-expansion request pending after approved probes",
  );
  assert.equal(
    missingRequests[0]?.includes("tasks.relationship.preview"),
    true,
  );
  assert.equal(missingRequests[0]?.includes("tasks.recurrence.apply"), true);
});

test("Operon 3 Developer API adapter previews and applies an exact typed update plan", async () => {
  const task = {
    identity: { operonId: "abc1234" },
    description: "Ship bridge",
    representation: "inline" as const,
    locator: {
      representation: "inline" as const,
      filePath: "Projects/Bridge.md",
      lineNumber: 4,
    },
    checkbox: "open" as const,
    workflow: {
      pipeline: { id: "pipeline-project", label: "Project" },
      status: { id: "status-planned", label: "Planned" },
    },
    dates: {},
    datetimes: { modified: "2026-08-01T10:00:00Z" },
    relationships: {},
    customFields: {},
    writableFields: [],
  };
  let previewInput: Record<string, unknown> | null = null;
  let appliedPlan: unknown = null;
  let nextExecution: Record<string, unknown> | null = null;
  const updatePlanDigest = "a".repeat(64);
  const updateRecoveryRef = `dvr1_${"a".repeat(48)}`;
  const validExecution = {
    contractVersion: 1,
    kind: "developer-mutation-execution-result",
    requestId: "base-update-apply-1",
    status: "applied",
    mutationMayHaveApplied: true,
    retryAllowed: false,
    groupResults: [
      {
        groupId: "update-task-source",
        status: "committed",
        resourceRevisions: [
          {
            resourceKind: "task-source",
            resourceKey: "Projects/Bridge.md",
            revision: "sha256:updated",
            privateValue: "must-not-cross-bridge",
          },
        ],
      },
    ],
    receipt: {
      contractVersion: 1,
      terminalOutcome: "applied",
      planDigest: updatePlanDigest,
      mutationKind: "task.update",
      targetDigest: "b".repeat(64),
      effectiveAt: "2026-08-24T00:00:01.000Z",
      completedAt: "2026-08-24T00:00:02.000Z",
      expiresAt: "2026-08-24T00:05:00.000Z",
      privateBody: "must-not-cross-bridge",
    },
    postflight: {
      status: "verified",
      observedAt: "2026-08-24T00:00:02.000Z",
      contextRevision: { privateFingerprint: "must-not-cross-bridge" },
    },
  };
  const typedUpdateRequest = {
    description: "Updated bridge",
    fields: {
      taskType: "article",
      taskImage: "[[Cover.png]]",
      taskGallery: ["[[One.png]]", "[[Two.png]]"],
    },
  };
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "system.diagnostics",
        "catalog.read",
        "tasks.read",
        "tasks.query",
        "tasks.update.preview",
        "tasks.update.apply",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        lifecyclePhase: "ready",
        v8PersistencePhase: "idle",
        contextRevision: { index: { ramGeneration: 18 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({}),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-18",
        taxonomy: {
          pipelines: [
            {
              id: "pipeline-project",
              name: "Project",
              statuses: [{ id: "status-planned", label: "Planned" }],
            },
          ],
        },
        fields: [
          {
            canonicalKey: "priority",
            displayName: "priority",
            valueType: "text",
            source: "built-in",
            mappingStatus: "mapped",
            readable: true,
          },
        ],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [task],
        page: { nextCursor: undefined },
        contextRevision: { index: { ramGeneration: 18 } },
      }),
      get: async () => ({ ok: true, task }),
    },
    mutations: {
      preview: async (input: Record<string, unknown>) => {
        previewInput = input;
        return {
          ok: true,
          plan: {
            planDigest: updatePlanDigest,
            recoveryRef: updateRecoveryRef,
            capability: "tasks.update.preview",
            mutationKind: "task.update",
          },
        };
      },
      apply: async ({ plan }: { plan: unknown }) => {
        appliedPlan = plan;
        const result = nextExecution ?? validExecution;
        nextExecution = null;
        return result;
      },
    },
  };
  const operon = {
    getDeveloperApiV1: (
      _consumer: unknown,
      options: { requestedCapabilities?: readonly string[] },
    ) => {
      const requestedCapabilities = options.requestedCapabilities ?? [];
      const mutationRequested =
        requestedCapabilities.includes("tasks.update.apply");
      return {
        ok: true,
        status: mutationRequested
          ? {
              ...readyStatus(),
              admission: { reads: true, writes: true },
              grant: {
                state: "active",
                effectiveCapabilities: requestedCapabilities,
              },
            }
          : readyStatus(),
        api,
      };
    },
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.hasMutationCapability("update"), true);
  assert.equal(adapter.status.admission?.writes, true);
  const result = await adapter.executeMutation(
    "update",
    "abc1234",
    typedUpdateRequest,
    false,
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, "applied");
  assert.equal(result.planDigest, updatePlanDigest);
  assert.equal(result.nativeProof?.kind, "mutation-result");
  assert.equal(result.nativeProof?.receipt?.mutationKind, "task.update");
  assert.equal("privateBody" in (result.nativeProof?.receipt ?? {}), false);
  assert.equal(
    "contextRevision" in (result.nativeProof?.postflight ?? {}),
    false,
  );
  assert.equal(
    "privateValue" in
      (result.nativeProof?.groupResults[0]?.resourceRevisions?.[0] ?? {}),
    false,
  );
  assert.deepEqual(previewInput, {
    capability: "tasks.update.preview",
    mutationKind: "task.update",
    target: {
      operonId: "abc1234",
      locator: {
        representation: "inline",
        filePath: "Projects/Bridge.md",
        lineNumber: 4,
      },
    },
    spec: {
      operation: "update",
      changes: [
        { field: "description", valueType: "text", value: "Updated bridge" },
        { field: "taskType", valueType: "text", value: "article" },
        { field: "taskImage", valueType: "text", value: "[[Cover.png]]" },
        {
          field: "taskGallery",
          valueType: "list",
          value: ["[[One.png]]", "[[Two.png]]"],
        },
      ],
    },
  });
  assert.deepEqual(appliedPlan, {
    planDigest: updatePlanDigest,
    recoveryRef: updateRecoveryRef,
    capability: "tasks.update.preview",
    mutationKind: "task.update",
  });
  const { postflight: _postflight, ...withoutPostflight } = validExecution;
  nextExecution = {
    ...withoutPostflight,
    requestId: "base-update-missing-postflight",
  };
  const missingPostflight = await adapter.executeMutation(
    "update",
    "abc1234",
    typedUpdateRequest,
    false,
  );
  assert.equal(missingPostflight.code, "outcome-unknown");
  assert.equal(missingPostflight.recoveryRef, updateRecoveryRef);
  assert.equal(missingPostflight.planDigest, updatePlanDigest);
  assert.equal(missingPostflight.mutationMayHaveApplied, true);
  assert.equal(missingPostflight.nativeProof, undefined);
  nextExecution = {
    ...validExecution,
    requestId: "base-update-wrong-digest",
    receipt: { ...validExecution.receipt, planDigest: "c".repeat(64) },
  };
  const wrongDigest = await adapter.executeMutation(
    "update",
    "abc1234",
    typedUpdateRequest,
    false,
  );
  assert.equal(wrongDigest.code, "outcome-unknown");
  assert.equal(wrongDigest.recoveryRef, updateRecoveryRef);
  assert.equal(wrongDigest.planDigest, updatePlanDigest);
  assert.equal(wrongDigest.mutationMayHaveApplied, true);
  assert.equal(wrongDigest.nativeProof, undefined);
  nextExecution = {
    ...validExecution,
    requestId: "base-update-empty-groups",
    groupResults: [],
  };
  const emptyCommittedGroups = await adapter.executeMutation(
    "update",
    "abc1234",
    typedUpdateRequest,
    false,
  );
  assert.equal(emptyCommittedGroups.code, "outcome-unknown");
  assert.equal(emptyCommittedGroups.recoveryRef, updateRecoveryRef);
  assert.equal(emptyCommittedGroups.planDigest, updatePlanDigest);
  assert.equal(emptyCommittedGroups.mutationMayHaveApplied, true);
  assert.equal(emptyCommittedGroups.nativeProof, undefined);
});

test("Operon 3 Developer API adapter recovers the same durable mutation plan", async () => {
  let liveReadsFail = false;
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "system.diagnostics",
        "catalog.read",
        "tasks.read",
        "tasks.query",
        "tasks.update.preview",
        "tasks.update.apply",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => {
        if (liveReadsFail) throw new Error("live index is dirty");
        return {
          ok: true,
          lifecyclePhase: "ready",
          v8PersistencePhase: "idle",
          contextRevision: { index: { ramGeneration: 19 } },
        };
      },
      capabilities: () => [],
      diagnostics: async () => ({}),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-19",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { nextCursor: undefined },
        contextRevision: { index: { ramGeneration: 19 } },
      }),
    },
    mutations: {
      preview: async () => ({
        ok: true,
        plan: { planDigest: "plan-recovery-1", recoveryRef: "recovery-1" },
      }),
      apply: async () => ({
        status: "applied" as const,
        receipt: { planDigest: "plan-recovery-1" },
      }),
      pendingRecoveries: async () => ({
        ok: true,
        recoveries: [
          {
            recoveryRef: "recovery-1",
            planDigest: "plan-recovery-1",
            mutationKind: "task.update",
          },
        ],
      }),
      recover: async ({ recoveryRef }: { recoveryRef: string }) => ({
        status: "already-applied" as const,
        mutationMayHaveApplied: true,
        receipt: {
          terminalOutcome: "already-applied",
          planDigest:
            recoveryRef === "recovery-1" ? "plan-recovery-1" : "wrong",
        },
      }),
    },
  };
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.hasRecoverySupport(), true);
  const pending = await adapter.pendingRecoveries();
  assert.equal(pending.ok, true);
  assert.equal(pending.recoveries[0]?.recoveryRef, "recovery-1");
  const recovered = await adapter.recoverMutation("recovery-1");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.code, "already-applied");
  assert.equal(recovered.recoveryRef, "recovery-1");
  assert.equal(recovered.planDigest, "plan-recovery-1");

  liveReadsFail = true;
  assert.equal(await adapter.refresh(true), false);
  assert.equal(
    adapter.hasRecoverySupport(),
    true,
    "a failed live read refresh must not destroy an established recovery session",
  );
  assert.equal(await adapter.refreshRecovery(), true);
  const recoveredWithDirtyIndex = await adapter.recoverMutation("recovery-1");
  assert.equal(recoveredWithDirtyIndex.code, "already-applied");
});

test("Operon 3 Developer API adapter builds official relationship and recurrence plans", async () => {
  const previews: Record<string, unknown>[] = [];
  const task = {
    identity: { operonId: "abc1234" },
    description: "Dependent task",
    representation: "inline",
    locator: {
      representation: "inline",
      filePath: "Projects/Bridge.md",
      lineNumber: 4,
    },
    checkbox: "open",
    workflow: {
      pipeline: { id: "pipeline-project", label: "Project" },
      status: { id: "status-planned", label: "Planned" },
    },
    dates: {},
    datetimes: { modified: "2026-08-08T01:00:00Z" },
    relationships: {
      parentOperonId: null,
      blockingOperonIds: [],
      blockedByOperonIds: [],
    },
    customFields: {},
    writableFields: [],
  };
  const api = {
    hasCapability: () => true,
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        lifecyclePhase: "ready",
        v8PersistencePhase: "idle",
        contextRevision: { index: { ramGeneration: 20 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({}),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-20",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [task],
        page: {},
        contextRevision: { index: { ramGeneration: 20 } },
      }),
      get: async () => ({ ok: true, task }),
    },
    mutations: {
      preview: async (input: Record<string, unknown>) => {
        previews.push(input);
        return {
          ok: true,
          plan: {
            planDigest: `plan-${previews.length}`,
            recoveryRef: `recovery-${previews.length}`,
          },
        };
      },
      apply: async () => ({ status: "applied" as const, receipt: {} }),
    },
  };
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.hasMutationCapability("relationships"), true);
  assert.equal(adapter.hasMutationCapability("recurrence"), true);
  await adapter.executeMutation(
    "relationships",
    "abc1234",
    {
      parentTask: null,
      blocking: ["bcd2345"],
      blockedBy: [],
    },
    true,
  );
  await adapter.executeMutation(
    "recurrence",
    "abc1234",
    {
      scope: "this-and-following",
      changes: {
        repeat: "mode=schedule|freq=week|interval=1",
        datetimeRepeatEnd: null,
      },
    },
    true,
  );

  assert.deepEqual(previews[0], {
    capability: "tasks.relationship.preview",
    mutationKind: "task.relationship",
    target: {
      operonId: "abc1234",
      locator: {
        representation: "inline",
        filePath: "Projects/Bridge.md",
        lineNumber: 4,
      },
    },
    spec: {
      operation: "replace-relationships",
      changes: [
        { field: "parentTask", targetOperonIds: [] },
        { field: "blocking", targetOperonIds: ["bcd2345"] },
        { field: "blockedBy", targetOperonIds: [] },
      ],
    },
  });
  assert.deepEqual(previews[1], {
    capability: "tasks.recurrence.preview",
    mutationKind: "task.recurrence",
    target: {
      operonId: "abc1234",
      locator: {
        representation: "inline",
        filePath: "Projects/Bridge.md",
        lineNumber: 4,
      },
    },
    spec: {
      operation: "update-recurrence",
      scope: "this-and-following",
      changes: [
        {
          field: "repeat",
          valueType: "text",
          value: "mode=schedule|freq=week|interval=1",
        },
        {
          operation: "clear",
          field: "datetimeRepeatEnd",
          valueType: "datetime",
        },
      ],
    },
  });
});

test("Operon 3 Developer API adapter exposes only bounded official read operations", async () => {
  const received = new Map<string, Record<string, unknown>>();
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "system.diagnostics",
        "catalog.read",
        "tasks.read",
        "tasks.query",
        "tasks.finder",
        "entities.resolve",
        "relationships.read",
        "context.build",
        "timers.read",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        lifecyclePhase: "ready",
        v8PersistencePhase: "idle",
        contextRevision: { index: { ramGeneration: 21 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true, kind: "runtime-diagnostics" }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-21",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { nextCursor: undefined },
        contextRevision: { index: { ramGeneration: 21 } },
      }),
      find: async (request: Record<string, unknown>) => {
        received.set("finder", request);
        return { ok: true, kind: "task-finder-result", rows: [] };
      },
    },
    entities: {
      resolve: async (request: Record<string, unknown>) => {
        received.set("resolve", request);
        return {
          ok: true,
          kind: "entity-resolution-result",
          resolution: "not-found",
          candidates: [],
        };
      },
    },
    relationships: {
      get: async (request: Record<string, unknown>) => {
        received.set("relationships", request);
        return { ok: true, kind: "relationship-result", relationships: {} };
      },
    },
    context: {
      build: async (request: Record<string, unknown>) => {
        received.set("context", request);
        return { ok: true, kind: "context-pack", entities: [] };
      },
    },
    timers: {
      read: async (request: Record<string, unknown>) => {
        received.set("timers", request);
        return {
          ok: true,
          kind: "timer-read-result",
          state: { active: null, transition: null },
        };
      },
    },
  };
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(), true);
  assert.equal(adapter.hasReadCapability("tasks.finder"), true);
  assert.equal((await adapter.readDiagnostics()).kind, "runtime-diagnostics");
  await adapter.findTasks({ text: "bridge", limit: 20 });
  await adapter.resolveEntity({
    selector: { kind: "operon-id", operonId: "abc1234" },
    limit: 10,
  });
  await adapter.readRelationships({
    selector: { kind: "operon-id", operonId: "abc1234" },
    depth: 1,
  });
  await adapter.buildContext({
    purpose: "analysis",
    projection: "task-neighborhood",
    selector: { kind: "operon-id", operonId: "abc1234" },
  });
  await adapter.readTimers();

  for (const request of received.values()) {
    assert.equal(request.contractVersion, 1);
    assert.equal(request.consistency, "live-verified");
    assert.equal(typeof request.requestId, "string");
  }
  assert.equal(received.get("finder")?.kind, "task-finder");
  assert.equal(received.get("resolve")?.kind, "entity-resolve");
  assert.equal(received.get("relationships")?.kind, "relationship");
  assert.equal(received.get("context")?.kind, "context");
  assert.equal(received.get("timers")?.kind, "timer-read");
});

test("Operon 3 Developer API adapter follows pagination beyond the former 25,000-task boundary", async () => {
  let queryCount = 0;
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 23 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-23",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async (request: { cursor?: string }) => {
        queryCount += 1;
        const index = Number(request.cursor ?? "0");
        const next = index < 100 ? String(index + 1) : undefined;
        return {
          ok: true,
          tasks: [
            {
              identity: { operonId: `page-${index}` },
              description: `Page ${index}`,
              representation: "inline" as const,
              locator: {
                representation: "inline" as const,
                filePath: "Tasks.md",
                lineNumber: index + 1,
              },
              checkbox: "open" as const,
            },
          ],
          page: { nextCursor: next, truncated: next !== undefined },
          contextRevision: { index: { ramGeneration: 23 } },
        };
      },
    },
  };
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(), true);
  assert.equal(queryCount, 101);
  assert.equal(adapter.indexer.taskCount, 101);
});

test("Operon 3 Developer API adapter refuses an explicitly truncated page without a cursor", async () => {
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({ ok: true }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        settingsFingerprint: "settings-truncated",
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { truncated: true },
      }),
    },
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  });

  assert.equal(await adapter.refresh(), false);
  assert.match(adapter.status.error?.reason ?? "", /truncation/u);
  assert.equal(
    (await adapter.indexer.getIndexV8Diagnostics()).health,
    "degraded",
  );
});

test("Operon 3.5 preserves scalar task media fields and ordered taskGallery arrays", async () => {
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 35 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        taxonomy: { pipelines: [], priorities: [] },
        fields: [
          {
            canonicalKey: "taskType",
            displayName: "Task Type",
            valueType: "text",
            source: "built-in",
            mappingStatus: "mapped",
            mutationClass: "general-update",
            readable: true,
          },
          {
            canonicalKey: "taskImage",
            displayName: "Task Image",
            valueType: "text",
            source: "built-in",
            mappingStatus: "mapped",
            mutationClass: "general-update",
            readable: true,
          },
          {
            canonicalKey: "taskGallery",
            displayName: "Task Gallery",
            valueType: "list",
            source: "built-in",
            mappingStatus: "mapped",
            mutationClass: "general-update",
            readable: true,
          },
        ],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [
          {
            identity: { operonId: "med1234" },
            description: "Media task",
            representation: "inline",
            locator: {
              representation: "inline",
              filePath: "Projects/Media.md",
              lineNumber: 2,
            },
            checkbox: "open",
            writableFields: [
              {
                canonicalKey: "taskType",
                valueType: "text",
                present: true,
                value: "article",
              },
              {
                canonicalKey: "taskImage",
                valueType: "text",
                present: true,
                value: "[[Cover.png]]",
              },
              {
                canonicalKey: "taskGallery",
                valueType: "list",
                present: true,
                value: ["[[A;B.png]]", "https://example.test/two.png"],
              },
            ],
          },
        ],
        page: { truncated: false },
        contextRevision: { index: { ramGeneration: 35 } },
      }),
    },
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  });
  assert.equal(await adapter.refresh(), true);
  const task = adapter.indexer.getTask("med1234");
  assert.equal(task?.fieldValues.taskType, "article");
  assert.equal(task?.fieldValues.taskImage, "[[Cover.png]]");
  assert.deepEqual(task?.fieldValues.taskGallery, [
    "[[A;B.png]]",
    "https://example.test/two.png",
  ]);
});

test("Operon 3.5 negotiates exact additive workflow grants and keeps opaque plans session-bound", async () => {
  const requestedCapabilitySets: string[][] = [];
  const previewInputs: Record<string, unknown>[] = [];
  const previewHandles: unknown[] = [];
  const appliedHandles: unknown[] = [];
  let pendingRecoveryCalls = 0;
  let recoveryCalls = 0;
  let liveReadsFail = false;
  let nextWorkflowResult: Record<string, unknown> | null = null;
  let nextWorkflowPlan: Record<string, unknown> | null = null;
  let nextWorkflowPreviewError: Record<string, unknown> | null = null;
  const rawTasks: Record<string, unknown>[] = [];
  const workflowDigests = {
    adopt: "a".repeat(64),
    "periodic-create": "b".repeat(64),
    "periodic-update": "c".repeat(64),
  } as const;
  const workflowRecoveryRefs = {
    adopt: `dvr1_${"a".repeat(48)}`,
    "periodic-create": `dvr1_${"b".repeat(48)}`,
    "periodic-update": `dvr1_${"c".repeat(48)}`,
  } as const;
  const workflowCapabilities = {
    adopt: "tasks.adopt.preview",
    "periodic-create": "tasks.create.periodic-note.preview",
    "periodic-update": "tasks.update.periodic-note.preview",
  } as const;
  const workflowMutationKinds = {
    adopt: "task.adopt",
    "periodic-create": "task.create",
    "periodic-update": "task.update",
  } as const;
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => {
        if (liveReadsFail) throw new Error("live index is dirty");
        return {
          ok: true,
          contextRevision: { index: { ramGeneration: 350 } },
        };
      },
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: rawTasks,
        page: { truncated: false },
        contextRevision: { index: { ramGeneration: 350 } },
      }),
    },
  };
  const makeMethods = (
    kind: "adopt" | "periodic-create" | "periodic-update",
  ) => ({
    preview: async (input: Record<string, unknown>) => {
      previewInputs.push(input);
      if (nextWorkflowPreviewError) {
        const error = nextWorkflowPreviewError;
        nextWorkflowPreviewError = null;
        return {
          contractVersion: 1,
          kind: "task-workflow-developer-mutation-preview-result",
          requestId: `preview-${kind}-${previewInputs.length}`,
          ok: false,
          warnings: [],
          error,
        };
      }
      const plan = nextWorkflowPlan ?? {
        contractVersion: 1,
        kind: "task-workflow-developer-mutation-plan",
        recoveryRef: workflowRecoveryRefs[kind],
        planDigest: workflowDigests[kind],
        createdAt: "2026-08-23T00:00:00.000Z",
        expiresAt: "2026-08-23T00:05:00.000Z",
        riskLevel: "routine",
        requiresConsent: false,
      };
      nextWorkflowPlan = null;
      previewHandles.push(plan);
      return {
        contractVersion: 1,
        kind: "task-workflow-developer-mutation-preview-result",
        requestId: `preview-${kind}-${previewInputs.length}`,
        ok: true,
        plan,
        warnings: [],
      };
    },
    apply: async ({ plan }: { plan: unknown }) => {
      appliedHandles.push(plan);
      if (nextWorkflowResult) {
        const result = nextWorkflowResult;
        nextWorkflowResult = null;
        return result;
      }
      if (kind === "adopt") {
        rawTasks.push({
          identity: { operonId: "adp1234" },
          description: "Adopt me",
          representation: "inline",
          locator: {
            representation: "inline",
            filePath: "Inbox.md",
            lineNumber: 4,
          },
          checkbox: "open",
        });
      }
      if (kind === "periodic-create") {
        rawTasks.push(
          {
            identity: { operonId: "day1234" },
            description: "Same periodic task",
            representation: "inline",
            locator: {
              representation: "inline",
              filePath: "Daily/2026-08-24.md",
              lineNumber: 4,
            },
            checkbox: "open",
            priority: { id: "priority-a", label: "A" },
            writableFields: [
              {
                canonicalKey: "tags",
                valueType: "list",
                present: true,
                value: ["work", "focus"],
              },
            ],
          },
          {
            identity: { operonId: "week123" },
            description: "Same periodic task",
            representation: "inline",
            locator: {
              representation: "inline",
              filePath: "Weekly/2026-W35.md",
              lineNumber: 4,
            },
            checkbox: "open",
            priority: { id: "priority-b", label: "B" },
            writableFields: [
              {
                canonicalKey: "tags",
                valueType: "list",
                present: true,
                value: ["work", "focus"],
              },
            ],
          },
        );
      }
      const planDigest = (plan as { planDigest: string }).planDigest;
      return {
        contractVersion: 1,
        kind: "task-workflow-developer-mutation-execution-result",
        requestId: `apply-${kind}-${appliedHandles.length}`,
        status: "applied",
        mutationMayHaveApplied: true,
        retryAllowed: false,
        receipt: {
          contractVersion: 1,
          planDigest,
          mutationKind: workflowMutationKinds[kind],
          targetDigest: "d".repeat(64),
          terminalOutcome: "applied",
          effectiveAt: "2026-08-23T00:00:01.000Z",
          completedAt: "2026-08-23T00:00:02.000Z",
          expiresAt: "2026-08-23T00:05:00.000Z",
          secretBody: "must-not-cross-bridge",
        },
        postflight: {
          status: "verified",
          observedAt: "2026-08-23T00:00:02.000Z",
          contextRevision: { privateFingerprint: "must-not-cross-bridge" },
        },
        groupResults: [
          {
            groupId: `group-${kind}`,
            status: "committed",
            error: { message: "must-not-cross-bridge" },
            ...(kind === "periodic-create"
              ? {
                  resourceRevisions: [
                    {
                      resourceKind: "task-source",
                      resourceKey: "Daily/2026-08-24.md",
                      revision: "sha256:daily",
                      privateValue: "must-not-cross-bridge",
                    },
                  ],
                }
              : {}),
          },
        ],
      };
    },
    recover: async ({ recoveryRef }: { recoveryRef: string }) => {
      recoveryCalls += 1;
      return {
        contractVersion: 1,
        kind: "task-workflow-developer-mutation-execution-result",
        requestId: `recover-${kind}-${recoveryCalls}`,
        status: "already-applied",
        mutationMayHaveApplied: true,
        retryAllowed: false,
        receipt: {
          contractVersion: 1,
          planDigest: workflowDigests[kind],
          mutationKind: workflowMutationKinds[kind],
          targetDigest: "d".repeat(64),
          terminalOutcome: "already-applied",
          effectiveAt: "2026-08-23T00:00:01.000Z",
          completedAt: "2026-08-23T00:00:02.000Z",
          expiresAt: "2026-08-23T00:05:00.000Z",
        },
        postflight: { status: "receipt-replay" },
        groupResults: [],
      };
    },
    pendingRecoveries: async () => {
      pendingRecoveryCalls += 1;
      return {
        contractVersion: 1,
        kind: "task-workflow-developer-pending-recoveries-result",
        ok: true,
        recoveries: [
          {
            recoveryRef: workflowRecoveryRefs[kind],
            planDigest: workflowDigests[kind],
            createdAt: "2026-08-23T00:00:00.000Z",
            expiresAt: "2026-08-23T00:05:00.000Z",
          },
        ],
      };
    },
  });
  const methods = {
    adopt: makeMethods("adopt"),
    createPeriodicNote: makeMethods("periodic-create"),
    updatePeriodicNote: makeMethods("periodic-update"),
  };
  const taskWorkflowAccess = (tasks: Record<string, unknown>) => ({
    contractVersion: 1,
    kind: "task-workflow-developer-api-access-result",
    ok: true,
    api: { contractVersion: 1, runtimeApi: 1, tasks },
  });
  const operon = {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
    getTaskWorkflowDeveloperApiV1: (
      _candidate: unknown,
      request: { requestedCapabilities: readonly string[] },
    ) => {
      requestedCapabilitySets.push([...request.requestedCapabilities]);
      if (request.requestedCapabilities[0] === "tasks.filter-query") {
        return taskWorkflowAccess({
          filterQuery: async (input: Record<string, unknown>) => ({
            contractVersion: 1,
            kind: "task-filter-query-result",
            requestId: input.requestId,
            ok: true,
            tasks: [],
          }),
        });
      }
      if (request.requestedCapabilities[0] === "tasks.adopt.preview") {
        return taskWorkflowAccess({ adopt: methods.adopt });
      }
      if (
        request.requestedCapabilities[0] ===
        "tasks.create.periodic-note.preview"
      ) {
        return taskWorkflowAccess({
          createPeriodicNote: methods.createPeriodicNote,
        });
      }
      return taskWorkflowAccess({
        updatePeriodicNote: methods.updatePeriodicNote,
      });
    },
  };
  const persistedTaskWorkflowIdentities = new Map<string, string>();
  const taskWorkflowIdentityStore = {
    get: (key: string) => persistedTaskWorkflowIdentities.get(key),
    set: async (key: string, operonId: string) => {
      persistedTaskWorkflowIdentities.set(key, operonId);
    },
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(
    consumer,
    operon,
    taskWorkflowIdentityStore,
  );
  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.hasTaskWorkflowCapability("adopt"), true);
  assert.equal(adapter.hasTaskWorkflowCapability("periodic-create"), true);
  assert.equal(adapter.hasTaskWorkflowCapability("periodic-update"), true);
  assert.deepEqual(requestedCapabilitySets.slice(-3), [
    ["tasks.adopt.preview", "tasks.adopt.apply"],
    ["tasks.create.periodic-note.preview", "tasks.create.periodic-note.apply"],
    ["tasks.update.periodic-note.preview", "tasks.update.periodic-note.apply"],
  ]);
  const adopted = await adapter.executeTaskWorkflow(
    "adopt",
    {
      targetPath: "Inbox.md",
      line: 5,
      expectedLine: "- [ ] Adopt me",
    },
    false,
  );
  assert.equal(adopted.ok, true);
  assert.equal(adopted.operonId, "adp1234");
  assert.deepEqual(previewInputs[0], {
    operation: "adopt-inline",
    source: {
      filePath: "Inbox.md",
      lineNumber: 4,
      expectedLine: "- [ ] Adopt me",
    },
  });
  assert.equal(appliedHandles[0], previewHandles[0]);
  const periodicCreate = await adapter.executeTaskWorkflow(
    "periodic-create",
    {
      description: "Daily focus",
      periodicKind: "daily",
      routeDate: "2026-08-23",
      priorityId: "priority-a",
      fields: { taskGallery: ["[[One;A.png]]", "[[Two.png]]"] },
    },
    true,
  );
  assert.equal(periodicCreate.code, "planned");
  assert.deepEqual(
    (previewInputs[1]?.items as Record<string, unknown>[])[0]?.target,
    {
      representation: "inline",
      mode: "periodic-note",
      periodicKind: "daily",
      routeDate: "2026-08-23",
    },
  );
  assert.deepEqual(
    (previewInputs[1]?.items as Record<string, unknown>[])[0]?.fields,
    [
      {
        kind: "list",
        field: "taskGallery",
        value: ["[[One;A.png]]", "[[Two.png]]"],
      },
    ],
  );
  assert.equal(
    (previewInputs[1]?.items as Record<string, unknown>[])[0]?.priorityId,
    "priority-a",
  );
  const periodicUpdate = await adapter.executeTaskWorkflow(
    "periodic-update",
    {
      operonId: "adp1234",
      fields: { dateScheduled: "2026-08-25" },
    },
    true,
  );
  assert.equal(periodicUpdate.code, "planned");
  assert.equal(previewInputs[2]?.operation, "update-periodic-note");
  assert.deepEqual(previewInputs[2]?.changes, [
    {
      field: "dateScheduled",
      valueType: "date",
      value: "2026-08-25",
    },
  ]);
  const periodicDetach = await adapter.executeTaskWorkflow(
    "periodic-update",
    {
      operonId: "adp1234",
      fields: { dateScheduled: null },
    },
    true,
  );
  assert.equal(periodicDetach.code, "planned");
  assert.deepEqual(previewInputs[3]?.changes, [
    {
      operation: "clear",
      field: "dateScheduled",
      valueType: "date",
    },
  ]);
  const extraPeriodicField = await adapter.executeTaskWorkflow(
    "periodic-update",
    {
      operonId: "adp1234",
      fields: {
        dateScheduled: "2026-08-26",
        taskGallery: ["[[Nope.png]]"],
      },
    },
    true,
  );
  assert.equal(extraPeriodicField.code, "invalid-input");
  assert.equal(previewInputs.length, 4);
  const appliedBeforeStalePreview = appliedHandles.length;
  nextWorkflowPreviewError = {
    code: "stale-source",
    reason: "The exact inline source line changed before preview.",
  };
  const staleAdoption = await adapter.executeTaskWorkflow(
    "adopt",
    {
      targetPath: "Inbox.md",
      line: 5,
      expectedLine: "- [ ] Adopt me",
    },
    false,
  );
  assert.equal(staleAdoption.code, "conflict");
  assert.equal(staleAdoption.mutationMayHaveApplied, undefined);
  assert.equal(appliedHandles.length, appliedBeforeStalePreview);
  nextWorkflowPreviewError = {
    code: "authority-insufficient",
    reason: "The exact task-workflow grant is no longer active.",
  };
  const revokedAdoption = await adapter.executeTaskWorkflow(
    "adopt",
    {
      targetPath: "Inbox.md",
      line: 5,
      expectedLine: "- [ ] Adopt me",
    },
    false,
  );
  assert.equal(revokedAdoption.code, "not-ready");
  assert.equal(appliedHandles.length, appliedBeforeStalePreview);
  const appliedBeforeRevisionConflict = appliedHandles.length;
  const revisionConflict = await adapter.executeTaskWorkflow(
    "periodic-update",
    {
      operonId: "adp1234",
      fields: { dateScheduled: "2026-08-27" },
    },
    false,
    async () => ({
      ok: false,
      message: "fixture revision changed after preview",
    }),
  );
  assert.equal(revisionConflict.code, "conflict");
  assert.equal(revisionConflict.mutationMayHaveApplied, false);
  assert.equal(appliedHandles.length, appliedBeforeRevisionConflict);
  const validPeriodicUpdatePlan = {
    contractVersion: 1,
    kind: "task-workflow-developer-mutation-plan",
    recoveryRef: workflowRecoveryRefs["periodic-update"],
    planDigest: workflowDigests["periodic-update"],
    createdAt: "2026-08-23T00:00:00.000Z",
    expiresAt: "2026-08-23T00:05:00.000Z",
    riskLevel: "routine",
    requiresConsent: false,
  };
  const appliedBeforeInvalidPlans = appliedHandles.length;
  nextWorkflowPlan = {
    ...validPeriodicUpdatePlan,
    recoveryRef: `twr1_${"c".repeat(48)}`,
  };
  const inventedWorkflowRecoveryFamily = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-27" } },
    false,
  );
  assert.equal(inventedWorkflowRecoveryFamily.code, "failed");
  assert.equal(inventedWorkflowRecoveryFamily.mutationMayHaveApplied, false);
  nextWorkflowPlan = {
    ...validPeriodicUpdatePlan,
    planDigest: workflowDigests["periodic-update"].toUpperCase(),
  };
  const uppercasePlanDigest = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-27" } },
    false,
  );
  assert.equal(uppercasePlanDigest.code, "failed");
  assert.equal(uppercasePlanDigest.mutationMayHaveApplied, false);
  nextWorkflowPlan = { ...validPeriodicUpdatePlan, spec: { private: true } };
  const privatePlanField = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-27" } },
    false,
  );
  assert.equal(privatePlanField.code, "failed");
  nextWorkflowPlan = {
    ...validPeriodicUpdatePlan,
    targets: [
      {
        operonId: "adp1234",
        locator: {
          representation: "inline",
          filePath: "Daily/2026-08-23.md",
          lineNumber: 7,
          privateOffset: 42,
        },
      },
    ],
  };
  const privateTargetField = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-27" } },
    false,
  );
  assert.equal(privateTargetField.code, "failed");
  assert.equal(privateTargetField.mutationMayHaveApplied, false);
  assert.equal(appliedHandles.length, appliedBeforeInvalidPlans);
  const invalidTerminalBase = {
    contractVersion: 1,
    kind: "task-workflow-developer-mutation-execution-result",
    requestId: "invalid-terminal-fixture",
    status: "applied",
    mutationMayHaveApplied: true,
    retryAllowed: false,
    receipt: {
      contractVersion: 1,
      planDigest: workflowDigests["periodic-update"],
      mutationKind: "task.update",
      targetDigest: "d".repeat(64),
      terminalOutcome: "applied",
      effectiveAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:02.000Z",
      expiresAt: "2026-08-23T00:05:00.000Z",
    },
    groupResults: [{ groupId: "periodic-update", status: "committed" }],
  };
  nextWorkflowResult = invalidTerminalBase;
  const missingPostflight = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-28" } },
    false,
  );
  assert.equal(missingPostflight.code, "outcome-unknown");
  assert.equal(missingPostflight.mutationMayHaveApplied, true);
  nextWorkflowResult = {
    ...invalidTerminalBase,
    receipt: {
      ...invalidTerminalBase.receipt,
      planDigest: "f".repeat(64),
    },
    postflight: {
      status: "verified",
      observedAt: "2026-08-23T00:00:02.000Z",
    },
  };
  const substitutedDigest = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-29" } },
    false,
  );
  assert.equal(substitutedDigest.code, "outcome-unknown");
  nextWorkflowResult = {
    ...invalidTerminalBase,
    postflight: {
      status: "verified",
      observedAt: "2026-08-23T00:00:02.000Z",
    },
    groupResults: [{ groupId: "periodic-update", status: "failed" }],
  };
  const incoherentGroups = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-30" } },
    false,
  );
  assert.equal(incoherentGroups.code, "outcome-unknown");
  nextWorkflowResult = {
    ...invalidTerminalBase,
    kind: "mutation-result",
    postflight: {
      status: "verified",
      observedAt: "2026-08-23T00:00:02.000Z",
    },
  };
  const privateCoreDiscriminator = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-08-31" } },
    false,
  );
  assert.equal(privateCoreDiscriminator.code, "outcome-unknown");
  assert.match(
    privateCoreDiscriminator.message ?? "",
    /task-workflow-developer-mutation-execution-result/u,
  );
  nextWorkflowResult = {
    contractVersion: 1,
    kind: "task-workflow-developer-mutation-execution-result",
    requestId: "failed-union-fixture",
    status: "failed",
    mutationMayHaveApplied: false,
    retryAllowed: false,
    groupResults: [{ groupId: "periodic-update", status: "failed" }],
    error: { code: "conflict", reason: "official failed union" },
  };
  const officialFailedUnion = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-09-01" } },
    false,
  );
  assert.equal(officialFailedUnion.code, "conflict");
  nextWorkflowResult = {
    contractVersion: 1,
    kind: "task-workflow-developer-mutation-execution-result",
    requestId: "uncertain-union-fixture",
    status: "outcome-unknown",
    mutationMayHaveApplied: true,
    retryAllowed: false,
    groupResults: [
      { groupId: "periodic-update", status: "outcome-unknown" },
    ],
    error: {
      code: "outcome-unknown",
      reason: "official uncertain union",
      retryable: false,
      action: "recover-same-plan",
    },
    recovery: {
      required: true,
      action: "recover-same-plan",
      mutationMayHaveApplied: true,
      recoveryRef: workflowRecoveryRefs["periodic-update"],
      planDigest: workflowDigests["periodic-update"],
      plan: validPeriodicUpdatePlan,
    },
  };
  const officialUncertainUnion = await adapter.executeTaskWorkflow(
    "periodic-update",
    { operonId: "adp1234", fields: { dateScheduled: "2026-09-02" } },
    false,
  );
  assert.equal(officialUncertainUnion.code, "outcome-unknown");
  assert.equal(
    officialUncertainUnion.recoveryRef,
    workflowRecoveryRefs["periodic-update"],
  );
  const routedPeriodicCreate = await adapter.executeTaskWorkflow(
    "periodic-create",
    {
      description: "Same periodic task",
      periodicKind: "daily",
      routeDate: "2026-08-24",
      priorityId: "priority-a",
      tags: ["work", "#work", " #focus ", "#focus"],
    },
    false,
  );
  assert.equal(routedPeriodicCreate.code, "applied");
  assert.equal(routedPeriodicCreate.operonId, "day1234");
  assert.deepEqual(
    (previewInputs.at(-1)?.items as Record<string, unknown>[])[0]?.tags,
    ["work", "focus"],
  );
  assert.equal(
    "secretBody" in (routedPeriodicCreate.nativeProof?.receipt ?? {}),
    false,
  );
  assert.equal(
    "contextRevision" in (routedPeriodicCreate.nativeProof?.postflight ?? {}),
    false,
  );
  assert.equal(
    "error" in (routedPeriodicCreate.nativeProof?.groupResults[0] ?? {}),
    false,
  );
  assert.equal(
    "privateValue" in
      (routedPeriodicCreate.nativeProof?.groupResults[0]?.resourceRevisions?.[0] ??
        {}),
    false,
  );
  const lossyGallery = await adapter.executeTaskWorkflow(
    "periodic-create",
    {
      description: "Unsafe gallery",
      periodicKind: "weekly",
      fields: { taskGallery: "[[One;A.png]]; [[Two.png]]" },
    },
    true,
  );
  assert.equal(lossyGallery.code, "invalid-input");
  const pending = await adapter.pendingTaskWorkflowRecoveries("adopt");
  assert.equal(pending.ok, true);
  assert.equal(pending.recoveries[0]?.workflowKind, "adopt");
  const pendingBeforeInvalidDigest = pendingRecoveryCalls;
  const recoverBeforeInvalidDigest = recoveryCalls;
  const invalidRecoveryDigest = await adapter.recoverTaskWorkflow(
    "adopt",
    workflowRecoveryRefs.adopt,
    workflowDigests.adopt.toUpperCase(),
  );
  assert.equal(invalidRecoveryDigest.code, "invalid-input");
  assert.equal(pendingRecoveryCalls, pendingBeforeInvalidDigest);
  assert.equal(recoveryCalls, recoverBeforeInvalidDigest);
  const wrongRecoveryDigest = await adapter.recoverTaskWorkflow(
    "adopt",
    workflowRecoveryRefs.adopt,
    "f".repeat(64),
  );
  assert.equal(wrongRecoveryDigest.code, "invalid-input");
  assert.equal(pendingRecoveryCalls, pendingBeforeInvalidDigest + 1);
  assert.equal(recoveryCalls, recoverBeforeInvalidDigest);
  const recovered = await adapter.recoverTaskWorkflow(
    "adopt",
    workflowRecoveryRefs.adopt,
  );
  assert.equal(recovered.code, "already-applied");

  const alreadyAppliedResult = (
    kind: "adopt" | "periodic-create",
  ): Record<string, unknown> => ({
    contractVersion: 1,
    kind: "task-workflow-developer-mutation-execution-result",
    requestId: `replay-${kind}`,
    status: "already-applied",
    mutationMayHaveApplied: true,
    retryAllowed: false,
    receipt: {
      contractVersion: 1,
      planDigest: workflowDigests[kind],
      mutationKind: workflowMutationKinds[kind],
      targetDigest: "d".repeat(64),
      terminalOutcome: "already-applied",
      effectiveAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:02.000Z",
      expiresAt: "2026-08-23T00:05:00.000Z",
    },
    postflight: { status: "receipt-replay" },
    groupResults: [],
  });
  nextWorkflowResult = alreadyAppliedResult("adopt");
  const replayedAdoption = await adapter.executeTaskWorkflow(
    "adopt",
    {
      targetPath: "Inbox.md",
      line: 5,
      expectedLine: "- [ ] Adopt me",
    },
    false,
  );
  assert.equal(replayedAdoption.code, "already-applied");
  assert.equal(replayedAdoption.operonId, "adp1234");
  nextWorkflowResult = alreadyAppliedResult("periodic-create");
  const replayedPeriodicCreate = await adapter.executeTaskWorkflow(
    "periodic-create",
    {
      description: "Same periodic task",
      periodicKind: "daily",
      routeDate: "2026-08-24",
      priorityId: "priority-a",
    },
    false,
  );
  assert.equal(replayedPeriodicCreate.code, "already-applied");
  assert.equal(replayedPeriodicCreate.operonId, "day1234");

  const originalPeriodicTask = rawTasks.find(
    (task) =>
      (task.identity as { operonId?: string } | undefined)?.operonId ===
      "day1234",
  );
  assert.ok(originalPeriodicTask);
  rawTasks.push({
    ...originalPeriodicTask,
    identity: { operonId: "dup1234" },
    locator: {
      representation: "inline",
      filePath: "Daily/2026-08-25.md",
      lineNumber: 4,
    },
  });
  const restartedAdapter = new OperonDeveloperApiRuntimeAdapter(
    consumer,
    operon,
    taskWorkflowIdentityStore,
  );
  assert.equal(await restartedAdapter.refresh(true), true);
  nextWorkflowResult = alreadyAppliedResult("periodic-create");
  const replayedPeriodicCreateAfterRestart =
    await restartedAdapter.executeTaskWorkflow(
      "periodic-create",
      {
        description: "Same periodic task",
        periodicKind: "daily",
        routeDate: "2026-08-24",
        priorityId: "priority-a",
      },
      false,
    );
  assert.equal(replayedPeriodicCreateAfterRestart.code, "already-applied");
  assert.equal(replayedPeriodicCreateAfterRestart.operonId, "day1234");

  liveReadsFail = true;
  assert.equal(await restartedAdapter.refresh(true), false);
  assert.equal(
    restartedAdapter.hasTaskWorkflowRecoverySupport("periodic-create"),
    true,
    "a failed live read refresh must preserve an established workflow recovery session",
  );
  assert.equal(
    await restartedAdapter.refreshTaskWorkflowRecovery("periodic-create"),
    true,
    "recovery negotiation must not depend on health, catalog, or task reads",
  );
  assert.equal(
    restartedAdapter.hasTaskWorkflowRecoverySupport("periodic-create"),
    true,
  );
  const recoveredWithDirtyIndex = await restartedAdapter.recoverTaskWorkflow(
    "periodic-create",
    workflowRecoveryRefs["periodic-create"],
    workflowDigests["periodic-create"],
  );
  assert.equal(recoveredWithDirtyIndex.code, "already-applied");
});

test("a rejected Operon 3.5 workflow grant does not revoke another workflow or core reads", async () => {
  const api = {
    hasCapability: (name: string) =>
      [
        "system.health",
        "system.capabilities",
        "catalog.read",
        "tasks.read",
        "tasks.query",
      ].includes(name),
    channel: { status: readyStatus },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 351 } },
      }),
      capabilities: () => [],
      diagnostics: async () => ({ ok: true }),
    },
    catalog: {
      snapshot: async () => ({
        ok: true,
        taxonomy: { pipelines: [], priorities: [] },
        fields: [],
        policies: { creation: {} },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [],
        page: { truncated: false },
        contextRevision: { index: { ramGeneration: 351 } },
      }),
    },
  };
  const adoption = {
    preview: async () => ({
      ok: true,
      plan: { recoveryRef: "r", planDigest: "p" },
    }),
    apply: async () => ({ status: "applied" }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, {
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
    getTaskWorkflowDeveloperApiV1: (
      _candidate: unknown,
      request: { requestedCapabilities: readonly string[] },
    ) => {
      if (request.requestedCapabilities[0] === "tasks.adopt.preview") {
        return {
          contractVersion: 1,
          kind: "task-workflow-developer-api-access-result",
          ok: true,
          api: {
            contractVersion: 1,
            runtimeApi: 1,
            tasks: { adopt: adoption },
          },
        };
      }
      if (
        request.requestedCapabilities[0] ===
        "tasks.create.periodic-note.preview"
      ) {
        throw new Error("periodic grant pending");
      }
      return {
        contractVersion: 1,
        kind: "task-workflow-developer-api-access-result",
        ok: false,
        error: { code: "authority-insufficient" },
      };
    },
  });
  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.indexer.getGeneration(), 351);
  assert.equal(adapter.hasTaskWorkflowCapability("adopt"), true);
  assert.equal(adapter.hasTaskWorkflowCapability("periodic-create"), false);
});
