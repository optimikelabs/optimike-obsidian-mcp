
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperonClient, callOperon, runParity, compareTasks, compareConfigurations, parityHasUnexpectedDifferences } from "./operon-headless-parity.mjs";
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
  sorts: [{ field: "dateDue", order: "asc" }],
};
const runtimeFilter = {
  id: "fixture-runtime", name: "Runtime filter", icon: null,
  rootGroup: { logic: "all", children: [{ fieldType: "projectSerialScope", field: "serial", operator: "isAnyOf" }] },
};
const dynamicFilter = {
  id: "fixture-dynamic", name: "Dynamic filter", icon: null,
  rootGroup: { logic: "all", children: [{ fieldType: "date", field: "dateDue", operator: "after", value: "{{today}}" }] },
};
const groupedFilter = { ...dueFilter, id: "fixture-grouped", name: "Grouped filter", groupBy: "priority" };
const filters = [dueFilter, runtimeFilter, dynamicFilter, groupedFilter];
const priority = { id: "pr_a", label: "A", color: null, description: null };
const mapping = { canonicalKey: "status", visiblePropertyName: "État", type: "text", sync: "yes", enabled: true, isSystem: true, isInternal: false };
const virtualMappings = [
  ["description", "Description", "text"], ["checkbox", "Checkbox", "checkbox"], ["tags", "Tags", "list"],
  ["representation", "Representation", "text"], ["locator", "Source locator", "text"],
  ["pinned", "Pinned", "checkbox"], ["related", "Related", "list"],
].map(([canonicalKey, visiblePropertyName, type]) =>
  ({ canonicalKey, visiblePropertyName, type, sync: null, enabled: true, isSystem: true, isInternal: false }));
const pluginData = {
  schemaVersion: 3, settings: { language: "fr", excludedFolders: ["Unindexed", "Excluded"] },
  taxonomy: {
    pipelines: { pipelines: [pipeline], defaultPipelineName: "CN" },
    priorities: { priorities: [priority], defaultPriority: "A" },
    keyMappings: { system: [mapping], custom: [] },
  },
  views: { filters: { filterIds: filters.map(f => f.id), itemsById: Object.fromEntries(filters.map(f => [f.id, f])) } },
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
    priority: null, tier: "warm", tags: [], parentTask: null, blocking: [], blockedBy: [],
    dates: { due: null, scheduled: null, started: null, completed: null, cancelled: null, datetimeStart: null,
      datetimeEnd: null, created: null, modified: null, ...dates },
    fields: { description, status, ...(overrides.tags?.length ? { tags: overrides.tags } : {}), ...fields }, recurrence,
    revision: "fnv1a32:01234567", sourceKind: "operon-index", operonVersion: "4.6.0", bridgeVersion: "0.9.9",
    ...overrides,
  };
}
const expected = [
  expectedTask({ id: "child01", statusIndex: 1, description: "Deliver", priority: "pr_a", tags: ["sample"], parentTask: "root001",
    dates: { due: "2099-01-04", scheduled: "2099-01-03" },
    fields: { priority: "pr_a", dateDue: "2099-01-04", dateScheduled: "2099-01-03", parentTask: "root001",
      repeat: "every week", repeatSeriesId: "rstest1", repeatOccurrenceDate: "2099-01-03" },
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
  status: true, configuration: true, list: true, get: true, query: true, validate: true, finder: true, relationships: true, filterQuery: true,
  create: false, update: false, convert: false, transition: false,
});
const live = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  const edge = (sourceOperonId, kind, targetOperonId) => ({ sourceOperonId, kind, targetOperonId });
  const rows = expected.map(task => ({ task: { identity: { operonId: task.operonId } } }));
  const native = (operation, result) => ({ ...envelope, source: "operon-live", operation, result });
  const filtered = expected.filter(task => ["child01", "root001"].includes(task.operonId));
  const data = req.url.endsWith("/tasks/query") ? {
    ...envelope, source: "operon-live", cursor: "0", hasMore: false, tasks: expected,
    count: expected.length, total: expected.length,
  } : req.url.endsWith("/tasks/finder") ? native("finder", { rows, page: { actualCount: expected.length } })
    : req.url.endsWith("/relationships") ? native("relationships", {
      tasks: rows.filter(row => row.task.identity.operonId !== "child03" && row.task.identity.operonId !== "child04").map(row => row.task),
      relationships: body.operonId === "child01" ? {
        explicit: [edge("child01", "parent", "root001")],
        derived: [edge("child01", "child", "child02"), edge("child01", "blocking", "child02"),
          edge("child01", "ancestor", "root001"), edge("child01", "project-member", "child02")], inferred: [],
      } : {
        explicit: [edge("child02", "parent", "child01"), edge("child02", "blocked-by", "child01"),
          edge("child02", "related", "root001")],
        derived: [edge("child02", "ancestor", "child01")], inferred: [],
      },
    }) : req.url.endsWith("/tasks/filter") ? {
      ...envelope, source: "operon-live", cursor: "0", hasMore: false,
      tasks: filtered, count: filtered.length, total: filtered.length,
    } : req.url.endsWith("/validate") ? {
    ...envelope, source: "operon-runtime", taskCount: expected.length, summary: { P0: 0, P1: 0, P2: 0 }, violations: [],
  } : req.url.endsWith("/configuration") ? {
    ...envelope, source: "operon-runtime", operonVersion: "4.6.0", bridgeVersion: "0.9.9",
    configuration: {
      language: "auto", workflow: { language: "auto", defaultPipelineName: "CN",
        pipelines: [{ ...pipeline, statuses: statuses.map(s => ({ ...s, value: "CN." + s.label })) }] },
      priorities: { defaultPriority: "pr_a", items: [priority] }, keys: [...virtualMappings, { ...mapping, sync: null }],
      creation: { fileTasksFolder: "_Operon", inlineTaskSaveMode: "", inlineTaskUseDailyNote: false, inlineTaskTargetFile: "", inlineTaskHeading: "",
        inlineTaskDailyNoteAddStartDate: false, inlineTaskDailyNoteAddScheduledDate: false, taskCreatorDefaultToFileTask: false,
        taskCreatorDefaultFileTemplateId: null, fileTaskTemplateFolder: "", fileTaskParentInlineTargetMode: "", fileTaskParentFileTargetMode: "",
        availableFileTaskTemplates: [{ id: "builtin-minimal-file-task-template:pipeline_cn", name: "Minimal File Task — CN",
          path: null, kind: "builtin-pipeline-minimal", pipelineId: "pipeline_cn", description: null }] },
      automation: { autoCompleteParentWhenAllChildrenTerminal: false, cascadeCancelToDescendants: false,
        fileTaskAutoArchiveEnabled: false, fileTaskArchiveFolder: "", fileTaskArchiveDelaySeconds: 0,
        fileTaskArchiveOnlyFromFileTasksFolder: false, fileRepeatDestination: "", fileRepeatCustomFolder: "" },
      indexing: { excludedFolders: ["Excluded", "Unindexed"], fullReindexOnStartup: false, indexEventDebounceMs: 0 },
      docs: { folder: "", autoUpdateEnabled: false }, views: { filters: filters.map(({ id, name, icon, ...definition }) => ({ id, name, icon, definition })) },
    },
  } : req.url.endsWith("/status") ? {
    ...envelope, source: "operon-runtime",
    bridge: { id: "optimike-operon-bridge", version: "0.9.9", mode: "read-only" },
    operon: { present: true, version: "4.6.0", compatible: true, testedAgainst: "4.6.0", supportedRange: "4.6.0" },
    index: { ready: true, generation: 1, taskCount: expected.length, duplicateConflictCount: 0 },
    capabilities,
  } : { authenticated: true };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
});

try {
  await Promise.all([mkdir(statePath, { recursive: true }), mkdir(path.join(vault, "_Operon"), { recursive: true }),
    mkdir(path.join(vault, "Excluded"), { recursive: true }), mkdir(path.join(vault, ".hidden"), { recursive: true })]);
  await Promise.all([
    writeFile(configurationFile, JSON.stringify(pluginData), "utf8"),
    writeFile(path.join(statePath, "manifest.json"), JSON.stringify({ version: "4.6.0" }), "utf8"),
    writeFile(path.join(vault, notesPath), "\ufeff" + notes, "utf8"),
    writeFile(path.join(vault, filePath), "\ufeff---\r\noperonId: root001\r\nÉtat: CN.Open\r\ntags: [project]\r\ntaskGallery: ['[[a.png]]', '[[b.png]]']\r\ndatetimeCreated: 2099-01-01T12:00:00\r\ndatetimeModified: 2099-01-01T12:00:00\r\nsample: true\r\n---\r\n", "utf8"),
    writeFile(path.join(vault, ".hidden", "Ignored.md"), "- [ ] Hidden {{operonId:: hide001}}", "utf8"),
    writeFile(path.join(vault, "Excluded", "Ignored.md"), "- [ ] Excluded {{operonId:: ignore4}}", "utf8"),
  ]);
  await new Promise((resolve, reject) => live.listen(0, "127.0.0.1", resolve).once("error", reject));
  const url = "http://127.0.0.1:" + live.address().port;
  // An empty TZ exercises the unavailable server zone on Linux with Node 22.
  const options = { vault, cache: root, timeZone: "", processTimeZone: "" };
  await withOperonClient({ ...options, mode: "live", url, token: "synthetic-fixture" }, async liveClient => {
    const base = await liveClient.listTools();
    for (const mode of ["headless-readonly", "headless-guarded", "headless-filesystem"]) {
      const timeZone = mode === "headless-guarded" ? "Europe/Paris" : "";
      await withOperonClient({ ...options, mode, timeZone, processTimeZone: timeZone ? "UTC" : "" }, async fs => {
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
        const parity = await runParity(liveClient, fs);
        assert.equal(parity.liveCount, 5);
        assert.equal(parity.filesystemCount, 5);
        assert.deepEqual(parity.differences, []);
        assert.equal(parityHasUnexpectedDifferences(parity), false);
        assert.deepEqual(parity.surfaces, {
          operon_get_configuration: { equal: 0, different: 0, unavailable: 0, known: 1 },
          operon_validate: { equal: 1, different: 0, unavailable: 0 },
          operon_find_tasks: { equal: 1, different: 0, unavailable: 0 },
          operon_get_relationships: { equal: 2, different: 0, unavailable: 0 },
          operon_query_saved_filter: { equal: 1, different: 0, unavailable: 3 },
        });
        const health = await callOperon(fs, "operon_status");
        assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: health.timeZone }));
        assert.equal(health.timeZoneSource, timeZone ? "configured" : "server");
        if (timeZone) assert.equal(health.timeZone, timeZone);
        else assert.match(health.timeZoneWarning, /server's time zone/u);
        if (mode !== "headless-readonly") return;
        const read = (name, args, allowError) => callOperon(fs, "operon_" + name, args, allowError);
        const config = await read("get_configuration");
        assert.equal(config.configuration.creation.fileTasksFolder, "_Operon");
        assert.deepEqual(config.configuration.keys.slice(0, 7), virtualMappings);
        assert.equal(config.configuration.creation.availableFileTaskTemplates[0].id, "builtin-minimal-file-task-template:pipeline_cn");
        assert.equal(config.configurationDifferences.find(row => row.field === "creation.availableFileTaskTemplates.folder").status, "unknown");
        assert.equal(config.configurationDifferences.find(row => row.field === "keys.sync").status, "disk");
        const changedPriority = structuredClone(config);
        changedPriority.configuration.priorities.defaultPriority = "other_priority";
        assert.equal(compareConfigurations(changedPriority, config), "different");
        assert.equal(config.configuration.priorities.defaultPriority, "pr_a");
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
        const firstSaved = await read("query_saved_filter", { filterSetId: dueFilter.id, limit: 1 });
        assert.deepEqual(firstSaved.tasks.map(task => task.operonId), ["child01"]);
        const lastSaved = await read("query_saved_filter", { filterSetId: dueFilter.id, limit: 1, cursor: firstSaved.nextCursor });
        assert.deepEqual(lastSaved.tasks.map(task => task.operonId), ["root001"]);
        for (const filter of [dynamicFilter, groupedFilter]) {
          const refusedFilter = await read("query_saved_filter", { filterSetId: filter.id }, true);
          assert.equal(refusedFilter.error.details.reasonCode, "operon_filesystem_filter_unsupported");
        }
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
        const staleFilterCursor = await read("query_saved_filter", { filterSetId: dueFilter.id, limit: 1, cursor: firstSaved.nextCursor }, true);
        assert.equal(staleFilterCursor.error.code, "VALIDATION_ERROR");
        const invalidStatus = path.join(vault, "Invalid.md");
        await writeFile(invalidStatus, "- [ ] Invalid status {{operonId:: wrong01}} {{status:: Open}}", "utf8");
        const invalid = await read("validate", { forceRefresh: true });
        assert.ok(invalid.violations.some(violation => violation.code === "unknown_workflow_status" && violation.operonId === "wrong01"));
        await rm(invalidStatus);
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

  const { parseOperonMarkdown, projectFilesystemConfiguration, projectFilesystemTask } =
    await import("../dist/services/operon/filesystemFormat.js");
  const cfg = projectFilesystemConfiguration(pluginData);
  const reserved = projectFilesystemConfiguration({ keyMappings: [
    { ...mapping, isInternal: true },
    { ...mapping, canonicalKey: "reminderRules", visiblePropertyName: "Rules", isSystem: false },
  ] }).keys.slice(7);
  assert.deepEqual(reserved.map(key => key.isInternal), [false, true]);
  const source = [
    "Text with " + String.fromCharCode(96) + "%% <!--" + String.fromCharCode(96),
    "> ~~~", "> - [ ] Quoted placeholder {{operonId:: hide002}}",
    "- [ ] Retained {{operonId:: kept001}} {{priority:: pr_a}} {{progress:: 50}} {{directSubtaskCount:: 2}}" +
      " {{note:: first\\nsecond \\}}} {{contexts:: Alpha\\; Beta; Gamma}} {{tags:: x\\;y; other}} {{datetimeStart:: 2099-01-01T12:00}} {{datetimeEnd:: invalid}}",
    "- [x] Same level checkbox", "- Bullet", "  - [x] Nested checklist",
  ].join("\n");
  const decoded = parseOperonMarkdown(source, "Retained.md", cfg).tasks;
  assert.equal(decoded.length, 1);
  const projection = projectFilesystemTask(decoded[0], "Retained.md", { mtime: 1 }, cfg);
  assert.deepEqual(projection.fields, {
    description: "Retained", priority: "pr_a", note: "first\nsecond }", contexts: ["Alpha; Beta", "Gamma"],
    datetimeStart: "2099-01-01T12:00", tags: ["x;y", "other"],
  });
  assert.deepEqual(projection.tags, ["other", "x;y"]);
  assert.equal(projection.tier, "warm");
  assert.equal(projection.plainCheckboxProgress, undefined);
  const [rawFile] = parseOperonMarkdown("---\noperonId: time001\ndatetimeModified: 2020-01-02T08:00:00\n---\n- [x] Sidebar", "Clock.md", cfg).tasks;
  const oldMtime = Date.UTC(2020, 0, 1);
  const recentMtime = Date.UTC(2020, 0, 3);
  const clock = projectFilesystemTask(rawFile, "Clock.md", { mtime: recentMtime, birthtime: oldMtime }, cfg, "Europe/Paris");
  assert.equal(clock.dates.created, "2020-01-01T01:00:00");
  assert.equal(clock.dates.modified, "2020-01-03T01:00:00");
  assert.equal(clock.fields.datetimeModified, clock.dates.modified);
  assert.equal(projectFilesystemTask(rawFile, "Clock.md", { mtime: oldMtime }, cfg, "Europe/Paris").dates.modified,
    "2020-01-02T08:00:00");
  const [noStoredTime] = parseOperonMarkdown("---\noperonId: time002\n---", "Clock.md", cfg).tasks;
  assert.equal(projectFilesystemTask(noStoredTime, "Clock.md", { mtime: recentMtime }, cfg, "Europe/Paris").dates.modified,
    "2020-01-03T01:00:00");
  assert.equal(projectFilesystemTask(decoded[0], "Retained.md", { mtime: recentMtime }, cfg, "Europe/Paris").dates.modified, null);
  assert.equal(projectFilesystemTask(rawFile, "Clock.md", { mtime: 1 }, cfg).dates.created, null);
  assert.equal(clock.plainCheckboxProgress, undefined);
  const { compileSavedFilter } = await import("../dist/services/operon/filesystemFilters.js");
  const filterSpec = (condition, sorts = []) => ({ rootGroup: { logic: "all", children: [condition] }, sorts });
  const folders = compileSavedFilter(filterSpec(
    { fieldType: "folders", field: "folders", operator: "isInFolderTree", value: "\\Program\\ACTIVE\\" },
    [{ field: "folders", order: "desc" }]), null, cfg, new Date());
  const alpha = { ...clock, path: "Team/Program/Active/Alpha/Task.md" };
  const beta = { ...clock, path: "Team/Program/Active/Beta/Task.md" };
  assert.deepEqual([alpha, { ...clock, path: "Team/Program/Inactive/Task.md" }, beta]
    .filter(folders.predicate).sort(folders.compare), [beta, alpha]);
  const week = filterSpec({ fieldType: "date", field: "dateDue", operator: "thisWeek" });
  const midnight = new Date("2026-01-04T23:30:00Z");
  const monday = { ...clock, fields: { dateDue: "2026-01-05" } };
  const sunday = { ...clock, fields: { dateDue: "2026-01-04" } };
  const inWeek = zone => compileSavedFilter(week, null, cfg, midnight, zone).predicate;
  assert.deepEqual([sunday, monday].map(inWeek("Europe/Paris")), [false, true]);
  assert.deepEqual([sunday, monday].map(inWeek("UTC")), [true, false]);

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
  assert.deepEqual(await building.configurationReadiness(), { configured: true });
  await writeFile(configurationFile, JSON.stringify({ language: "en" }), "utf8");
  assert.deepEqual(await building.configurationReadiness(), { configured: false, degraded: true });
  const { VaultFileService } = await import("../dist/services/vaultFileService.js");
  const sample = { path: "Synced.md", content: "---\noperonId: time003\nstatus: CN.Open\n---", mtime: recentMtime, hash: "sample" };
  const synchronized = new FilesystemOperonService({
    getStats: () => ({ status: "ready" }),
    isReady: () => true, getEntriesByPrefix: () => [sample], getEntry: () => sample,
  });
  const readBirthtime = VaultFileService.prototype.readBirthtime;
  VaultFileService.prototype.readBirthtime = async () => oldMtime;
  try {
    const degraded = await synchronized.query({});
    assert.equal(degraded.tasks[0].status, "CN.Open");
    assert.equal(degraded.tasks[0].statusId, null);
    assert.match(degraded.limitations.join("\n"), /Legacy Operon data has no pipeline list/u);
    assert.match(degraded.limitations.join("\n"), /synchronization created the local copy/u);
    assert.deepEqual((await synchronized.validate()).violations, []);
  } finally {
    VaultFileService.prototype.readBirthtime = readBirthtime;
  }
  await writeFile(configurationFile, JSON.stringify({ taxonomy: {}, schemaVersion: 3 }), "utf8");
  await assert.rejects(building.configurationReadiness(), error =>
    error.details.reasonCode === "operon_filesystem_configuration_invalid");
  await rm(configurationFile);
  assert.deepEqual(await building.configurationReadiness(), { configured: false });
  assert.deepEqual(compareTasks(expected, expected.slice(1)), [{ operonId: "child01", fields: ["missing-in-filesystem"] }]);
  console.log("PASS: filesystem Operon transport, exact schemas, synthetic REST parity, saved filters, relationships and cache edits");
} finally {
  await new Promise(resolve => live.close(resolve));
  await rm(root, { recursive: true, force: true });
}
