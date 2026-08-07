import assert from "node:assert/strict";
import test from "node:test";
import { OperonDeveloperApiRuntimeAdapter } from "./developer-api-adapter";

const consumer = {
  manifest: {
    id: "optimike-operon-bridge",
    name: "Optimike Operon Bridge",
    version: "0.5.0",
  },
};

function readyStatus(): Record<string, unknown> {
  return {
    availability: "available",
    reason: "ready",
    authority: "granted",
    admission: { reads: true, writes: false },
    grant: { state: "active", effectiveCapabilities: ["tasks.read", "tasks.query", "catalog.read"] },
  };
}

test("Operon 3 Developer API adapter reads a live task snapshot through the official accessor", async () => {
  let receivedConsumer: unknown;
  const api = {
    hasCapability: (name: string) => [
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
          defaultPipeline: { id: "pipeline-project", configuredValue: "Project" },
          pipelines: [{
            id: "pipeline-project",
            name: "Project",
            statuses: [{ id: "status-planned", label: "Planned" }],
          }],
          priorities: [{ id: "priority-a", label: "A", isDefault: true }],
        },
        fields: [{
          canonicalKey: "priority",
          displayName: "priority",
          valueType: "text",
          source: "built-in",
          mappingStatus: "mapped",
          readable: true,
        }],
        policies: {
          creation: { inlineTaskSaveMode: "active-file", defaultToFileTask: false },
        },
      }),
    },
    tasks: {
      query: async () => ({
        ok: true,
        tasks: [{
          identity: { operonId: "abc1234" },
          description: "Ship bridge",
          representation: "inline",
          locator: { representation: "inline", filePath: "Projects/Bridge.md", lineNumber: 4 },
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
        }],
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

  const adapter = new OperonDeveloperApiRuntimeAdapter(
    consumer,
    operon,
  );
  assert.equal(await adapter.refresh(), true);
  assert.equal(receivedConsumer, consumer);
  assert.equal(adapter.indexer.getGeneration(), 17);
  assert.equal(adapter.indexer.taskCount, 1);
  assert.deepEqual(adapter.indexer.getTask("abc1234")?.tags, ["elysia", "bridge"]);
  assert.equal(adapter.indexer.getTask("abc1234")?.primary.lineNumber, 4);
  assert.equal(adapter.pipelines[0]?.statuses[0]?.id, "status-planned");
  assert.equal(adapter.semanticConfiguration.workflow.defaultPipelineName, "Project");
  assert.equal((await adapter.indexer.getIndexV8Diagnostics()).health, "healthy");
});

test("Operon 3 Developer API adapter stays unavailable when the host grant is pending", async () => {
  const operon = {
    getDeveloperApiV1: () => ({
      ok: false,
      status: { availability: "unavailable", reason: "grant-pending", grant: { state: "pending" } },
      error: { code: "authority-insufficient", reason: "Review the exact grant." },
    }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);
  assert.equal(await adapter.refresh(), false);
  assert.equal((await adapter.indexer.getIndexV8Diagnostics()).health, "unavailable");
  assert.equal(adapter.indexer.taskCount, 0);
  assert.equal(adapter.status.reason, "grant-pending");
});

test("Operon 3 Developer API adapter previews and applies an exact typed update plan", async () => {
  const task = {
    identity: { operonId: "abc1234" },
    description: "Ship bridge",
    representation: "inline" as const,
    locator: { representation: "inline" as const, filePath: "Projects/Bridge.md", lineNumber: 4 },
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
    hasCapability: (name: string) => [
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
          pipelines: [{
            id: "pipeline-project",
            name: "Project",
            statuses: [{ id: "status-planned", label: "Planned" }],
          }],
        },
        fields: [{
          canonicalKey: "priority",
          displayName: "priority",
          valueType: "text",
          source: "built-in",
          mappingStatus: "mapped",
          readable: true,
        }],
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
    getDeveloperApiV1: () => ({ ok: true, status: readyStatus(), api }),
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(consumer, operon);

  assert.equal(await adapter.refresh(true), true);
  assert.equal(adapter.hasMutationCapability("update"), true);
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
      locator: { representation: "inline", filePath: "Projects/Bridge.md", lineNumber: 4 },
    },
    spec: {
      operation: "update",
      changes: [{ field: "description", valueType: "text", value: "Updated bridge" }],
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
    hasCapability: (name: string) => [
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
      preview: async () => ({ ok: true, plan: { planDigest: "plan-recovery-1", recoveryRef: "recovery-1" } }),
      apply: async () => ({ status: "applied" as const, receipt: { planDigest: "plan-recovery-1" } }),
      pendingRecoveries: async () => ({
        ok: true,
        recoveries: [{ recoveryRef: "recovery-1", planDigest: "plan-recovery-1", mutationKind: "task.update" }],
      }),
      recover: async ({ recoveryRef }: { recoveryRef: string }) => ({
        status: "already-applied" as const,
        mutationMayHaveApplied: true,
        receipt: { terminalOutcome: "already-applied", planDigest: recoveryRef === "recovery-1" ? "plan-recovery-1" : "wrong" },
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

test("Operon 3 Developer API adapter exposes only bounded official read operations", async () => {
  const received = new Map<string, Record<string, unknown>>();
  const api = {
    hasCapability: (name: string) => [
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
        return { ok: true, kind: "entity-resolution-result", resolution: "not-found", candidates: [] };
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
        return { ok: true, kind: "timer-read-result", state: { active: null, transition: null } };
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
  await adapter.resolveEntity({ selector: { kind: "operon-id", operonId: "abc1234" }, limit: 10 });
  await adapter.readRelationships({ selector: { kind: "operon-id", operonId: "abc1234" }, depth: 1 });
  await adapter.buildContext({ purpose: "analysis", projection: "task-neighborhood", selector: { kind: "operon-id", operonId: "abc1234" } });
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
