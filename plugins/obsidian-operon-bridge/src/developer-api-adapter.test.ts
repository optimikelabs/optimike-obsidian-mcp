import assert from "node:assert/strict";
import test from "node:test";
import { OperonDeveloperApiRuntimeAdapter } from "./developer-api-adapter";

const consumer = {
  manifest: {
    id: "optimike-operon-bridge",
    name: "Optimike Operon Bridge",
    version: "0.7.0",
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
      ok: request.requestedCapabilities[0] === "tasks.filter-query",
      api: {
        tasks: {
          filterQuery: async (input: Record<string, unknown>) => {
            filterRequest = input;
            return {
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
      preview: async () => ({ ok: true, plan: { planDigest: "filter-pending" } }),
      apply: async () => ({ status: "applied" as const }),
    },
  };
  const operon = {
    getDeveloperApiV1: (
      _candidate: unknown,
      request: { requestedCapabilities: readonly string[] },
    ) => ({
      ok: request.requestedCapabilities.every((capability) => granted.has(capability)),
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
            planDigest: "plan-update-1",
            recoveryRef: "recovery-update-1",
            capability: "tasks.update.preview",
            mutationKind: "task.update",
          },
        };
      },
      apply: async ({ plan }: { plan: unknown }) => {
        appliedPlan = plan;
        return {
          status: "applied" as const,
          mutationMayHaveApplied: true,
          retryAllowed: false,
          receipt: { terminalOutcome: "applied", planDigest: "plan-update-1" },
        };
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
    { description: "Updated bridge" },
    false,
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, "applied");
  assert.equal(result.planDigest, "plan-update-1");
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
      ],
    },
  });
  assert.deepEqual(appliedPlan, {
    planDigest: "plan-update-1",
    recoveryRef: "recovery-update-1",
    capability: "tasks.update.preview",
    mutationKind: "task.update",
  });
});

test("Operon 3 Developer API adapter recovers the same durable mutation plan", async () => {
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
        contextRevision: { index: { ramGeneration: 19 } },
      }),
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
