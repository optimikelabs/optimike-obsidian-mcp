
import type { OperonTask } from "./contract.js";
import { formatOperonLocalTime, object, splitOperonList, type FilesystemConfiguration } from "./filesystemFormat.js";

type Predicate = (task: OperonTask) => boolean;
const logic = {
  all: (children: Predicate[], task: OperonTask) => children.every(test => test(task)),
  any: (children: Predicate[], task: OperonTask) => children.some(test => test(task)),
  none: (children: Predicate[], task: OperonTask) => !children.some(test => test(task)),
};

const textOperators: Record<string, (actual: string, target: string) => boolean> = {
  contains: (a, b) => a.includes(b), notContains: (a, b) => !a.includes(b),
  is: (a, b) => a === b, isNot: (a, b) => a !== b,
  startsWith: (a, b) => a.startsWith(b), endsWith: (a, b) => a.endsWith(b),
  hasAnyValue: a => !!a.trim(), hasNoValue: a => !a.trim(),
};
const listOperators: Record<string, (items: string[], target: string) => boolean> = {
  anyContains: (items, value) => items.some(item => item.includes(value)),
  anyStartsWith: (items, value) => items.some(item => item.startsWith(value)),
  anyEndsWith: (items, value) => items.some(item => item.endsWith(value)),
  noneContain: (items, value) => items.every(item => !item.includes(value)),
  noneStartWith: (items, value) => items.every(item => !item.startsWith(value)),
  noneEndWith: (items, value) => items.every(item => !item.endsWith(value)),
  allAre: (items, value) => items.length > 0 && items.every(item => item === value),
  allContain: (items, value) => items.length > 0 && items.every(item => item.includes(value)),
  countIs: (items, value) => items.length === Number(value),
  countNot: (items, value) => items.length !== Number(value),
  countLt: (items, value) => items.length < Number(value),
  countGt: (items, value) => items.length > Number(value),
  hasAnyValue: items => items.length > 0,
  hasNoValue: items => items.length === 0,
};
const numberOperators: Record<string, (actual: number, target: number) => boolean> = {
  eq: (a, b) => a === b, neq: (a, b) => a !== b, lt: (a, b) => a < b, gt: (a, b) => a > b,
  lte: (a, b) => a <= b, gte: (a, b) => a >= b,
  divisible: (a, b) => b !== 0 && a % b === 0, notDivisible: (a, b) => b !== 0 && a % b !== 0,
};
const sortFields = new Set(["description", "status", "priority", "checkbox", "dateDue", "dateScheduled", "datetimeModified", "folders"]);
export function localDate(now: Date, timeZone?: string): string {
  return formatOperonLocalTime(now, timeZone).slice(0, 10);
}

function folderPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index).toLowerCase();
}

function compileNode(input: unknown, pinned: ReadonlySet<string> | null, today: string, depth = 0): Predicate {
  const node = object(input);
  if (depth > 32) throw new Error("filter depth");
  if (Array.isArray(node.children)) {
    const name = node.logic;
    if (name !== "all" && name !== "any" && name !== "none") throw new Error("group logic");
    const children = node.children.map(child => compileNode(child, pinned, today, depth + 1));
    return task => logic[name](children, task);
  }
  const { field, fieldType, operator, value } = node;
  if ([value, ...(Array.isArray(node.values) ? node.values : [])].some(item => typeof item === "string" && item.includes("{{"))) {
    throw new Error("dynamic filter expression");
  }
  if (typeof field !== "string" || typeof operator !== "string") throw new Error("filter condition");
  if (field.startsWith("file.property:") || field.startsWith("__")) throw new Error("unsupported property projection");
  const target = typeof value === "string" ? value : "";
  if (fieldType === "folders" && operator === "isInFolderTree") {
    const folder = target.replace(/\\/gu, "/").trim().replace(/^\/+|\/+$/gu, "").toLowerCase();
    return task => Boolean(folder) && ("/" + folderPath(task.path) + "/").includes("/" + folder + "/");
  }
  const read = (task: OperonTask) => field === "description" ? task.description :
    field === "tags" ? task.tags : (Object.hasOwn(task.fields, field) ? task.fields[field] :
    task.properties && Object.hasOwn(task.properties, field) ? task.properties[field] : undefined);
  if (fieldType === "checkbox" && field === "checkbox") {
    const state = new Map([["isOpen", "open"], ["isDone", "done"], ["isCancelled", "cancelled"]]).get(operator);
    if (state) return task => task.checkbox === state;
  }
  if (fieldType === "pinned" && pinned) {
    if (operator === "isPinned") return task => pinned.has(task.operonId);
    if (operator === "isNotPinned") return task => !pinned.has(task.operonId);
  }
  if (fieldType === "text" && Object.hasOwn(textOperators, operator)) {
    return task => textOperators[operator](String(read(task) ?? "").toLowerCase(), target.toLowerCase());
  }
  if (fieldType === "number") {
    const num = (task: OperonTask) => {
      const raw = read(task);
      return typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
    };
    if (operator === "hasAnyValue") return task => Number.isFinite(num(task));
    if (operator === "hasNoValue") return task => !Number.isFinite(num(task));
    if (Object.hasOwn(numberOperators, operator) && target.trim() && Number.isFinite(Number(target))) {
      return task => Number.isFinite(num(task)) && numberOperators[operator](num(task), Number(target));
    }
  }
  if (fieldType === "date" || fieldType === "datetime") {
    const date = (task: OperonTask) => String(read(task) ?? "").slice(0, 10);
    if (operator === "hasAnyValue") return task => Boolean(date(task));
    if (operator === "hasNoValue") return task => !date(task);
    if (operator === "dateIs") return task => date(task) === target;
    if (operator === "before") return task => !!date(task) && date(task) < target;
    if (operator === "after") return task => !!date(task) && date(task) > target;
    if (operator === "isToday") return task => date(task) === today;
    if (operator === "notToday") return task => !!date(task) && date(task) !== today;
    if (operator === "beforeToday") return task => !!date(task) && date(task) < today;
    if (operator === "afterToday") return task => date(task) > today;
    if (operator === "thisWeek") {
      // Operon 4.6 starts weeks on Monday. UTC arithmetic here steps through calendar dates only.
      const monday = new Date(today + "T00:00:00Z");
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const start = monday.toISOString().slice(0, 10);
      monday.setUTCDate(monday.getUTCDate() + 6);
      const end = monday.toISOString().slice(0, 10);
      return task => date(task) >= start && date(task) <= end;
    }
    if (operator === "underDaysAgo" || operator === "underDaysAway") {
      const days = Number(target);
      if (!Number.isInteger(days) || days < 0) throw new Error("invalid day count");
      return task => {
        const difference = (Date.parse(today) - Date.parse(date(task))) / 86_400_000;
        const distance = operator === "underDaysAgo" ? difference : -difference;
        return distance > 0 && distance <= days;
      };
    }
  }
  if ((fieldType === "list" || fieldType === "tags") && Object.hasOwn(listOperators, operator)) {
    return task => listOperators[operator](splitOperonList(read(task)).map(item => item.toLowerCase()), target.toLowerCase());
  }
  throw new Error("unsupported condition");
}

export function compileSavedFilter(
  definition: Record<string, unknown>, pinned: ReadonlySet<string> | null,
  configuration: FilesystemConfiguration, now: Date, timeZone?: string,
) {
  if (definition.groupBy || definition.subgroupBy) throw new Error("grouped filter");
  const predicate = compileNode(definition.rootGroup ?? {
    logic: definition.matchLogic, children: definition.conditions,
  }, pinned, localDate(now, timeZone));
  const specs = Array.isArray(definition.sorts) ? definition.sorts :
    definition.sortBy ? [{ field: definition.sortBy, order: definition.sortOrder }] : [];
  const ranks = (items: (string | null)[][]) => new Map(items.flatMap((keys, index) =>
    keys.flatMap(key => key === null ? [] : [[key, index] as const])));
  const priorityRanks = ranks(configuration.priorities.items.map(item => [item.id, item.label]));
  const statusRanks = ranks(configuration.workflow.pipelines.flatMap(p => p.statuses.map(s => [s.id, s.value])));
  const checkboxRanks = ranks([["open"], ["done"], ["cancelled"]]);
  const comparators = specs.map(raw => {
    const spec = object(raw);
    const field = spec.field;
    if (typeof field !== "string" || !sortFields.has(field) ||
        (spec.order !== "asc" && spec.order !== "desc")) throw new Error("unsupported sorting");
    const ranking = field === "checkbox" ? checkboxRanks : field === "priority" ? priorityRanks :
      field === "status" ? statusRanks : undefined;
    const value = (task: OperonTask) => field === "description" ? task.description :
      field === "checkbox" ? task.checkbox : field === "folders" ? folderPath(task.path) : String(task.fields[field] ?? "");
    const order = spec.order === "desc" ? -1 : 1;
    return (left: OperonTask, right: OperonTask) => {
      const a = value(left);
      const b = value(right);
      const missing = Number.MAX_SAFE_INTEGER;
      if (order === 1 && /^(?:date|datetime)/u.test(field) && Boolean(a) !== Boolean(b)) return a ? -1 : 1;
      return order * (ranking ? (ranking.get(a) ?? missing) - (ranking.get(b) ?? missing) : a.localeCompare(b));
    };
  });
  return { predicate, compare: (a: OperonTask, b: OperonTask) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result) return result;
    }
    return a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0);
  } };
}
