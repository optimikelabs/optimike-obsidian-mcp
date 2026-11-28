import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { parseOperonMarkdown, type FilesystemConfiguration } from "./filesystemFormat.js";
import type { OperonTask } from "./contract.js";

// Wire storage order for the scalar fields this writer admits. Operon stores
// completion and cancellation as local calendar days (dateCompleted/dateCancelled).
const fields = ["operonId", "status", "priority", "dateDue", "dateScheduled", "dateStarted",
  "dateCompleted", "dateCancelled", "datetimeStart", "datetimeEnd", "estimate",
  "datetimeCreated", "datetimeModified"];
const simpleValue = /^[\p{L}\p{M}\p{N} ._:+-]+$/u;
const portableTag = /^[\p{L}\p{M}\p{N}_/-]+$/u;

export function supportsFilesystemMutationFormat(version: string, configuration: FilesystemConfiguration) {
  const keys = configuration.keys.filter(key => key.enabled);
  return version === "4.6.0" && !keys.some(key => fields.includes(key.canonicalKey) && !key.isSystem) &&
    new Set(keys.map(key => key.visiblePropertyName)).size === keys.length;
}

export function unsupportedFilesystemMutation(message: string): never {
  throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, message, { reasonCode: "operon_filesystem_live_required" });
}

export function simpleTaskDescription(description: string) {
  if (!description || description !== description.trim() || /[\r\n{}#<>%`]|^(?:\d\d?:\d\d|\[)/u.test(description)) {
    return unsupportedFilesystemMutation("This task description requires native Operon Markdown interpretation.");
  }
  return description;
}

export function normalizeTaskTags(tags: string[]) {
  const cleaned = tags.map(tag => tag.replace(/^#/u, ""));
  if (cleaned.some(tag => !portableTag.test(tag)) || new Set(cleaned).size !== cleaned.length) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Use distinct portable Obsidian tags.");
  }
  return cleaned;
}

function assertSimpleField(key: string, value: string) {
  if (!fields.includes(key) || !simpleValue.test(value) || value !== value.trim()) {
    unsupportedFilesystemMutation("This task uses stored fields or values that require the native Operon writer.");
  }
}

export function renderInlineTask(description: string, tags: string[], values: Record<string, string>, checkbox: OperonTask["checkbox"], indent = "", aliases = new Map<string, string>()) {
  for (const [key, value] of Object.entries(values)) assertSimpleField(key, value);
  return indent + [
    checkbox === "done" ? "- [x]" : checkbox === "cancelled" ? "- [-]" : "- [ ]",
    simpleTaskDescription(description), ...normalizeTaskTags(tags).map(tag => "#" + tag),
    ...fields.flatMap(key => values[key] === undefined ? [] : [`{{${aliases.get(key) ?? key}:: ${values[key]}}}`]),
  ].join(" ");
}

export type SimpleTaskEdit = {
  description?: string;
  tags?: string[];
  checkbox?: OperonTask["checkbox"];
  fields: Record<string, string | null>;
};

/** Compile one source replacement. The governed backend owns BOM/EOL and vault dates. */
export function editTaskSource(content: string, task: OperonTask, configuration: FilesystemConfiguration, edit: SimpleTaskEdit) {
  const stored = parseOperonMarkdown(content, task.path, configuration).tasks.find(row => row.id === task.operonId && row.line === task.line);
  if (!stored) throw new McpError(BaseErrorCode.CONFLICT, "The exact task source changed during planning.");
  if (task.line === null) {
    if (configuration.keys.some(key => key.enabled && key.sync !== null && fields.includes(key.canonicalKey) && key.visiblePropertyName !== key.canonicalKey)) {
      return unsupportedFilesystemMutation("Mapped file-task properties require the native writer.");
    }
    return editFileTaskSource(content, task, edit);
  }
  const lines = content.split(/(\r\n|\n|\r)/u);
  const index = (task.line - 1) * 2;
  const raw = lines[index];
  const prefix = /^(\uFEFF?)([ \t]*)/u.exec(raw)!;
  const aliases = new Map<string, string>();
  for (const [, visible] of raw.matchAll(/\{\{([^{}:]+):: [^{}]+\}\}/gu)) {
    const mapping = configuration.keys.find(key => key.enabled && key.visiblePropertyName === visible);
    if (mapping && mapping.canonicalKey !== visible) aliases.set(mapping.canonicalKey, visible);
  }
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(stored.fields)) {
    if (typeof value !== "string") return unsupportedFilesystemMutation("This inline task has a list or mapped property requiring the native writer.");
    values[key] = value;
  }
  // Refuse sources where the read projection discarded or transformed bytes.
  // This excludes comments, unmanaged fields, legacy aliases and noncanonical tokens.
  if (raw !== prefix[1] + renderInlineTask(stored.description, stored.tags, values, stored.checkbox!, prefix[2], aliases)) {
    return unsupportedFilesystemMutation("Only canonical scalar inline task lines are writable without Desktop.");
  }
  for (const [key, value] of Object.entries(edit.fields)) {
    if (value === null) delete values[key];
    else values[key] = value;
  }
  lines[index] = prefix[1] + renderInlineTask(edit.description ?? stored.description, edit.tags ?? stored.tags,
    values, edit.checkbox ?? stored.checkbox!, prefix[2], aliases);
  return lines.join("");
}

function editFileTaskSource(content: string, task: OperonTask, edit: SimpleTaskEdit) {
  if (edit.tags || (edit.description !== undefined && edit.description !== task.description)) {
    return unsupportedFilesystemMutation("File task tags and filename changes require the native writer.");
  }
  const envelope = /^(\uFEFF?---(\r?\n))([\s\S]*?)(\r?\n---(?:\r?\n|$))/u.exec(content);
  if (!envelope) return unsupportedFilesystemMutation("This file task frontmatter requires the native writer.");
  const [, open, eol, yaml, close] = envelope;
  const entries = new Map<string, string>();
  for (const line of yaml.split(eol)) {
    const property = /^([\p{L}\p{M}\p{N}_-]+):(?: (.*))?$/u.exec(line);
    if (!property || entries.has(property[1]) || (property[2] && !simpleValue.test(property[2]))) {
      return unsupportedFilesystemMutation("Only simple scalar file task frontmatter is writable without Desktop.");
    }
    entries.set(property[1], property[2] ?? "");
  }
  if (entries.get("operonId") !== task.operonId) throw new McpError(BaseErrorCode.CONFLICT, "The file task identity changed.");
  for (const [key, value] of Object.entries(edit.fields)) {
    if (value === null) {
      if (entries.has(key)) entries.set(key, "");
    } else {
      assertSimpleField(key, value);
      entries.set(key, value);
    }
  }
  return open + [...entries].map(([key, value]) => value ? `${key}: ${value}` : `${key}:`).join(eol) + close + content.slice(envelope[0].length);
}
