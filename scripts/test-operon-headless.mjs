
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperonClient, callOperon, runParity, compareTasks } from "./operon-headless-parity.mjs";
import { OperonCapabilitiesSchema } from "../dist/services/operon/contract.js";

const root = await mkdtemp(path.join(tmpdir(), "test-operon-headless-"));
const vault = path.join(root, "vault");
const notesPath = "Notes\u00a0fixture.md";
const filePath = "_Operon/Synthetic project.md";
const notes = [
  "# Synthetic fixture", "",
  "    - [ ] Indented code {{operonId:: ignore5}}",
  "- [ ] Deliver #sample {{operonId:: child01}} {{État:: CN.Planifié}} {{priority:: A}} {{dateDue:: 2099-01-04}} {{dateScheduled:: 2099-01-03}} {{parentTask:: root001}} {{repeat:: every week}} {{repeatSeriesId:: rstest1}} {{repeatOccurrenceDate:: 2099-01-03}}",
  "  - [x] Plain checklist",
  "  - [x] Review {{operonId:: child02}} {{État:: CN.Finished}} {{dateCompleted:: 2099-01-02}} {{parentTask:: child01}} {{blockedBy:: child01}} {{related:: root001}}",
  "- [-] Drop {{operonId:: child03}} {{État:: CN.Cancelled}} {{dateCancelled:: 2099-01-02}}",
  "- [ ] Start {{operonId:: child04}} {{État:: CN.Active}} {{dateStarted:: 2099-01-02}}",
  "~~~markdown", "- [ ] Example {{operonId:: ignore1}}", "~~~",
  "<!--", "- [ ] Example {{operonId:: ignore2}}", "-->",
  "%%", "- [ ] Example {{operonId:: ignore3}}", "%%",
  "- [ ] Plain checkbox",
].join("\r\n");
const statuses = ["Open", "Planifié", "Finished", "Cancelled", "Active"].map((label, index) => ({
  id: "status" + index, label, isFinished: index === 2, isCancelled: index === 3,
  isScheduledTarget: index === 1, isTrackingTarget: index === 4,
}));
const pipeline = { id: "pipeline_cn", name: "CN", description: null, statuses };
const dueFilter = {
  id: "fixture-open", name: "Open Tasks", icon: null,
  rootGroup: { logic: "all", children: [
    { fieldType: "checkbox", field: "checkbox", operator: "isOpen" },
    { logic: "any", children: [
      { fieldType: "date", field: "dateDue", operator: "after", value: "2099-01-01" },
      { fieldType: "text", field: "description", operator: "is", value: "Synthetic project" },
    ] },
  ] },
  sorts: [{ field: "description", order: "asc" }],
};
const runtimeFilter = {
  id: "fixture-runtime", name: "Runtime filter", icon: null,
  rootGroup: { logic: "all", children: [{ fieldType: "projectSerialScope", field: "serial", operator: "isAnyOf" }] },
};
const priority = { id: "priority_a", label: "A", color: null, description: null };
const mapping = { canonicalKey: "status", visiblePropertyName: "État", type: "text", sync: "yes", enabled: true, isSystem: true, isInternal: false };
const pluginData = {
  schemaVersion: 3, settings: { language: "fr", excludedFolders: ["Excluded"] },
  taxonomy: {
    pipelines: { pipelines: [pipeline], defaultPipelineName: "CN" },
    priorities: { priorities: [priority], defaultPriority: "A" },
    keyMappings: { system: [mapping], custom: [] },
  },
  views: { filters: { filterIds: [dueFilter.id, runtimeFilter.id], itemsById: {
    [dueFilter.id]: dueFilter, [runtimeFilter.id]: runtimeFilter,
  } } },
  ui: { taskCreationProfile: { fileTasksFolder: "_Operon" } },
  state: { pinnedTasks: { itemsById: { root001: { pinned: true } } } },
};
const statePath = path.join(vault, ".obsidian", "plugins", "operon");
const configurationFile = path.join(statePath, "data.json");
const recurrence = { repeating: false, seriesId: null, occurrenceDate: null };
function expectedTask({ id, statusIndex, description, fields = {}, dates = {}, ...overrides }) {
  const status = "CN." + statuses[statusIndex].label;
  return {
    operonId: id, source: "inline", path: notesPath, line: 4, sourceMtime: 0,
    description, checkbox: "open", status, statusId: "status" + statusIndex,
    statusLabel: statuses[statusIndex].label, pipeline: "CN", pipelineId: "pipeline_cn",
    priority: null, tier: "hot", tags: [], parentTask: null, blocking: [], blockedBy: [],
    dates: { due: null, scheduled: null, started: null, completed: null, cancelled: null, datetimeStart: null,
      datetimeEnd: null, created: null, modified: null, ...dates },
    fields: { operonId: id, status, ...fields }, recurrence,
    revision: "fnv1a32:01234567", sourceKind: "operon-index", operonVersion: "4.9.0", bridgeVersion: "0.9.9",
    ...overrides,
  };
}
const expected = [
  expectedTask({ id: "child01", statusIndex: 1, description: "Deliver", priority: "A", tags: ["sample"], parentTask: "root001",
    dates: { due: "2099-01-04", scheduled: "2099-01-03" },
    fields: { priority: "A", dateDue: "2099-01-04", dateScheduled: "2099-01-03", parentTask: "root001",
      repeat: "every week", repeatSeriesId: "rstest1", repeatOccurrenceDate: "2099-01-03" },
    plainCheckboxProgress: { total: 1, completed: 1 },
    recurrence: { repeating: true, seriesId: "rstest1", occurrenceDate: "2099-01-03" },
  }),
  expectedTask({ id: "child02", statusIndex: 2, description: "Review", line: 6, checkbox: "done", tier: "warm", parentTask: "child01",
    dates: { completed: "2099-01-02" }, blockedBy: ["child01"],
    fields: { dateCompleted: "2099-01-02", parentTask: "child01", blockedBy: ["child01"], related: ["root001"] } }),
  expectedTask({ id: "child03", statusIndex: 3, description: "Drop", line: 7, checkbox: "cancelled", tier: "warm",
    dates: { cancelled: "2099-01-02" }, fields: { dateCancelled: "2099-01-02" } }),
  expectedTask({ id: "child04", statusIndex: 4, description: "Start", line: 8,
    dates: { started: "2099-01-02" }, fields: { dateStarted: "2099-01-02" } }),
  expectedTask({ id: "root001", statusIndex: 0, description: "Synthetic project", line: null, source: "file", path: filePath,
    tags: ["project"], properties: { sample: true },
    dates: { created: "2099-01-01T12:00:00", modified: "2099-01-01T12:00:00" },
    fields: { taskGallery: ["[[a.png]]", "[[b.png]]"], datetimeCreated: "2099-01-01T12:00:00", datetimeModified: "2099-01-01T12:00:00" } }),
];
const envelope = {
  ok: true, contractVersion: "1", stale: false, generation: 1, settingsSignature: "stub", limitations: [],
};
const capabilities = OperonCapabilitiesSchema.parse({
  status: true, configuration: true, list: true, get: true, query: true, validate: true,
  create: false, update: false, convert: false, transition: false,
});
const live = createServer((req, res) => {
  const data = req.url.endsWith("/tasks/query") ? {
    ...envelope, source: "operon-live", cursor: "0", hasMore: false, tasks: expected,
    count: expected.length, total: expected.length,
  } : req.url.endsWith("/validate") ? {
    ...envelope, source: "operon-runtime", taskCount: expected.length, summary: { P0: 0, P1: 0, P2: 0 }, violations: [],
  } : req.url.endsWith("/configuration") ? {
    ...envelope, source: "operon-runtime", operonVersion: "4.9.0", bridgeVersion: "0.9.9",
    configuration: {
      language: "fr", workflow: { language: "fr", defaultPipelineName: "CN",
        pipelines: [{ ...pipeline, statuses: statuses.map(s => ({ ...s, value: "CN." + s.label })) }] },
      priorities: { defaultPriority: "A", items: [priority] }, keys: [mapping],
      creation: { fileTasksFolder: "_Operon", inlineTaskSaveMode: "", inlineTaskUseDailyNote: false, inlineTaskTargetFile: "", inlineTaskHeading: "",
        inlineTaskDailyNoteAddStartDate: false, inlineTaskDailyNoteAddScheduledDate: false, taskCreatorDefaultToFileTask: false,
        taskCreatorDefaultFileTemplateId: null, fileTaskTemplateFolder: "", fileTaskParentInlineTargetMode: "", fileTaskParentFileTargetMode: "",
        availableFileTaskTemplates: [] },
      automation: { autoCompleteParentWhenAllChildrenTerminal: false, cascadeCancelToDescendants: false,
        fileTaskAutoArchiveEnabled: false, fileTaskArchiveFolder: "", fileTaskArchiveDelaySeconds: 0,
        fileTaskArchiveOnlyFromFileTasksFolder: false, fileRepeatDestination: "", fileRepeatCustomFolder: "" },
      indexing: { excludedFolders: ["Excluded"], fullReindexOnStartup: false, indexEventDebounceMs: 0 },
      docs: { folder: "", autoUpdateEnabled: false }, views: { filters: [] },
    },
  } : req.url.endsWith("/status") ? {
    ...envelope, source: "operon-runtime",
    bridge: { id: "optimike-operon-bridge", version: "0.9.9", mode: "read-only" },
    operon: { present: true, version: "4.9.0", compatible: true, testedAgainst: "4.9.0", supportedRange: "4.9.0" },
    index: { ready: true, generation: 1, taskCount: expected.length, duplicateConflictCount: 0 },
    capabilities,
  } : { authenticated: true };
  req.resume();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
});

try {
  await Promise.all([mkdir(statePath, { recursive: true }), mkdir(path.join(vault, "_Operon"), { recursive: true }),
    mkdir(path.join(vault, "Excluded"), { recursive: true })]);
  await Promise.all([
    writeFile(configurationFile, JSON.stringify(pluginData), "utf8"),
    writeFile(path.join(statePath, "manifest.json"), JSON.stringify({ version: "4.9.0" }), "utf8"),
    writeFile(path.join(vault, notesPath), "\ufeff" + notes, "utf8"),
    writeFile(path.join(vault, filePath), "\ufeff---\r\noperonId: root001\r\nÉtat: CN.Open\r\ntags: [project]\r\ntaskGallery: ['[[a.png]]', '[[b.png]]']\r\ndatetimeCreated: 2099-01-01T12:00:00\r\ndatetimeModified: 2099-01-01T12:00:00\r\nsample: true\r\n---\r\n", "utf8"),
    writeFile(path.join(vault, "Excluded", "Ignored.md"), "- [ ] Excluded {{operonId:: ignore4}}", "utf8"),
  ]);
  await new Promise((resolve, reject) => live.listen(0, "127.0.0.1", resolve).once("error", reject));
  const url = "http://127.0.0.1:" + live.address().port;
  const options = { vault, cache: root };
  await withOperonClient({ ...options, mode: "live", url, token: "synthetic-fixture" }, async liveClient => {
    const base = await liveClient.listTools();
    for (const mode of ["headless-readonly", "headless-guarded", "headless-filesystem"]) {
      await withOperonClient({ ...options, mode }, async fs => {
        const catalog = await fs.listTools();
        const names = [
          "operon_find_tasks", "operon_get_configuration", "operon_get_relationships", "operon_get_task",
          "operon_list_tasks", "operon_query_saved_filter", "operon_query_tasks", "operon_status", "operon_validate",
        ];
        assert.deepEqual(catalog.tools.filter(item => item.name.startsWith("operon_")).map(item => item.name).sort(), names);
        for (const name of names) {
          const tool = catalog.tools.find(tool => tool.name === name);
          assert.deepEqual(tool.inputSchema, base.tools.find(tool => tool.name === name).inputSchema);
          assert.equal(tool.annotations.readOnlyHint, true);
        }
        assert.deepEqual(await runParity(liveClient, fs), { liveCount: 5, filesystemCount: 5, differences: [] });
        if (mode !== "headless-readonly") return;
        const read = (name, args, allowError) => callOperon(fs, "operon_" + name, args, allowError);
        const config = await read("get_configuration");
        assert.equal(config.configuration.creation.fileTasksFolder, "_Operon");
        assert.equal(config.source, "filesystem");
        assert.equal(config.partial, false);
        const single = await read("get_task", { operonId: "root001", includeProperties: true });
        assert.equal(single.task.properties.sample, true);
        assert.equal((await read("get_task", { operonId: "root001" })).task.properties, undefined);
        const finder = await read("find_tasks", { project: { mode: "tree" } });
        assert.equal(finder.result.contractVersion, 1);
        assert.equal(finder.result.rows.find(row => row.task.identity.operonId === "root001").treeTaskCount, 2);
        const relations = await read("get_relationships", { operonId: "child01", depth: 2 });
        assert.ok(relations.result.relationships.derived.some(edge => edge.kind === "blocking" && edge.targetOperonId === "child02"));
        assert.equal(relations.result.tasks.find(task => task.identity.operonId === "child01").sourceRevision.contentDigest,
          createHash("sha256").update("\ufeff" + notes).digest("hex"));
        const saved = await read("query_saved_filter", { filterSetId: dueFilter.id, scopePath: notesPath });
        assert.deepEqual(saved.tasks.map(task => task.operonId), ["child01"]);
        const refused = await read("query_saved_filter", { filterSetId: runtimeFilter.id }, true);
        assert.equal(refused.source, "filesystem");
        assert.match(JSON.stringify(refused), /operon_filesystem_filter_unsupported/u);
        assert.deepEqual((await read("validate")).summary, { P0: 0, P1: 0, P2: 0 });
        const first = await read("find_tasks", { limit: 1 });
        assert.ok(first.result.page.nextCursor);
        const siblingRevision = (await read("get_task", { operonId: "child02" })).task.revision;
        await writeFile(path.join(vault, notesPath), notes.replace("Deliver #sample", "Deliver revised #sample"), "utf8");
        const update = await read("list_tasks", { forceRefresh: true });
        assert.equal(update.tasks.find(task => task.operonId === "child01").description, "Deliver revised");
        assert.equal(update.tasks.find(task => task.operonId === "child02").revision, siblingRevision);
        const cursorRefusal = await read("find_tasks", { limit: 1, cursor: first.result.page.nextCursor }, true);
        assert.match(JSON.stringify(cursorRefusal), /VALIDATION_ERROR/u);
        await rm(path.join(vault, notesPath));
        assert.equal((await read("list_tasks", { forceRefresh: true })).total, 1);
        await writeFile(path.join(vault, "Duplicate.md"), "- [ ] Duplicate {{operonId:: root001}}", "utf8");
        assert.equal((await read("validate", { forceRefresh: true })).summary.P0, 1);
        const duplicate = await read("get_task", { operonId: "root001" }, true);
        assert.equal(duplicate.error.details.reasonCode, "operon_filesystem_duplicate_id");
        await rm(path.join(vault, "Duplicate.md"));
        await writeFile(configurationFile, JSON.stringify({ language: "en", pipelines: [
          { ...pipeline, statuses: statuses.map(status => ({ ...status, id: "legacy-" + status.id })) },
        ], keyMappings: [mapping] }), "utf8");
        assert.equal((await read("get_task", { operonId: "root001", forceRefresh: true })).task.statusId, "legacy-status0");
        await writeFile(configurationFile, JSON.stringify(pluginData), "utf8");
        await writeFile(path.join(vault, notesPath), "\ufeff" + notes, "utf8");
      });
    }
  });
  await withOperonClient({ ...options, mode: "headless-readonly", profile: "full" }, async fs => {
    const refused = await callOperon(fs, "operon_get_timer_state", {}, true);
    assert.equal(refused.source, "filesystem");
    assert.equal(refused.error.details.reasonCode, "operon_filesystem_live_required");
  });

  process.env.OBSIDIAN_VAULT = vault;
  process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
  const { FilesystemOperonService } = await import("../dist/services/operon/filesystemService.js");
  const building = new FilesystemOperonService({
    getStats: () => ({ status: "building", freshness: "uncertain" }),
    isReady: () => false,
    getEntriesByPrefix: () => [],
  });
  const partial = await building.query({});
  assert.equal(partial.partial, true);
  assert.equal(partial.source, "filesystem");
  await assert.rejects(building.getTask({ operonId: "child01" }), error =>
    error.details.reasonCode === "operon_filesystem_cache_partial");
  assert.deepEqual(compareTasks(expected, expected.slice(1)), [{ operonId: "child01", fields: ["missing-in-filesystem"] }]);
  console.log("PASS: filesystem Operon transport, exact schemas, synthetic REST parity, saved filters, relationships and cache edits");
} finally {
  await new Promise(resolve => live.close(resolve));
  await rm(root, { recursive: true, force: true });
}
