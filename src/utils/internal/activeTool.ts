/**
 * @fileoverview Async-local attribution of backend events to the MCP tool being
 * served. The logger reads it so events raised deep in a call (REST requests,
 * cache reads) carry the tool name without every call site threading it through
 * its context. Only names registered through the tool boundary are stored.
 * @module src/utils/internal/activeTool
 */
import { AsyncLocalStorage } from "node:async_hooks";

const activeTool = new AsyncLocalStorage<string>();

export function withActiveToolName<T>(name: string, operation: () => T): T {
  return activeTool.run(name, operation);
}

export function activeToolName(): string | undefined {
  return activeTool.getStore();
}
