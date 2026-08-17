import { createHash } from "node:crypto";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { operationDigest } from "./operations/contract.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";

type CanvasObject = Record<string, unknown>;

export type CanvasPatchOperation =
  | {
      op: "add_text_node";
      id: string;
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
    }
  | { op: "set_text"; id: string; text: string }
  | {
      op: "move_node";
      id: string;
      x: number;
      y: number;
      width?: number;
      height?: number;
    }
  | { op: "delete_node"; id: string }
  | {
      op: "connect_nodes";
      id: string;
      fromNode: string;
      toNode: string;
      fromSide?: "top" | "right" | "bottom" | "left";
      toSide?: "top" | "right" | "bottom" | "left";
      label?: string;
      color?: string;
    }
  | { op: "delete_edge"; id: string };

export type CanvasPatchProof = {
  contractVersion: 1;
  compilerVersion: 1;
  sourcePreservation: "unknown-json-values-preserved-outside-authorized-canvas-entities";
  lineEnding: "lf" | "crlf";
  patchDigest: string;
  changedNodes: string[];
  changedEdges: string[];
  removedIncidentEdges: string[];
  rootUnknownBeforeSha256: string;
  rootUnknownAfterSha256: string;
  untouchedEntitiesBeforeSha256: string;
  untouchedEntitiesAfterSha256: string;
  graphBefore: { nodes: number; edges: number };
  graphAfter: { nodes: number; edges: number };
};

export type CompiledCanvasPatch = {
  nextContent: string;
  proof: CanvasPatchProof;
};

function fail(message: string, reason: string): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, { reason });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown, label: string): CanvasObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`, "canvas_object_required");
  }
  return value as CanvasObject;
}

function entityArray(
  root: CanvasObject,
  key: "nodes" | "edges",
): CanvasObject[] {
  const value = root[key];
  if (!Array.isArray(value)) {
    fail(`Canvas ${key} must be an array.`, `canvas_${key}_required`);
  }
  value.forEach((item, index) => record(item, `${key}[${index}]`));
  return value as CanvasObject[];
}

function entityId(entity: CanvasObject, label: string): string {
  if (
    typeof entity.id !== "string" ||
    entity.id.length === 0 ||
    entity.id.length > 256
  ) {
    fail(
      `${label} must have a non-empty string id of at most 256 characters.`,
      "canvas_entity_id",
    );
  }
  return entity.id;
}

function indexById(items: CanvasObject[], id: string): number {
  return items.findIndex((item) => item.id === id);
}

function parseStrict(source: string): CanvasObject {
  try {
    JSON.parse(source);
  } catch (error) {
    fail(
      `Canvas must be strict JSON: ${error instanceof Error ? error.message : String(error)}`,
      "canvas_json_invalid",
    );
  }
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: false });
  if (errors.length > 0)
    fail("Canvas JSON could not be parsed.", "canvas_json_invalid");
  return record(value, "Canvas");
}

function replaceAt(
  source: string,
  path: (string | number)[],
  value: unknown,
): string {
  return applyEdits(
    source,
    modify(source, path, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: source.includes("\r\n") ? "\r\n" : "\n",
        keepLines: true,
      },
    }),
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rootUnknown(root: CanvasObject): CanvasObject {
  return Object.fromEntries(
    Object.entries(root).filter(([key]) => key !== "nodes" && key !== "edges"),
  );
}

function untouchedEntities(
  root: CanvasObject,
  changedNodes: Set<string>,
  changedEdges: Set<string>,
): { nodes: CanvasObject[]; edges: CanvasObject[] } {
  return {
    nodes: entityArray(root, "nodes").filter(
      (node) => !changedNodes.has(entityId(node, "Canvas node")),
    ),
    edges: entityArray(root, "edges").filter(
      (edge) => !changedEdges.has(entityId(edge, "Canvas edge")),
    ),
  };
}

function graphError(root: CanvasObject): string | undefined {
  const nodes = entityArray(root, "nodes");
  const edges = entityArray(root, "edges");
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const id = entityId(node, "Canvas node");
    if (nodeIds.has(id)) return `Duplicate Canvas node ID: ${id}`;
    nodeIds.add(id);
    if (
      typeof node.type !== "string" ||
      !["text", "file", "link", "group"].includes(node.type)
    ) {
      return `Canvas node ${id} has an unsupported type.`;
    }
    for (const field of ["x", "y", "width", "height"] as const) {
      if (typeof node[field] !== "number" || !Number.isFinite(node[field])) {
        return `Canvas node ${id} has invalid ${field}.`;
      }
    }
    if ((node.width as number) <= 0 || (node.height as number) <= 0) {
      return `Canvas node ${id} must have positive width and height.`;
    }
    if (node.type === "text" && typeof node.text !== "string") {
      return `Canvas text node ${id} must contain text.`;
    }
    if (node.type === "file" && typeof node.file !== "string") {
      return `Canvas file node ${id} must contain a file path.`;
    }
    if (node.type === "link" && typeof node.url !== "string") {
      return `Canvas link node ${id} must contain a URL.`;
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    const id = entityId(edge, "Canvas edge");
    if (edgeIds.has(id)) return `Duplicate Canvas edge ID: ${id}`;
    edgeIds.add(id);
    if (
      typeof edge.fromNode !== "string" ||
      typeof edge.toNode !== "string" ||
      !nodeIds.has(edge.fromNode) ||
      !nodeIds.has(edge.toNode)
    ) {
      return `Canvas edge ${id} references a missing node.`;
    }
    for (const side of ["fromSide", "toSide"] as const) {
      if (
        edge[side] !== undefined &&
        !["top", "right", "bottom", "left"].includes(String(edge[side]))
      ) {
        return `Canvas edge ${id} has an invalid ${side}.`;
      }
    }
  }
  return undefined;
}

export function canonicalizeCanvasPatchOperations(
  operations: CanvasPatchOperation[],
): CanvasPatchOperation[] {
  if (operations.length < 1 || operations.length > 64) {
    fail(
      "Canvas patches require between 1 and 64 operations.",
      "canvas_patch_size",
    );
  }
  const nodeTargets = new Set<string>();
  const edgeTargets = new Set<string>();
  return operations.map((operation) => {
    if (
      !operation.id ||
      operation.id.trim() !== operation.id ||
      operation.id.length > 256
    ) {
      fail(
        "Canvas operation IDs must be non-empty, unpadded, and at most 256 characters.",
        "canvas_operation_id",
      );
    }
    if (operation.op === "add_text_node" || operation.op === "move_node") {
      const numeric = [
        operation.x,
        operation.y,
        operation.width,
        operation.height,
      ].filter((value): value is number => value !== undefined);
      if (numeric.some((value) => !Number.isFinite(value))) {
        fail(
          "Canvas geometry must contain finite numbers.",
          "canvas_geometry_invalid",
        );
      }
      if (
        (operation.width !== undefined && operation.width <= 0) ||
        (operation.height !== undefined && operation.height <= 0)
      ) {
        fail(
          "Canvas width and height must be positive.",
          "canvas_geometry_invalid",
        );
      }
    }
    const targetSet =
      operation.op === "connect_nodes" || operation.op === "delete_edge"
        ? edgeTargets
        : nodeTargets;
    if (targetSet.has(operation.id)) {
      fail(
        `Canvas entity ${operation.id} is targeted more than once.`,
        "canvas_patch_duplicate_target",
      );
    }
    targetSet.add(operation.id);
    return clone(operation);
  });
}

export function compileCanvasPatch(
  source: string,
  inputOperations: CanvasPatchOperation[],
): CompiledCanvasPatch {
  const operations = canonicalizeCanvasPatchOperations(inputOperations);
  const before = parseStrict(source);
  if (graphError(before)) {
    fail("The current Canvas graph is invalid.", "canvas_graph_invalid_before");
  }

  const expected = clone(before);
  const changedNodes = new Set<string>();
  const changedEdges = new Set<string>();
  const removedIncidentEdges = new Set<string>();
  let next = source;

  for (const operation of operations) {
    const expectedNodes = entityArray(expected, "nodes");
    const expectedEdges = entityArray(expected, "edges");
    const current = parseStrict(next);
    const currentNodes = entityArray(current, "nodes");
    const currentEdges = entityArray(current, "edges");

    if (operation.op === "add_text_node") {
      if (indexById(expectedNodes, operation.id) !== -1) {
        fail(
          `Canvas node ${operation.id} already exists.`,
          "canvas_node_exists",
        );
      }
      const node: CanvasObject = {
        id: operation.id,
        type: "text",
        x: operation.x,
        y: operation.y,
        width: operation.width,
        height: operation.height,
        text: operation.text,
        ...(operation.color === undefined ? {} : { color: operation.color }),
      };
      expectedNodes.push(node);
      next = replaceAt(next, ["nodes", currentNodes.length], node);
      changedNodes.add(operation.id);
      continue;
    }

    if (operation.op === "set_text") {
      const index = indexById(expectedNodes, operation.id);
      if (index === -1)
        fail(
          `Canvas node ${operation.id} was not found.`,
          "canvas_node_missing",
        );
      if (expectedNodes[index]?.type !== "text") {
        fail(
          `Canvas node ${operation.id} is not a text node.`,
          "canvas_node_not_text",
        );
      }
      expectedNodes[index]!.text = operation.text;
      const currentIndex = indexById(currentNodes, operation.id);
      next = replaceAt(next, ["nodes", currentIndex, "text"], operation.text);
      changedNodes.add(operation.id);
      continue;
    }

    if (operation.op === "move_node") {
      const index = indexById(expectedNodes, operation.id);
      if (index === -1)
        fail(
          `Canvas node ${operation.id} was not found.`,
          "canvas_node_missing",
        );
      const currentIndex = indexById(currentNodes, operation.id);
      const updates: Array<[string, number | undefined]> = [
        ["x", operation.x],
        ["y", operation.y],
        ["width", operation.width],
        ["height", operation.height],
      ];
      for (const [key, value] of updates) {
        if (value === undefined) continue;
        expectedNodes[index]![key] = value;
        next = replaceAt(next, ["nodes", currentIndex, key], value);
      }
      changedNodes.add(operation.id);
      continue;
    }

    if (operation.op === "delete_node") {
      const index = indexById(expectedNodes, operation.id);
      if (index === -1)
        fail(
          `Canvas node ${operation.id} was not found.`,
          "canvas_node_missing",
        );
      expectedNodes.splice(index, 1);
      const incidentIds = expectedEdges
        .filter(
          (edge) =>
            edge.fromNode === operation.id || edge.toNode === operation.id,
        )
        .map((edge) => entityId(edge, "Canvas edge"));
      expected.edges = expectedEdges.filter(
        (edge) =>
          edge.fromNode !== operation.id && edge.toNode !== operation.id,
      );
      for (const edgeId of incidentIds) {
        const fresh = parseStrict(next);
        const freshEdges = entityArray(fresh, "edges");
        next = replaceAt(
          next,
          ["edges", indexById(freshEdges, edgeId)],
          undefined,
        );
        changedEdges.add(edgeId);
        removedIncidentEdges.add(edgeId);
      }
      const fresh = parseStrict(next);
      next = replaceAt(
        next,
        ["nodes", indexById(entityArray(fresh, "nodes"), operation.id)],
        undefined,
      );
      changedNodes.add(operation.id);
      continue;
    }

    if (operation.op === "connect_nodes") {
      if (indexById(expectedEdges, operation.id) !== -1) {
        fail(
          `Canvas edge ${operation.id} already exists.`,
          "canvas_edge_exists",
        );
      }
      if (
        indexById(expectedNodes, operation.fromNode) === -1 ||
        indexById(expectedNodes, operation.toNode) === -1
      ) {
        fail(
          "Canvas edge endpoints must exist in the final graph.",
          "canvas_edge_node_missing",
        );
      }
      const edge: CanvasObject = {
        id: operation.id,
        fromNode: operation.fromNode,
        toNode: operation.toNode,
        ...(operation.fromSide === undefined
          ? {}
          : { fromSide: operation.fromSide }),
        ...(operation.toSide === undefined ? {} : { toSide: operation.toSide }),
        ...(operation.label === undefined ? {} : { label: operation.label }),
        ...(operation.color === undefined ? {} : { color: operation.color }),
      };
      expectedEdges.push(edge);
      next = replaceAt(next, ["edges", currentEdges.length], edge);
      changedEdges.add(operation.id);
      continue;
    }

    const index = indexById(expectedEdges, operation.id);
    if (index === -1)
      fail(`Canvas edge ${operation.id} was not found.`, "canvas_edge_missing");
    expectedEdges.splice(index, 1);
    next = replaceAt(
      next,
      ["edges", indexById(currentEdges, operation.id)],
      undefined,
    );
    changedEdges.add(operation.id);
  }

  const after = parseStrict(next);
  if (operationDigest(after) !== operationDigest(expected)) {
    fail(
      "The Canvas compiler changed data outside the sealed intent.",
      "canvas_projection_mismatch",
    );
  }
  if (graphError(after)) {
    fail(
      "The projected Canvas graph is invalid.",
      "canvas_graph_invalid_after",
    );
  }

  const beforeRootDigest = operationDigest(rootUnknown(before));
  const afterRootDigest = operationDigest(rootUnknown(after));
  if (beforeRootDigest !== afterRootDigest) {
    fail(
      "Unknown Canvas root fields changed.",
      "canvas_root_projection_mismatch",
    );
  }
  const untouchedBefore = operationDigest(
    untouchedEntities(before, changedNodes, changedEdges),
  );
  const untouchedAfter = operationDigest(
    untouchedEntities(after, changedNodes, changedEdges),
  );
  if (untouchedBefore !== untouchedAfter) {
    fail(
      "Untargeted Canvas entities changed.",
      "canvas_entity_projection_mismatch",
    );
  }

  const beforeNodes = entityArray(before, "nodes");
  const beforeEdges = entityArray(before, "edges");
  const afterNodes = entityArray(after, "nodes");
  const afterEdges = entityArray(after, "edges");
  const proof: CanvasPatchProof = {
    contractVersion: 1,
    compilerVersion: 1,
    sourcePreservation:
      "unknown-json-values-preserved-outside-authorized-canvas-entities",
    lineEnding: source.includes("\r\n") ? "crlf" : "lf",
    patchDigest: operationDigest({
      contractVersion: 1,
      operations,
      beforeSha256: sha256(source),
      afterSha256: sha256(next),
    }),
    changedNodes: [...changedNodes].sort(),
    changedEdges: [...changedEdges].sort(),
    removedIncidentEdges: [...removedIncidentEdges].sort(),
    rootUnknownBeforeSha256: beforeRootDigest,
    rootUnknownAfterSha256: afterRootDigest,
    untouchedEntitiesBeforeSha256: untouchedBefore,
    untouchedEntitiesAfterSha256: untouchedAfter,
    graphBefore: { nodes: beforeNodes.length, edges: beforeEdges.length },
    graphAfter: { nodes: afterNodes.length, edges: afterEdges.length },
  };
  return { nextContent: next, proof };
}
