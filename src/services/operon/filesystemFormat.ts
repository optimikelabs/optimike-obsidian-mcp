import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse } from "yaml";
import type { z } from "zod/v3";
import {
  OperonSemanticConfigurationSchema, resolveOperonPriorityStableId,
  type OperonTask, type OperonFieldValue,
} from "./contract.js";

export type FilesystemConfiguration = z.infer<typeof OperonSemanticConfigurationSchema>;
type RecordValue = Record<string, unknown>;
export const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === "string" ? value : null;
const strings = (value: unknown) => array(value).filter((v): v is string => typeof v === "string");

const listKeys = ("blocking blockedBy assignees contexts reminderDatetimes reminderRules trackers related links taskGallery").split(" ");
const builtInKeys = ("operonId status taskType priority dateDue dateScheduled dateStarted datetimeCreated dateCompleted dateCancelled datetimeStart datetimeEnd estimate duration totalEstimate totalDuration repeat repeatSeriesId repeatOccurrenceDate datetimeRepeatEnd parentTask progress directSubtaskCount directDoneSubtaskCount directOpenSubtaskCount treeDescendantCount treeDoneDescendantCount treeOpenDescendantCount timezone activeTracker taskIcon taskColor note location taskImage fileTaskDisplayTitle datetimeModified").split(" ");
const managed = new Set([...builtInKeys, ...listKeys]);
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function projectFilesystemConfiguration(data: RecordValue): FilesystemConfiguration {
  const packaged = data.schemaVersion === 2 || data.schemaVersion === 3;
  const taxonomy = object(data.taxonomy);
  const pipelines = object(taxonomy.pipelines);
  const priorities = object(taxonomy.priorities);
  const keys = object(taxonomy.keyMappings);
  const filters = object(object(data.views).filters);
  const settings = packaged ? {
    ...object(data.settings), ...object(object(data.ui).taskCreationProfile),
    ...object(object(data.automation).taskAutomationPolicy),
  } : data;
  const language = str(settings.language) ?? "unknown";
  const s = (key: string) => str(settings[key]) ?? "";
  const b = (key: string) => settings[key] === true;
  const n = (key: string) => typeof settings[key] === "number" && Number.isFinite(settings[key]) ? Math.max(0, settings[key]) : 0;
  const rawFilters = packaged
    ? strings(filters.filterIds).map(id => object(filters.itemsById)[id])
    : array(data.filterSets);
  const configuration = OperonSemanticConfigurationSchema.parse({
    language,
    workflow: {
      language, defaultPipelineName: str((packaged ? pipelines : settings).defaultPipelineName),
      pipelines: array((packaged ? pipelines : settings).pipelines).map(raw => {
        const p = object(raw);
        return {
          id: str(p.id), name: p.name, description: str(p.description),
          statuses: array(p.statuses).map(rawStatus => {
            const st = object(rawStatus);
            return {
              id: str(st.id), label: st.label, value: [p.name, st.label].join("."),
              isFinished: st.isFinished === true, isCancelled: st.isCancelled === true,
              isScheduledTarget: st.isScheduledTarget === true, isTrackingTarget: st.isTrackingTarget === true,
            };
          }),
        };
      }),
    },
    priorities: {
      defaultPriority: str((packaged ? priorities : settings).defaultPriority),
      items: array((packaged ? priorities : settings).priorities).map(raw => {
        const p = object(raw);
        return { id: str(p.id), label: p.label, color: str(p.color), description: str(p.description) };
      }),
    },
    keys: (packaged ? [...array(keys.system), ...array(keys.custom)] : array(data.keyMappings)).map(raw => {
      const k = object(raw);
      return {
        canonicalKey: k.canonicalKey, visiblePropertyName: k.visiblePropertyName,
        type: str(k.type), sync: str(k.sync), enabled: k.enabled !== false,
        isSystem: k.isSystem === true, isInternal: k.isInternal === true,
      };
    }),
    creation: {
      fileTasksFolder: s("fileTasksFolder"), inlineTaskSaveMode: s("inlineTaskSaveMode"),
      inlineTaskUseDailyNote: b("inlineTaskUseDailyNote"), inlineTaskTargetFile: s("inlineTaskTargetFile"),
      inlineTaskHeading: s("inlineTaskHeading") || s("inlineTaskSpecificFileHeading"),
      inlineTaskDailyNoteAddStartDate: b("inlineTaskDailyNoteAddStartDate"),
      inlineTaskDailyNoteAddScheduledDate: b("inlineTaskDailyNoteAddScheduledDate"),
      taskCreatorDefaultToFileTask: b("taskCreatorDefaultToFileTask"),
      taskCreatorDefaultFileTemplateId: str(settings.taskCreatorDefaultFileTemplateId),
      fileTaskTemplateFolder: s("fileTaskTemplateFolder"),
      fileTaskParentInlineTargetMode: s("fileTaskParentInlineTargetMode"),
      fileTaskParentFileTargetMode: s("fileTaskParentFileTargetMode"),
      availableFileTaskTemplates: [],
    },
    automation: {
      autoCompleteParentWhenAllChildrenTerminal: b("autoCompleteParentWhenAllChildrenTerminal"),
      cascadeCancelToDescendants: b("cascadeCancelToDescendants"),
      fileTaskAutoArchiveEnabled: b("fileTaskAutoArchiveEnabled"),
      fileTaskArchiveFolder: s("fileTaskArchiveFolder"),
      fileTaskArchiveDelaySeconds: n("fileTaskArchiveDelaySeconds"),
      fileTaskArchiveOnlyFromFileTasksFolder: b("fileTaskArchiveOnlyFromFileTasksFolder"),
      fileRepeatDestination: s("fileRepeatDestination"), fileRepeatCustomFolder: s("fileRepeatCustomFolder"),
    },
    indexing: {
      excludedFolders: strings(settings.excludedFolders).sort(),
      fullReindexOnStartup: b("fullReindexOnStartup"), indexEventDebounceMs: n("indexEventDebounceMs"),
    },
    docs: { folder: s("operonDocsFolder"), autoUpdateEnabled: b("operonDocsAutoUpdateEnabled") },
    views: { filters: rawFilters.filter(Boolean).map(raw => {
      const f = object(raw);
      const { rootGroup, matchLogic, conditions, sorts, sortBy, sortOrder, groupBy, groupOrder } = f;
      return {
        id: f.id, name: f.name, icon: str(f.icon),
        definition: { rootGroup, matchLogic, conditions, sorts, sortBy, sortOrder, groupBy, groupOrder,
          subgroupBy: f.subgroupBy, subgroupOrder: f.subgroupOrder },
      };
    }) },
  });
  const { defaultPriority, items } = configuration.priorities;
  configuration.priorities.defaultPriority = resolveOperonPriorityStableId(defaultPriority, items) ?? defaultPriority;
  return configuration;
}

const scalar = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim() || null : null;

export function splitOperonList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => scalar(item) ?? []);
  if (typeof value !== "string") return [];
  // Wikilinks can contain separators and an alias. Keep each link as stored.
  return (value.match(/(?:\[\[[^\]]*\]\]|[^;,\[]|\[(?!\[))+/gu) ?? [])
    .map(item => item.trim()).filter(Boolean);
}

type StoredTask = {
  id: string; description: string; line: number | null;
  fields: Record<string, OperonFieldValue>; tags: string[];
  checkbox?: OperonTask["checkbox"]; properties?: RecordValue;
};

const storedCounters = new Set(builtInKeys.filter(key => key === "progress" || /(?:Subtask|Descendant)Count$/u.test(key)));

function decodeInlineValue(input: string, note: boolean): string {
  return input.replace(/\\\\|\\u000a|\\n|\\[{};]/giu, escape => {
    if (escape.toLowerCase() === "\\u000a" || (note && escape === "\\n")) return "\n";
    return escape.toLowerCase() === "\\n" ? escape : escape.slice(1);
  });
}

function readFields(entries: [string, unknown][], configuration: FilesystemConfiguration, inline = false) {
  const mappings = new Map(configuration.keys.map(k => [k.visiblePropertyName, k]));
  const types = new Map(configuration.keys.map(k => [k.canonicalKey, k.type]));
  const fields: Record<string, OperonFieldValue> = Object.create(null);
  for (const [key, value] of entries) {
    const canonical = mappings.get(key)?.canonicalKey ?? (key === "dateCreated" ? "datetimeCreated" : key);
    if (storedCounters.has(canonical) || canonical.startsWith("_") || (!managed.has(canonical) && !types.has(canonical))) continue;
    const isList = types.get(canonical) === "list" || listKeys.includes(canonical);
    const parsed = isList
      ? inline && typeof value === "string"
        ? (value.match(/(?:\\.|\[\[[^\]]*\]\]|[^;,\[\\]|\[(?!\[))+/gu) ?? [])
          .map(item => decodeInlineValue(item, false).trim()).filter(Boolean)
        : splitOperonList(value)
      : scalar(inline && typeof value === "string" ? decodeInlineValue(value, canonical === "note") : value);
    if (typeof parsed === "string" && key === "dateCreated" && /^\d{4}-\d{2}-\d{2}$/u.test(parsed)) {
      fields[canonical] = parsed + "T00:00:01";
    } else if (parsed !== null && parsed.length > 0) {
      fields[canonical] = parsed;
    }
  }
  return fields;
}

const fieldToken = /\{\{([^{}]+?)::[ \t]*((?:\\[\s\S]|\{\{[^{}]*\}\}|[^}\\]|\}(?!\})|\\(?=\}\}))*?)\}\}/gu;
const validId = /^[a-z0-9]{7}$/u;
const tagToken = /(^|[\s(])#([\p{L}\p{N}\p{M}_/-]+)/gu;
const fileCheckbox = (flags?: { isFinished: boolean; isCancelled: boolean }): OperonTask["checkbox"] =>
  flags?.isCancelled ? "cancelled" : flags?.isFinished ? "done" : "open";

/** Pure source decoder. It retains exact vault paths and one-based source locations. */
export function parseOperonMarkdown(content: string, path: string, configuration: FilesystemConfiguration) {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u);
  const tasks: StoredTask[] = [];
  let bodyStart = 0;
  let invalidFrontmatter = false;
  if (lines[0] === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line));
    if (end > 0) {
      bodyStart = end + 1;
      try {
        const raw = object(parse(lines.slice(1, end).join("\n"), { maxAliasCount: 0 }));
        const fields = readFields(Object.entries(raw), configuration);
        const id = scalar(raw.operonId) ?? scalar(fields.operonId);
        if (id && validId.test(id)) {
          const known = new Set([...managed, "tags", "cssclasses", "position",
            ...configuration.keys.flatMap(k => [k.canonicalKey, k.visiblePropertyName])]);
          const properties = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith("_") && !known.has(key)));
          tasks.push({
            id, line: null, fields, tags: splitOperonList(raw.tags),
            description: posix.basename(path).replace(/\.md$/iu, ""),
            properties: Object.keys(properties).length ? properties : undefined,
          });
        }
      } catch {
        invalidFrontmatter = true;
      }
    }
  }

  let fence: { marker: string; quoteDepth: number } | undefined;
  let commentEnd: string | undefined;
  let listIndent: number | undefined;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const quotePrefix = /^(?:[ \t]*>[ \t]*)*/u.exec(line)![0];
    const quoteDepth = quotePrefix.split(">").length - 1;
    const marker = /^[ \t]*(\x60{3,}|~{3,})(.*)$/u.exec(line.slice(quotePrefix.length));
    if (fence && quoteDepth < fence.quoteDepth) fence = undefined;
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (!commentEnd && marker) {
      fence = { marker: marker[1], quoteDepth };
      continue;
    }
    let visible = "";
    let rest = line;
    while (rest) {
      if (commentEnd) {
        const end = rest.indexOf(commentEnd);
        if (end < 0) break;
        rest = rest.slice(end + commentEnd.length);
        commentEnd = undefined;
        continue;
      }
      const opening = /<!--|%%|\x60+/u.exec(rest);
      if (!opening) {
        visible += rest;
        break;
      }
      visible += rest.slice(0, opening.index);
      rest = rest.slice(opening.index + opening[0].length);
      if (opening[0][0] === "\x60") {
        const closer = [...rest.matchAll(/\x60+/gu)].find(run => run[0].length === opening[0].length);
        const through = closer ? closer.index + closer[0].length : 0;
        visible += opening[0] + rest.slice(0, through);
        rest = rest.slice(through);
        continue;
      }
      commentEnd = opening[0] === "%%" ? "%%" : "-->";
    }
    const indentation = /^[ \t]*/u.exec(visible)![0].replace(/\t/gu, "    ").length;
    // Four indented columns form a code block outside a list. Inside a
    // list, the content indentation can instead introduce a nested task.
    if (indentation >= 4 && (listIndent === undefined || indentation >= listIndent + 4)) {
      continue;
    }
    const list = /^[ \t]*(?:[-*+]|\d+[.)])([ \t]+)/u.exec(visible);
    if (list) listIndent = indentation + list[0].trimStart().replace(/\t/gu, "    ").length;
    else if (visible.trim() && (listIndent === undefined || indentation < listIndent)) listIndent = undefined;
    const match = /^[ \t]*- \[([ xX-])\][ \t]*(.*)$/u.exec(visible);
    if (!match) {
      continue;
    }
    const checkbox = match[1] === " " ? "open" : match[1] === "-" ? "cancelled" : "done";
    const tokens = [...match[2].matchAll(fieldToken)];
    const fields = readFields(tokens.map(m => [m[1].trim(), m[2].trim()]), configuration, true);
    const id = scalar(fields.operonId);
    if (!id || !validId.test(id)) continue;
    const tags = tokens.filter(token => token[1].trim() === "tags").flatMap(token => splitOperonList(token[2]));
    const description = match[2].replace(fieldToken, "").replace(tagToken, (_, prefix: string, tag: string) => {
      tags.push(tag);
      return prefix;
    }).trim();
    tasks.push({ id, checkbox, description, line: i + 1, fields, tags });
  }
  return { tasks, invalidFrontmatter };
}

export function projectFilesystemTask(
  stored: StoredTask, path: string, stat: { mtime: number; birthtime?: number }, configuration: FilesystemConfiguration, timeZone?: string,
): OperonTask {
  const fields = { ...stored.fields };
  const source = stored.line === null ? "file" : "inline";
  delete fields.operonId;
  if (stored.description) fields.description = stored.description;
  const rawTags = [...new Set(stored.tags.map(tag => tag.replace(/^#/u, "")).filter(Boolean))];
  if (rawTags.length) fields.tags = rawTags;
  const priority = resolveOperonPriorityStableId(fields.priority, configuration.priorities.items) ?? scalar(fields.priority);
  if (priority) fields.priority = priority;
  if (source === "file") {
    const format = (time: number) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
        minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(time).map(({ type, value }) => [type, value]));
      return [parts.year, parts.month, parts.day].join("-") + "T" + [parts.hour, parts.minute, parts.second].join(":");
    };
    if (!fields.datetimeCreated && stat.birthtime && stat.birthtime > 0) fields.datetimeCreated = format(stat.birthtime);
    // Operon resolves the effective modification timestamp before the Bridge reads it.
    if (Number.isFinite(stat.mtime) && stat.mtime > 0) {
      const fileModified = format(stat.mtime);
      const storedModified = scalar(fields.datetimeModified);
      if (!storedModified || storedModified.localeCompare(fileModified) < 0) {
        fields.datetimeModified = fileModified;
      }
    }
  }
  for (const name of ["datetimeStart", "datetimeEnd"]) {
    const value = scalar(fields[name]);
    if (!value || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(value) || !Number.isFinite(Date.parse(value + "Z"))) {
      delete fields[name];
    }
  }
  const field = (name: string) => scalar(fields[name]);
  const status = field("status");
  const pipeline = status ? configuration.workflow.pipelines.find(p => p.statuses.some(s => s.value === status)) : undefined;
  const definition = pipeline?.statuses.find(s => s.value === status);
  const checkbox = definition ? fileCheckbox(definition) :
    field("dateCancelled") ? "cancelled" : field("dateCompleted") ? "done" : stored.checkbox ?? "open";
  const dates = {
    due: field("dateDue"), scheduled: field("dateScheduled"), started: field("dateStarted"),
    completed: field("dateCompleted"), cancelled: field("dateCancelled"),
    datetimeStart: field("datetimeStart"), datetimeEnd: field("datetimeEnd"),
    created: field("datetimeCreated"), modified: field("datetimeModified"),
  };
  // Developer API V1 Bridge adapter maps every task to warm in the list DTO.
  const tier = "warm";
  const semantics = {
    operonId: stored.id, source, path, description: stored.description, checkbox, status,
    statusId: definition?.id ?? null, statusLabel: definition?.label ?? null,
    pipeline: pipeline?.name ?? null, pipelineId: pipeline?.id ?? null,
    priority, tags: [...rawTags].sort(),
    parentTask: field("parentTask"), blocking: splitOperonList(fields.blocking),
    blockedBy: splitOperonList(fields.blockedBy), dates, fields,
    ...(stored.properties ? { properties: stored.properties } : {}),
    recurrence: { repeating: Boolean(field("repeat")), seriesId: field("repeatSeriesId"), occurrenceDate: field("repeatOccurrenceDate") },
  } as const;
  return {
    ...semantics, tier, line: stored.line, sourceMtime: stat.mtime,
    sourceKind: "operon-index", operonVersion: "unknown", bridgeVersion: "unavailable",
    revision: "filesystem-sha256:" + digest(JSON.stringify(semantics)),
  };
}
