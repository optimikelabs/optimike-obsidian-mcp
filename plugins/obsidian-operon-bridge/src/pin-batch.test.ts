import assert from "node:assert/strict";
import test from "node:test";
import { OperonDeveloperApiRuntimeAdapter } from "./developer-api-adapter";

test("pins negotiate only on first use, preserve base reads/update on pending grant, and batch uses one untargeted plan", async () => {
  const grants = new Set([
    "system.health",
    "system.capabilities",
    "tasks.read",
    "tasks.query",
    "catalog.read",
    "tasks.update.preview",
    "tasks.update.apply",
  ]);
  let reflectPins = true;
  const requests: string[][] = [],
    previews: any[] = [],
    applied: any[] = [];
  const tasks = ["abc1234", "def5678"].map((operonId, index) => ({
    identity: { operonId },
    pinned: false,
    representation: "inline",
    description: "Task",
    checkbox: "open",
    locator: {
      representation: "inline",
      filePath: "Tasks.md",
      lineNumber: index + 1,
    },
    workflow: {
      pipeline: { id: "pipeline", label: "Project" },
      status: { id: "open", label: "Open" },
    },
    dates: {},
    datetimes: {},
    relationships: {},
    customFields: {},
    writableFields: [],
  }));
  const status = () => ({
    availability: "available",
    reason: "ready",
    authority: "granted",
    admission: { reads: true, writes: true },
    grant: {
      state: "active",
      grantedCapabilities: [...grants],
      effectiveCapabilities: [...grants],
    },
  });
  const api = {
    hasCapability: (name: string) => grants.has(name),
    channel: { status },
    system: {
      health: async () => ({
        ok: true,
        contextRevision: { index: { ramGeneration: 1 } },
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
      query: async () => ({ ok: true, tasks, page: { truncated: false } }),
      get: async (request: any) => ({
        ok: true,
        task: tasks.find(
          (task) => task.identity.operonId === request.selector.operonId,
        ),
      }),
    },
    mutations: {
      preview: async (input: any) => {
        previews.push(input);
        return {
          ok: true,
          plan: {
            contractVersion: 1,
            kind: "developer-mutation-plan",
            recoveryRef: "dvr1_" + "a".repeat(48),
            planDigest: "a".repeat(64),
            mutationKind: input.mutationKind,
            capability: input.capability,
            targets: input.target
              ? [input.target]
              : input.spec.items.map((item: any) => item.target),
          },
        };
      },
      apply: async ({ plan }: any) => {
        applied.push(plan);
        const intent = previews.at(-1);
        if (reflectPins && intent.mutationKind === "task.pinned-state") tasks[0].pinned = intent.spec.pinned;
        return {
          contractVersion: 1,
          kind: "developer-mutation-execution-result",
          requestId: "apply",
          status: "applied",
          mutationMayHaveApplied: true,
          retryAllowed: false,
          groupResults: [{ groupId: "group", status: "committed" }],
          receipt: {
            contractVersion: 1,
            planDigest: plan.planDigest,
            mutationKind: plan.mutationKind,
            targetDigest: "b".repeat(64),
            terminalOutcome: "applied",
            effectiveAt: "2026-11-11T00:00:00Z",
            completedAt: "2026-11-11T00:00:01Z",
            expiresAt: "2026-11-11T00:05:00Z",
          },
          postflight: {
            status: "verified",
            observedAt: "2026-11-11T00:00:01Z",
          },
        };
      },
      recover: async () => ({}),
      pendingRecoveries: async () => ({ ok: true, recoveries: [] }),
    },
  };
  const adapter = new OperonDeveloperApiRuntimeAdapter(
    {
      manifest: {
        id: "optimike-operon-bridge",
        name: "Bridge",
        version: "0.9.7",
      },
    },
    {
      getDeveloperApiV1: (
        _consumer: unknown,
        request: { requestedCapabilities: readonly string[] },
      ) => {
        requests.push([...request.requestedCapabilities]);
        if (request.requestedCapabilities.some((name) => !grants.has(name)))
          return {
            ok: false,
            status: {
              ...status(),
              grant: { ...status().grant, state: "pending" },
            },
            error: { code: "authority-insufficient" },
          };
        return { ok: true, status: status(), api };
      },
    },
  );
  assert.equal(await adapter.refresh(true), true);
  assert.equal(
    requests.some((set) =>
      set.some((name) => name.startsWith("tasks.pinned.")),
    ),
    false,
  );
  assert.ok(adapter.firstUseCapabilities().includes("pinned"));
  const baseStatus = adapter.status;
  assert.equal(await adapter.refreshPinned(), false);
  assert.equal(adapter.pinnedApprovalPending, true);
  assert.deepEqual(requests.at(-1), [
    "tasks.read",
    "tasks.pinned.preview",
    "tasks.pinned.apply",
  ]);
  assert.deepEqual(adapter.status, baseStatus);
  assert.equal(adapter.hasMutationCapability("update"), true);
  assert.equal(adapter.indexer.taskCount, 2);
  grants.add("tasks.pinned.preview");
  grants.add("tasks.pinned.apply");
  assert.equal(await adapter.refreshPinned(), true);
  assert.equal(adapter.firstUseCapabilities().includes("pinned"), false);
  const pin = await adapter.executeMutation(
    "pinned",
    "abc1234",
    { pinned: true },
    false,
  );
  assert.equal(pin.ok, true);
  assert.equal(pin.nativeProof?.receipt?.mutationKind, "task.pinned-state");
  assert.deepEqual(previews.at(-1), {
    capability: "tasks.pinned.preview",
    mutationKind: "task.pinned-state",
    target: { operonId: "abc1234", locator: tasks[0].locator },
    spec: { operation: "set-pinned", pinned: true },
  });
  assert.equal(await adapter.refresh(true), true);
  assert.equal(
    adapter.hasMutationCapability("pinned"),
    true,
    "refresh keeps negotiated pin session",
  );
  reflectPins = false;
  const unverified = await adapter.executeMutation("pinned", "abc1234", { pinned: false }, false);
  assert.equal(unverified.ok, false);
  assert.equal(unverified.mutationMayHaveApplied, true);
  reflectPins = true;
  const unpinned = await adapter.executeMutation("pinned", "abc1234", { pinned: false }, false);
  assert.equal(unpinned.ok, true); assert.equal(unpinned.pinned, false);
  const batch = {
    items: tasks.map((task) => ({
      operonId: task.identity.operonId,
      expectedRevision: "revision",
      patch: { description: "Updated" },
    })),
  };
  const planned = await adapter.executeMutation(
    "update-batch",
    null,
    batch,
    true,
  );
  assert.equal(planned.ok, true);
  assert.equal(previews.at(-1).target, undefined);
  assert.equal(previews.at(-1).spec.operation, "update-batch");
  assert.equal(previews.at(-1).spec.items.length, 2);
  const beforeCalls = applied.length;
  const stale = await adapter.executeMutation(
    "update-batch",
    null,
    batch,
    false,
    false,
    async () => ({ ok: false, message: "stale revision" }),
  );
  assert.equal(stale.code, "conflict");
  assert.equal(stale.mutationMayHaveApplied, false);
  assert.equal(applied.length, beforeCalls);
  const done = await adapter.executeMutation(
    "update-batch",
    null,
    batch,
    false,
  );
  assert.equal(done.ok, true);
  assert.equal(applied.length, beforeCalls + 1);
  assert.equal(applied.at(-1).targets.length, 2);
});
