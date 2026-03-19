import path from "node:path";
import * as chrono from "chrono-node";
import {
  add,
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfISOWeek,
  endOfMonth,
  endOfYear,
  format as formatDate,
  startOfISOWeek,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
  subYears,
} from "date-fns";

export interface Task {
  id: string;
  description: string;
  status: "complete" | "incomplete" | "cancelled" | "in_progress" | "non_task";
  statusSymbol: string;
  statusName?: string;
  statusType?: string;
  filePath: string;
  lineNumber: number;
  tags: string[];
  dueDate?: string;
  scheduledDate?: string;
  createdDate?: string;
  doneDate?: string;
  cancelledDate?: string;
  startDate?: string;
  priority?: string;
  recurrence?: string;
  metaCreatedDate?: string;
  metaModifiedDate?: string;
  fileCreatedDate?: string;
  fileModifiedDate?: string;
  originalMarkdown: string;
}

export interface ParseOptions {
  statusMap?: Record<string, Task["status"]>;
  statusNameMap?: Record<string, string>;
  statusTypeMap?: Record<string, string>;
  taskFormat?: string;
  ignoreCodeBlocks?: boolean;
  ignoreFrontmatter?: boolean;
}

export class TaskRegex {
  static readonly indentationRegex = /^([\s\t>]*)/;
  static readonly listMarkerRegex = /([-*+]|[0-9]+[.)])/;
  static readonly checkboxRegex = /\[(.)\]/u;
  static readonly afterCheckboxRegex = / *(.*)/u;
  static readonly taskRegex = new RegExp(
    TaskRegex.indentationRegex.source +
      TaskRegex.listMarkerRegex.source +
      " +" +
      TaskRegex.checkboxRegex.source +
      TaskRegex.afterCheckboxRegex.source,
    "u",
  );
  static readonly hashTags = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;
  static readonly dueDateRegex = /[📅🗓️]\s?(\d{4}-\d{2}-\d{2})/;
  static readonly scheduledDateRegex = /⏳\s?(\d{4}-\d{2}-\d{2})/;
  static readonly startDateRegex = /🛫\s?(\d{4}-\d{2}-\d{2})/;
  static readonly createdDateRegex = /➕\s?(\d{4}-\d{2}-\d{2})/;
  static readonly priorityRegex = /(⏫⏫|⏫|🔼|🔽|⏬)/g;
  static readonly recurrenceRegex = /🔁\s?(.*?)(?=(\s|$))/;
  static readonly doneDateRegex = /✅\s?(\d{4}-\d{2}-\d{2})/;
  static readonly cancelledDateRegex = /❌\s?(\d{4}-\d{2}-\d{2})/;
  static readonly dataviewFieldRegex =
    /\[(due|scheduled|start|created|done|cancelled)::\s*([^\]]+)\]/gi;
}

export function parseTasks(
  text: string,
  filePath = "",
  options: ParseOptions = {},
): Task[] {
  const lines = text.split("\n");
  const tasks: Task[] = [];
  let inCodeBlock = false;
  let inFrontmatter = false;
  const ignoreCodeBlocks = options.ignoreCodeBlocks !== false;
  const ignoreFrontmatter = options.ignoreFrontmatter !== false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (ignoreFrontmatter) {
      const trimmed = line.trim();
      if (i === 0 && trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (trimmed === "---") {
          inFrontmatter = false;
        }
        continue;
      }
    }

    if (ignoreCodeBlocks) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) {
        continue;
      }
    }

    const task = parseTaskLine(line, filePath, i, options);
    if (task) {
      tasks.push(task);
    }
  }

  return tasks;
}

export function parseTaskLine(
  line: string,
  filePath = "",
  lineNumber = 0,
  options: ParseOptions = {},
): Task | null {
  const match = line.match(TaskRegex.taskRegex);
  if (!match) {
    return null;
  }

  const statusChar = match[3];
  let description = match[4].trim();
  const taskFormat = (options.taskFormat || "").toLowerCase();
  const allowDataview = taskFormat.includes("dataview");

  const tags = (description.match(TaskRegex.hashTags) || [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  const dueMatch = description.match(TaskRegex.dueDateRegex);
  const scheduledMatch = description.match(TaskRegex.scheduledDateRegex);
  const startMatch = description.match(TaskRegex.startDateRegex);
  const createdMatch = description.match(TaskRegex.createdDateRegex);
  const recurrenceMatch = description.match(TaskRegex.recurrenceRegex);
  const doneMatch = description.match(TaskRegex.doneDateRegex);
  const cancelledMatch = description.match(TaskRegex.cancelledDateRegex);

  let dvDue: string | undefined;
  let dvScheduled: string | undefined;
  let dvStart: string | undefined;
  let dvCreated: string | undefined;
  let dvDone: string | undefined;
  let dvCancelled: string | undefined;
  if (allowDataview) {
    const dvMatches = Array.from(
      description.matchAll(TaskRegex.dataviewFieldRegex),
    );
    if (dvMatches.length > 0) {
      for (const parsedMatch of dvMatches) {
        const key = parsedMatch[1].toLowerCase();
        const raw = parsedMatch[2].trim();
        const parsed = parseDateExpression(raw);
        if (!parsed) continue;
        if (key === "due") dvDue = parsed;
        if (key === "scheduled") dvScheduled = parsed;
        if (key === "start") dvStart = parsed;
        if (key === "created") dvCreated = parsed;
        if (key === "done") dvDone = parsed;
        if (key === "cancelled") dvCancelled = parsed;
      }
      description = description
        .replace(TaskRegex.dataviewFieldRegex, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  }

  let priority: string | undefined;
  const priorityMatches = description.match(/⏫⏫|⏫|🔼|🔽|⏬/g);
  if (priorityMatches && priorityMatches.length > 0) {
    const firstPriority = priorityMatches[0];
    if (firstPriority === "⏫⏫") priority = "highest";
    else if (firstPriority === "⏫") priority = "high";
    else if (firstPriority === "🔼") priority = "medium";
    else if (firstPriority === "🔽") priority = "low";
    else if (firstPriority === "⏬") priority = "lowest";
  }

  const id = `${filePath}:${lineNumber}`;

  let status: Task["status"] = "incomplete";
  if (options.statusMap && statusChar in options.statusMap) {
    status = options.statusMap[statusChar];
  } else if (["x", "X"].includes(statusChar)) {
    status = "complete";
  } else if (["-"].includes(statusChar)) {
    status = "cancelled";
  } else if (["/"].includes(statusChar)) {
    status = "in_progress";
  } else if ([" ", ">", "<"].includes(statusChar)) {
    status = "incomplete";
  } else {
    status = "non_task";
  }

  return {
    id,
    description,
    status,
    statusSymbol: statusChar,
    statusName: options.statusNameMap
      ? options.statusNameMap[statusChar]
      : undefined,
    statusType: options.statusTypeMap
      ? options.statusTypeMap[statusChar]
      : undefined,
    filePath,
    lineNumber,
    tags,
    dueDate: (dueMatch ? dueMatch[1] : undefined) ?? dvDue,
    scheduledDate:
      (scheduledMatch ? scheduledMatch[1] : undefined) ?? dvScheduled,
    startDate: (startMatch ? startMatch[1] : undefined) ?? dvStart,
    createdDate: (createdMatch ? createdMatch[1] : undefined) ?? dvCreated,
    doneDate: (doneMatch ? doneMatch[1] : undefined) ?? dvDone,
    cancelledDate:
      (cancelledMatch ? cancelledMatch[1] : undefined) ?? dvCancelled,
    priority,
    recurrence: recurrenceMatch ? recurrenceMatch[1] : undefined,
    originalMarkdown: line,
  };
}

export function applyFilter(task: Task, filter: string): boolean {
  filter = filter.toLowerCase().trim();

  if (filter.includes(" AND ")) {
    return filter.split(" AND ").every((part) => applyFilter(task, part.trim()));
  }
  if (filter.includes(" OR ")) {
    return filter.split(" OR ").some((part) => applyFilter(task, part.trim()));
  }
  if (filter.includes(" and ")) {
    return filter.split(" and ").every((part) => applyFilter(task, part.trim()));
  }
  if (filter.includes(" or ")) {
    return filter.split(" or ").some((part) => applyFilter(task, part.trim()));
  }
  if (filter.startsWith("not ")) {
    return !applyFilter(task, filter.substring(4));
  }

  const statusType = (task.statusType || "").toUpperCase();
  if (filter === "done") {
    return statusType ? statusType === "DONE" : task.status === "complete";
  }
  if (filter === "not done") {
    if (statusType) {
      return statusType === "TODO" || statusType === "IN_PROGRESS";
    }
    return task.status === "incomplete" || task.status === "in_progress";
  }
  if (filter === "cancelled") {
    return statusType ? statusType === "CANCELLED" : task.status === "cancelled";
  }
  if (filter === "in progress") {
    return statusType
      ? statusType === "IN_PROGRESS"
      : task.status === "in_progress";
  }
  if (filter === "todo") {
    return statusType ? statusType === "TODO" : task.status === "incomplete";
  }
  if (filter === "not cancelled") {
    return statusType ? statusType !== "CANCELLED" : task.status !== "cancelled";
  }
  if (filter === "non task" || filter === "non-task") {
    return task.status === "non_task";
  }
  if (filter === "task" || filter === "is task") {
    return task.status !== "non_task";
  }

  const statusTypeMatch = filter.match(/^status[ .]?type\s+is\s+(.+)$/);
  if (statusTypeMatch) {
    const wanted = normalizeStatusType(statusTypeMatch[1]);
    if (!wanted) return false;
    return statusType === wanted;
  }

  const statusTypeNotMatch = filter.match(
    /^status[ .]?type\s+is\s+not\s+(.+)$/,
  );
  if (statusTypeNotMatch) {
    const unwanted = normalizeStatusType(statusTypeNotMatch[1]);
    if (!unwanted) return true;
    return statusType !== unwanted;
  }

  const statusNameMatch = filter.match(/^status[ .]?name\s+is\s+(.+)$/);
  if (statusNameMatch) {
    const wanted = statusNameMatch[1]
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
    return (task.statusName || "").toLowerCase() === wanted;
  }

  const statusNameNotMatch = filter.match(/^status[ .]?name\s+is\s+not\s+(.+)$/);
  if (statusNameNotMatch) {
    const unwanted = statusNameNotMatch[1]
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
    return (task.statusName || "").toLowerCase() !== unwanted;
  }

  if (filter === "has done date") return task.doneDate !== undefined;
  if (filter === "no done date") return task.doneDate === undefined;
  if (filter.startsWith("done ")) return matchDateFilter(filter, "done", task.doneDate);

  if (filter === "has cancelled date") return task.cancelledDate !== undefined;
  if (filter === "no cancelled date") return task.cancelledDate === undefined;
  if (filter.startsWith("cancelled ")) {
    return matchDateFilter(filter, "cancelled", task.cancelledDate);
  }

  if (
    filter.startsWith("due") ||
    filter === "has due date" ||
    filter === "no due date"
  ) {
    if (filter === "no due date") return task.dueDate === undefined;
    if (filter === "has due date") return task.dueDate !== undefined;
    return matchDateFilter(filter, "due", task.dueDate);
  }

  if (
    filter.startsWith("scheduled") ||
    filter === "has scheduled date" ||
    filter === "no scheduled date"
  ) {
    if (filter === "no scheduled date") return task.scheduledDate === undefined;
    if (filter === "has scheduled date") return task.scheduledDate !== undefined;
    return matchDateFilter(filter, "scheduled", task.scheduledDate);
  }

  if (
    filter.startsWith("start") ||
    filter === "has start date" ||
    filter === "no start date"
  ) {
    if (filter === "no start date") return task.startDate === undefined;
    if (filter === "has start date") return task.startDate !== undefined;
    return matchDateFilter(filter, "start", task.startDate);
  }

  if (
    filter.startsWith("created") ||
    filter === "has created date" ||
    filter === "no created date"
  ) {
    if (filter === "no created date") return task.createdDate === undefined;
    if (filter === "has created date") return task.createdDate !== undefined;
    return matchDateFilter(filter, "created", task.createdDate);
  }

  if (filter === "no tags") return !task.tags || task.tags.length === 0;
  if (filter === "has tags") return task.tags && task.tags.length > 0;

  if (filter.startsWith("tag includes ") || filter.startsWith("tag include ")) {
    const raw = filter.startsWith("tag includes ")
      ? filter.split("tag includes ")[1]
      : filter.split("tag include ")[1];
    const tagToFind = (raw || "").trim().replace(/^#/, "");
    if (!tagToFind) return false;
    return task.tags?.some((tag) =>
      tag.replace(/^#/, "").includes(tagToFind),
    );
  }

  if (filter.startsWith("has tag ")) {
    const tagToFind = filter.substring(8).trim().replace(/^#/, "");
    return task.tags?.some((tag) => tag.replace(/^#/, "") === tagToFind);
  }

  if (
    filter.startsWith("tag do not include") ||
    filter.startsWith("tag does not include")
  ) {
    const tagToExclude = filter
      .split("does not include")[1]
      .trim()
      .replace(/^#/, "");
    if (!tagToExclude) return true;
    return !task.tags?.some((tag) =>
      tag.replace(/^#/, "").includes(tagToExclude),
    );
  }

  if (filter.startsWith("path includes")) {
    return task.filePath
      .toLowerCase()
      .includes(filter.split("includes")[1].trim().toLowerCase());
  }
  if (filter.startsWith("path does not include")) {
    return !task.filePath
      .toLowerCase()
      .includes(filter.split("does not include")[1].trim().toLowerCase());
  }

  if (filter.startsWith("folder includes")) {
    const folder = path.dirname(task.filePath).toLowerCase();
    return folder.includes(filter.split("includes")[1].trim().toLowerCase());
  }
  if (filter.startsWith("folder does not include")) {
    const folder = path.dirname(task.filePath).toLowerCase();
    return !folder.includes(
      filter.split("does not include")[1].trim().toLowerCase(),
    );
  }

  if (filter.startsWith("filename includes")) {
    const filename = path.basename(task.filePath).toLowerCase();
    return filename.includes(filter.split("includes")[1].trim().toLowerCase());
  }
  if (filter.startsWith("filename does not include")) {
    const filename = path.basename(task.filePath).toLowerCase();
    return !filename.includes(
      filter.split("does not include")[1].trim().toLowerCase(),
    );
  }

  if (filter.startsWith("description includes")) {
    return task.description
      .toLowerCase()
      .includes(filter.split("includes")[1].trim().toLowerCase());
  }
  if (filter.startsWith("description does not include")) {
    return !task.description
      .toLowerCase()
      .includes(filter.split("does not include")[1].trim().toLowerCase());
  }

  if (filter.startsWith("file created")) {
    return matchDateFilter(filter, "file created", task.fileCreatedDate);
  }
  if (filter.startsWith("file modified")) {
    return matchDateFilter(filter, "file modified", task.fileModifiedDate);
  }
  if (filter.startsWith("meta created")) {
    return matchDateFilter(filter, "meta created", task.metaCreatedDate);
  }
  if (filter.startsWith("meta modified")) {
    return matchDateFilter(filter, "meta modified", task.metaModifiedDate);
  }

  if (filter.startsWith("priority is")) {
    const priority = filter.split("priority is")[1].trim();
    if (priority === "none") return task.priority === undefined;
    return task.priority === priority;
  }

  return task.description.toLowerCase().includes(filter);
}

export function parseQuery(queryText: string): string[] {
  return queryText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function queryTasks(tasks: Task[], queryText: string): Task[] {
  const filters = parseQuery(queryText);
  return tasks.filter((task) =>
    filters.every((filter) => applyFilter(task, filter)),
  );
}

export function taskToString(task: Task): string {
  return task.originalMarkdown;
}

function normalizeStatusType(input: string): string | null {
  const cleaned = input.trim().toLowerCase();
  const map: Record<string, string> = {
    done: "DONE",
    complete: "DONE",
    completed: "DONE",
    cancelled: "CANCELLED",
    canceled: "CANCELLED",
    "in progress": "IN_PROGRESS",
    in_progress: "IN_PROGRESS",
    "in-progress": "IN_PROGRESS",
    todo: "TODO",
    "to do": "TODO",
    incomplete: "TODO",
    "non task": "NON_TASK",
    non_task: "NON_TASK",
    "non-task": "NON_TASK",
    nontask: "NON_TASK",
  };
  if (cleaned in map) return map[cleaned];
  const upper = cleaned.toUpperCase().replace(/\s+/g, "_");
  return ["DONE", "CANCELLED", "IN_PROGRESS", "TODO", "NON_TASK"].includes(
    upper,
  )
    ? upper
    : null;
}

function parseDateExpression(expr: string, reference: Date = new Date()): string | undefined {
  const trimmed = expr.trim();
  if (!trimmed) return undefined;
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoMatch) return isoMatch[1];

  const parsedFr = chrono.fr.parseDate(trimmed, reference);
  if (parsedFr) return formatDate(parsedFr, "yyyy-MM-dd");

  const parsedEn = chrono.en.parseDate(trimmed, reference);
  if (parsedEn) return formatDate(parsedEn, "yyyy-MM-dd");

  return undefined;
}

function getRangeForKeyword(
  keyword: string,
  reference: Date = new Date(),
): { start: string; end: string } | undefined {
  const normalized = keyword.toLowerCase().trim();

  if (normalized === "today" || normalized === "aujourd'hui") {
    const day = formatDate(reference, "yyyy-MM-dd");
    return { start: day, end: day };
  }
  if (normalized === "tomorrow" || normalized === "demain") {
    const day = formatDate(addDays(reference, 1), "yyyy-MM-dd");
    return { start: day, end: day };
  }
  if (normalized === "yesterday" || normalized === "hier") {
    const day = formatDate(subDays(reference, 1), "yyyy-MM-dd");
    return { start: day, end: day };
  }
  if (normalized === "this week" || normalized === "cette semaine") {
    return {
      start: formatDate(startOfISOWeek(reference), "yyyy-MM-dd"),
      end: formatDate(endOfISOWeek(reference), "yyyy-MM-dd"),
    };
  }
  if (normalized === "next week" || normalized === "semaine prochaine") {
    const next = addWeeks(reference, 1);
    return {
      start: formatDate(startOfISOWeek(next), "yyyy-MM-dd"),
      end: formatDate(endOfISOWeek(next), "yyyy-MM-dd"),
    };
  }
  if (
    normalized === "last week" ||
    normalized === "semaine dernière" ||
    normalized === "semaine derniere"
  ) {
    const previous = subWeeks(reference, 1);
    return {
      start: formatDate(startOfISOWeek(previous), "yyyy-MM-dd"),
      end: formatDate(endOfISOWeek(previous), "yyyy-MM-dd"),
    };
  }
  if (
    normalized === "this month" ||
    normalized === "ce mois" ||
    normalized === "ce mois-ci"
  ) {
    return {
      start: formatDate(startOfMonth(reference), "yyyy-MM-dd"),
      end: formatDate(endOfMonth(reference), "yyyy-MM-dd"),
    };
  }
  if (normalized === "next month" || normalized === "mois prochain") {
    const next = addMonths(reference, 1);
    return {
      start: formatDate(startOfMonth(next), "yyyy-MM-dd"),
      end: formatDate(endOfMonth(next), "yyyy-MM-dd"),
    };
  }
  if (normalized === "last month" || normalized === "mois dernier") {
    const previous = subMonths(reference, 1);
    return {
      start: formatDate(startOfMonth(previous), "yyyy-MM-dd"),
      end: formatDate(endOfMonth(previous), "yyyy-MM-dd"),
    };
  }
  if (
    normalized === "this year" ||
    normalized === "cette année" ||
    normalized === "cette annee"
  ) {
    return {
      start: formatDate(startOfYear(reference), "yyyy-MM-dd"),
      end: formatDate(endOfYear(reference), "yyyy-MM-dd"),
    };
  }
  if (
    normalized === "next year" ||
    normalized === "année prochaine" ||
    normalized === "annee prochaine"
  ) {
    const next = addYears(reference, 1);
    return {
      start: formatDate(startOfYear(next), "yyyy-MM-dd"),
      end: formatDate(endOfYear(next), "yyyy-MM-dd"),
    };
  }
  if (
    normalized === "last year" ||
    normalized === "année dernière" ||
    normalized === "annee derniere"
  ) {
    const previous = subYears(reference, 1);
    return {
      start: formatDate(startOfYear(previous), "yyyy-MM-dd"),
      end: formatDate(endOfYear(previous), "yyyy-MM-dd"),
    };
  }

  return undefined;
}

function parseRangeExpression(
  expr: string,
  reference: Date = new Date(),
): { start: string; end: string } | undefined {
  const keywordRange = getRangeForKeyword(expr, reference);
  if (keywordRange) return keywordRange;

  const normalized = expr.toLowerCase().trim();
  const nextMatch = normalized.match(
    /^(?:the\s+)?next\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/,
  );
  if (nextMatch) {
    const count = Number(nextMatch[1]);
    const unit = nextMatch[2].replace(/s$/, "");
    const end = addByUnit(reference, count, unit);
    return {
      start: formatDate(reference, "yyyy-MM-dd"),
      end: formatDate(end, "yyyy-MM-dd"),
    };
  }

  const inMatch = normalized.match(
    /^in\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/,
  );
  if (inMatch) {
    const count = Number(inMatch[1]);
    const unit = inMatch[2].replace(/s$/, "");
    const end = addByUnit(reference, count, unit);
    return {
      start: formatDate(reference, "yyyy-MM-dd"),
      end: formatDate(end, "yyyy-MM-dd"),
    };
  }

  return undefined;
}

function addByUnit(reference: Date, count: number, unit: string): Date {
  return add(reference, {
    days: unit === "day" ? count : 0,
    weeks: unit === "week" ? count : 0,
    months: unit === "month" ? count : 0,
    years: unit === "year" ? count : 0,
  });
}

function compareDate(value: string | undefined, op: string, target: string): boolean {
  if (!value) return false;
  const normalizedValue = value.substring(0, 10);
  if (op === "before") return normalizedValue < target;
  if (op === "after") return normalizedValue > target;
  if (op === "on") return normalizedValue === target;
  if (op === "on or before") return normalizedValue <= target;
  if (op === "on or after") return normalizedValue >= target;
  return false;
}

function matchDateFilter(filter: string, prefix: string, value?: string): boolean {
  const remainder = filter.slice(prefix.length).trim();
  const rangeMatch = remainder.match(/^in\s+(.+)$/);
  if (rangeMatch) {
    const range = parseRangeExpression(rangeMatch[1]);
    if (!range || !value) return false;
    const normalizedValue = value.substring(0, 10);
    return normalizedValue >= range.start && normalizedValue <= range.end;
  }

  const opMatch = remainder.match(
    /^(on or before|on or after|before|after|on)\s+(.+)$/,
  );
  if (!opMatch) return false;
  const op = opMatch[1];
  const dateExpr = opMatch[2];
  const range = getRangeForKeyword(dateExpr);
  if (range) {
    const normalizedValue = value ? value.substring(0, 10) : undefined;
    if (!normalizedValue) return false;
    if (op === "on") return normalizedValue >= range.start && normalizedValue <= range.end;
    if (op === "before") return normalizedValue < range.start;
    if (op === "after") return normalizedValue > range.end;
    if (op === "on or before") return normalizedValue <= range.end;
    if (op === "on or after") return normalizedValue >= range.start;
    return false;
  }

  const parsed = parseDateExpression(dateExpr);
  if (!parsed) return false;
  return compareDate(value, op, parsed);
}
