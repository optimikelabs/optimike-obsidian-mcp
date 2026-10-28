import { createHash } from "node:crypto";
import { load } from "js-yaml";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { operationDigest } from "./operations/contract.js";
import { validateObsidianBase } from "./obsidianFormatService.js";

/**
 * Governed edit of a whole Obsidian Base configuration: global filters,
 * formulas, property settings, summaries and views (any view key, including
 * plugin and view-state keys). Edits go through the YAML document model, so
 * comments and untouched values survive; the compiled result is checked
 * against an independent model of the same intent before it can be sealed.
 */
export type BaseJsonValue = string | number | boolean | null | BaseJsonValue[] | { [key: string]: BaseJsonValue };
export type BaseFilterNode = string | { and: BaseFilterNode[] } | { or: BaseFilterNode[] } | { not: BaseFilterNode[] };

export type BaseConfigPatchOperation =
  | { op: "set_filters"; filters: BaseFilterNode }
  | { op: "delete_filters" }
  | { op: "set_formula"; name: string; expression: string }
  | { op: "delete_formula"; name: string }
  | { op: "set_property"; property: string; key: string; value: BaseJsonValue }
  | { op: "delete_property"; property: string; key?: string }
  | { op: "set_summary"; name: string; formula: string }
  | { op: "delete_summary"; name: string }
  | { op: "add_view"; view: { [key: string]: BaseJsonValue }; position?: number }
  | { op: "delete_view"; view: string }
  | { op: "move_view"; view: string; position: number }
  | { op: "set_view_key"; view: string; key: string; value: BaseJsonValue }
  | { op: "delete_view_key"; view: string; key: string };

export type BaseConfigPatchProof = {
  contractVersion: 1;
  compilerVersion: 1;
  sourcePreservation: "semantic-identical-outside-authorized-paths";
  formattingPreserved: boolean;
  lineEnding: "lf" | "crlf";
  patchDigest: string;
  changedPaths: string[];
  beforeSha256: string;
  afterSha256: string;
  warnings: string[];
};

export type CompiledBaseConfigPatch = { nextYaml: string; proof: BaseConfigPatchProof };

const MAX_OPERATIONS = 64;
const MAX_VALUE_BYTES = 65_536;
const MAX_DEPTH = 16;
const NAME = /^[^\u0000-\u001f]{1,256}$/u;
const KEY = /^[^\u0000-\u001f]{1,128}$/u;

function fail(message: string, reasonCode: string): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, { reasonCode });
}
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

function assertJson(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) fail("Base values are nested too deeply.", "base_config_value_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Base numbers must be finite.", "base_config_value_invalid");
    return;
  }
  if (Array.isArray(value)) { value.forEach((item) => assertJson(item, depth + 1)); return; }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!KEY.test(key) || key === "<<") fail("Base keys must be short plain strings.", "base_config_value_invalid");
      assertJson(item, depth + 1);
    }
    return;
  }
  fail("Base values must be JSON values.", "base_config_value_invalid");
}

function assertFilter(node: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) fail("Base filters are nested too deeply.", "base_config_filter_invalid");
  if (typeof node === "string") {
    if (!node.trim()) fail("A Base filter statement cannot be empty.", "base_config_filter_invalid");
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) fail("A Base filter is a statement or an and/or/not group.", "base_config_filter_invalid");
  const keys = Object.keys(node);
  if (keys.length !== 1 || !["and", "or", "not"].includes(keys[0]!)) fail("A Base filter group has exactly one of and, or, not.", "base_config_filter_invalid");
  const items = (node as Record<string, unknown>)[keys[0]!];
  if (!Array.isArray(items) || items.length === 0) fail("A Base filter group lists at least one filter.", "base_config_filter_invalid");
  items.forEach((item) => assertFilter(item, depth + 1));
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME.test(value) || value.trim() !== value) fail(`${label} must be a non-empty unpadded name.`, "base_config_name_invalid");
  return value;
}

export function canonicalizeBaseConfigPatchOperations(operations: BaseConfigPatchOperation[]): BaseConfigPatchOperation[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    fail(`Base configuration patches require between 1 and ${MAX_OPERATIONS} operations.`, "base_config_patch_size");
  }
  return operations.map((operation) => {
    const op = clone(operation);
    switch (op.op) {
      case "set_filters": assertFilter(op.filters); break;
      case "delete_filters": break;
      case "set_formula":
        name(op.name, "Formula name");
        if (typeof op.expression !== "string" || !op.expression.trim()) fail("A formula expression cannot be empty.", "base_config_value_invalid");
        break;
      case "delete_formula": name(op.name, "Formula name"); break;
      case "set_property":
        name(op.property, "Property"); name(op.key, "Property setting"); assertJson(op.value); break;
      case "delete_property":
        name(op.property, "Property"); if (op.key !== undefined) name(op.key, "Property setting"); break;
      case "set_summary":
        name(op.name, "Summary name");
        if (typeof op.formula !== "string" || !op.formula.trim()) fail("A summary formula cannot be empty.", "base_config_value_invalid");
        break;
      case "delete_summary": name(op.name, "Summary name"); break;
      case "add_view":
        if (!op.view || typeof op.view !== "object" || Array.isArray(op.view)) fail("A view is an object.", "base_config_view_invalid");
        assertJson(op.view);
        name(op.view.name, "View name");
        if (typeof op.view.type !== "string" || !op.view.type) fail("A view needs a type.", "base_config_view_invalid");
        if (op.view.filters !== undefined) assertFilter(op.view.filters);
        if (op.position !== undefined && (!Number.isInteger(op.position) || op.position < 0)) fail("A view position is a non-negative integer.", "base_config_view_invalid");
        break;
      case "delete_view": name(op.view, "View"); break;
      case "move_view":
        name(op.view, "View");
        if (!Number.isInteger(op.position) || op.position < 0) fail("A view position is a non-negative integer.", "base_config_view_invalid");
        break;
      case "set_view_key":
        name(op.view, "View"); name(op.key, "View key"); assertJson(op.value);
        if (op.key === "filters") assertFilter(op.value);
        if (op.key === "name") name(op.value, "View name");
        if (op.key === "type" && (typeof op.value !== "string" || !op.value)) fail("A view type is a non-empty string.", "base_config_view_invalid");
        break;
      case "delete_view_key":
        name(op.view, "View"); name(op.key, "View key");
        if (op.key === "name" || op.key === "type") fail("A view keeps its name and type.", "base_config_view_invalid");
        break;
      default: fail("Unsupported Base configuration operation.", "base_config_operation_unsupported");
    }
    if (Buffer.byteLength(JSON.stringify(op), "utf8") > MAX_VALUE_BYTES) fail("A Base operation is too large.", "base_config_value_invalid");
    return op;
  });
}

type Model = Record<string, unknown>;

function viewIndex(views: unknown[], view: string): number {
  const matches = views.flatMap((item, index) => item && typeof item === "object" && (item as Model).name === view ? [index] : []);
  if (matches.length === 0) fail("The view was not found.", "base_config_view_missing");
  if (matches.length > 1) fail("Several views share this name.", "base_config_view_ambiguous");
  return matches[0]!;
}

function mapAt(model: Model, key: string): Model {
  const value = model[key];
  if (value === undefined || value === null) { const created: Model = {}; model[key] = created; return created; }
  if (typeof value !== "object" || Array.isArray(value)) fail(`The Base ${key} section is not a mapping.`, "base_config_section_invalid");
  return value as Model;
}

/** Independent intent model on plain data; the YAML edit must produce exactly this. */
function applyModel(model: Model, op: BaseConfigPatchOperation, paths: Set<string>): void {
  const views = (): unknown[] => {
    if (model.views === undefined) model.views = [];
    if (!Array.isArray(model.views)) fail("The Base views section is not a list.", "base_config_section_invalid");
    return model.views as unknown[];
  };
  switch (op.op) {
    case "set_filters": model.filters = clone(op.filters); paths.add("filters"); return;
    case "delete_filters":
      if (model.filters === undefined) fail("The Base has no global filters.", "base_config_target_missing");
      delete model.filters; paths.add("filters"); return;
    case "set_formula": mapAt(model, "formulas")[op.name] = op.expression; paths.add(`formulas.${op.name}`); return;
    case "delete_formula": {
      const formulas = mapAt(model, "formulas");
      if (!(op.name in formulas)) fail("The formula was not found.", "base_config_target_missing");
      if (Object.keys(formulas).length === 1) delete model.formulas; else delete formulas[op.name];
      paths.add(`formulas.${op.name}`); return;
    }
    case "set_property": {
      const property = mapAt(mapAt(model, "properties"), op.property);
      property[op.key] = clone(op.value); paths.add(`properties.${op.property}.${op.key}`); return;
    }
    case "delete_property": {
      const properties = mapAt(model, "properties");
      if (!(op.property in properties)) fail("The property setting was not found.", "base_config_target_missing");
      if (op.key === undefined) delete properties[op.property];
      else {
        const property = mapAt(properties, op.property);
        if (!(op.key in property)) fail("The property setting was not found.", "base_config_target_missing");
        delete property[op.key];
        if (Object.keys(property).length === 0) delete properties[op.property];
      }
      if (Object.keys(properties).length === 0) delete model.properties;
      paths.add(`properties.${op.property}${op.key === undefined ? "" : "." + op.key}`); return;
    }
    case "set_summary": mapAt(model, "summaries")[op.name] = op.formula; paths.add(`summaries.${op.name}`); return;
    case "delete_summary": {
      const summaries = mapAt(model, "summaries");
      if (!(op.name in summaries)) fail("The summary was not found.", "base_config_target_missing");
      if (Object.keys(summaries).length === 1) delete model.summaries; else delete summaries[op.name];
      paths.add(`summaries.${op.name}`); return;
    }
    case "add_view": {
      const list = views();
      if (list.some((item) => item && typeof item === "object" && (item as Model).name === op.view.name)) fail("A view with this name already exists.", "base_config_view_exists");
      const position = op.position === undefined ? list.length : Math.min(op.position, list.length);
      list.splice(position, 0, clone(op.view)); paths.add(`views[${op.view.name}]`); return;
    }
    case "delete_view": {
      const list = views(); list.splice(viewIndex(list, op.view), 1);
      if (list.length === 0) fail("A Base keeps at least one view.", "base_config_last_view");
      paths.add(`views[${op.view}]`); return;
    }
    case "move_view": {
      const list = views(); const [item] = list.splice(viewIndex(list, op.view), 1);
      list.splice(Math.min(op.position, list.length), 0, item); paths.add(`views[${op.view}]`); return;
    }
    case "set_view_key": {
      const list = views(); const view = list[viewIndex(list, op.view)] as Model;
      if (op.key === "name" && op.value !== op.view && list.some((item) => (item as Model)?.name === op.value)) fail("A view with this name already exists.", "base_config_view_exists");
      view[op.key] = clone(op.value); paths.add(`views[${op.view}].${op.key}`); return;
    }
    case "delete_view_key": {
      const list = views(); const view = list[viewIndex(list, op.view)] as Model;
      if (!(op.key in view)) fail("The view key was not found.", "base_config_target_missing");
      delete view[op.key]; paths.add(`views[${op.view}].${op.key}`); return;
    }
  }
}

function yamlViewIndex(doc: Document, view: string): number {
  const seq = doc.get("views") as YAMLSeq | undefined;
  if (!isSeq(seq)) fail("The Base views section is not a list.", "base_config_section_invalid");
  const matches = seq.items.flatMap((item, index) => isMap(item) && (item as YAMLMap).get("name") === view ? [index] : []);
  if (matches.length !== 1) fail("The view was not found or is ambiguous.", "base_config_view_missing");
  return matches[0]!;
}

function pruneEmpty(doc: Document, key: string): void {
  const section = doc.get(key);
  if (isMap(section) && section.items.length === 0) doc.delete(key);
}

function applyYaml(doc: Document, op: BaseConfigPatchOperation): void {
  const node = (value: unknown) => doc.createNode(value);
  switch (op.op) {
    case "set_filters": doc.set("filters", node(op.filters)); return;
    case "delete_filters": doc.delete("filters"); return;
    case "set_formula": doc.setIn(["formulas", op.name], node(op.expression)); return;
    case "delete_formula": doc.deleteIn(["formulas", op.name]); pruneEmpty(doc, "formulas"); return;
    case "set_property": doc.setIn(["properties", op.property, op.key], node(op.value)); return;
    case "delete_property":
      if (op.key === undefined) doc.deleteIn(["properties", op.property]);
      else {
        doc.deleteIn(["properties", op.property, op.key]);
        const property = doc.getIn(["properties", op.property]);
        if (isMap(property) && property.items.length === 0) doc.deleteIn(["properties", op.property]);
      }
      pruneEmpty(doc, "properties"); return;
    case "set_summary": doc.setIn(["summaries", op.name], node(op.formula)); return;
    case "delete_summary": doc.deleteIn(["summaries", op.name]); pruneEmpty(doc, "summaries"); return;
    case "add_view": {
      let seq = doc.get("views") as YAMLSeq | undefined;
      if (!isSeq(seq)) { doc.set("views", node([])); seq = doc.get("views") as YAMLSeq; }
      const position = op.position === undefined ? seq.items.length : Math.min(op.position, seq.items.length);
      seq.items.splice(position, 0, node(op.view) as never); return;
    }
    case "delete_view": (doc.get("views") as YAMLSeq).items.splice(yamlViewIndex(doc, op.view), 1); return;
    case "move_view": {
      const seq = doc.get("views") as YAMLSeq;
      const [item] = seq.items.splice(yamlViewIndex(doc, op.view), 1);
      seq.items.splice(Math.min(op.position, seq.items.length), 0, item!); return;
    }
    case "set_view_key": doc.setIn(["views", yamlViewIndex(doc, op.view), op.key], node(op.value)); return;
    case "delete_view_key": doc.deleteIn(["views", yamlViewIndex(doc, op.view), op.key]); return;
  }
}

function parseSupported(source: string): Document {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) fail("The Base YAML cannot be parsed.", "base_config_yaml_invalid");
  visit(doc, {
    Alias() { fail("YAML anchors and aliases are not supported in a governed Base edit.", "base_config_yaml_unsupported"); },
    Node(_key, item) {
      if ((item as { anchor?: string }).anchor || ((item as { tag?: string }).tag && !(item as { tag?: string }).tag!.startsWith("tag:yaml.org,2002:"))) {
        fail("YAML anchors and custom tags are not supported in a governed Base edit.", "base_config_yaml_unsupported");
      }
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") fail("YAML merge keys are not supported in a governed Base edit.", "base_config_yaml_unsupported");
    },
  });
  if (!isMap(doc.contents)) fail("A Base file is a YAML mapping.", "base_config_section_invalid");
  return doc;
}

export function compileBaseConfigPatch(source: string, inputOperations: BaseConfigPatchOperation[]): CompiledBaseConfigPatch {
  const operations = canonicalizeBaseConfigPatchOperations(inputOperations);
  if (Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) fail("The Base file is too large.", "base_config_source_too_large");
  const crlf = source.includes("\r\n");
  if (crlf && /(^|[^\r])\n/u.test(source)) fail("Mixed line endings are not supported.", "base_config_yaml_unsupported");
  const lf = crlf ? source.replace(/\r\n/gu, "\n") : source;
  const options = { lineWidth: 0, minContentWidth: 0 } as const;
  const doc = parseSupported(lf);
  const formattingPreserved = parseSupported(lf).toString(options) === lf;
  const model = load(lf) as Model;
  if (!model || typeof model !== "object" || Array.isArray(model)) fail("A Base file is a YAML mapping.", "base_config_section_invalid");
  const paths = new Set<string>();
  for (const op of operations) {
    applyModel(model, op, paths);
    applyYaml(doc, op);
  }
  let next = doc.toString(options);
  if (crlf) next = next.replace(/\n/gu, "\r\n");
  const after = load(next);
  if (operationDigest(after) !== operationDigest(model)) {
    fail("The Base compiler changed data outside the sealed intent.", "base_config_projection_mismatch");
  }
  const validation = validateObsidianBase(next);
  if (!validation.ok) fail("The resulting Base is not valid.", "base_config_result_invalid");
  return {
    nextYaml: next,
    proof: {
      contractVersion: 1,
      compilerVersion: 1,
      sourcePreservation: "semantic-identical-outside-authorized-paths",
      formattingPreserved,
      lineEnding: crlf ? "crlf" : "lf",
      patchDigest: operationDigest({ contractVersion: 1, operations, beforeSha256: sha256(source), afterSha256: sha256(next) }),
      changedPaths: [...paths].sort().slice(0, MAX_OPERATIONS),
      beforeSha256: sha256(source),
      afterSha256: sha256(next),
      warnings: validation.warnings.map((warning) => warning.code).slice(0, 32),
    },
  };
}
