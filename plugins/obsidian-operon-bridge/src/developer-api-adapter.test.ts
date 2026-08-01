import assert from "node:assert/strict";
import test from "node:test";
import { OperonDeveloperApiRuntimeAdapter } from "./developer-api-adapter";

const consumer = {
  manifest: {
    id: "optimike-operon-bridge",
    name: "Optimike Operon Bridge",
    version: "0.4.7",
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
