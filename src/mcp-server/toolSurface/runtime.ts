import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TOOL_CATALOG,
  TOOL_BUNDLES,
  TOOL_SURFACE_PROFILE_VERSION,
  compileToolSurface,
  parseToolSurfaceProfile,
  profileIncludesEntry,
  toolSurfaceFingerprint,
  validateToolBundles,
  type ToolSurfaceProfile,
} from "./catalog.js";

const REMOVED_V3_TOOL_NAMES = new Set(["smart_search", "smart-search"]);
const profileStorage = new AsyncLocalStorage<ToolSurfaceProfile>();
const serverStates = new WeakMap<object, MutableToolSurfaceState>();
const INSTALL_MARKER = Symbol.for("optimike.tool-surface-v3.installed");

let defaultProfile: ToolSurfaceProfile = "standard";

interface MutableToolSurfaceState {
  readonly profile: ToolSurfaceProfile;
  readonly attempted: Set<string>;
  readonly exposed: Set<string>;
  readonly excluded: Set<string>;
  finalized: boolean;
}

export interface ToolSurfaceState {
  readonly profile: ToolSurfaceProfile;
  readonly profileVersion: typeof TOOL_SURFACE_PROFILE_VERSION;
  readonly attempted: readonly string[];
  readonly exposed: readonly string[];
  readonly excluded: readonly string[];
  readonly fingerprint: string;
}

export function configureDefaultToolSurfaceProfile(
  profile: ToolSurfaceProfile,
): void {
  defaultProfile = profile;
}

export function configuredDefaultToolSurfaceProfile(): ToolSurfaceProfile {
  return defaultProfile;
}

export function currentToolSurfaceProfile(): ToolSurfaceProfile {
  return profileStorage.getStore() ?? defaultProfile;
}

export function withToolSurfaceProfile<T>(
  profile: ToolSurfaceProfile,
  operation: () => T,
): T {
  return profileStorage.run(profile, operation);
}

function mutableState(server: object): MutableToolSurfaceState {
  let state = serverStates.get(server);
  if (!state) {
    state = {
      profile: currentToolSurfaceProfile(),
      attempted: new Set(),
      exposed: new Set(),
      excluded: new Set(),
      finalized: false,
    };
    serverStates.set(server, state);
  }
  return state;
}

export function getToolSurfaceState(server: object): ToolSurfaceState {
  const state = mutableState(server);
  return {
    profile: state.profile,
    profileVersion: TOOL_SURFACE_PROFILE_VERSION,
    attempted: [...state.attempted].sort(),
    exposed: [...state.exposed].sort(),
    excluded: [...state.excluded].sort(),
    fingerprint: toolSurfaceFingerprint(state.profile, state.exposed),
  };
}

function completeBundleAttempted(
  state: MutableToolSurfaceState,
  bundleId: string,
): boolean {
  const bundle = TOOL_BUNDLES.get(bundleId);
  return Boolean(bundle && [...bundle].every((name) => state.attempted.has(name)));
}

function shouldExpose(
  state: MutableToolSurfaceState,
  name: string,
): boolean {
  const entry = TOOL_CATALOG.get(name);
  if (!entry) return false;
  if (
    state.profile !== "full" &&
    (entry.group === "external.read" || entry.group === "external.move") &&
    !process.env.MCP_EXTERNAL_ROOTS_FILE?.trim()
  ) {
    return false;
  }
  if (state.profile === "full" || profileIncludesEntry(state.profile, entry)) {
    return true;
  }
  if (!entry.fallbackForBundle) return false;
  if (
    name === "obsidian_manage_frontmatter" &&
    (state.profile === "standard" || state.profile === "authoring")
  ) {
    return !completeBundleAttempted(state, entry.fallbackForBundle);
  }
  if (name === "obsidian_manage_canvas" && state.profile === "authoring") {
    return !completeBundleAttempted(state, entry.fallbackForBundle);
  }
  return false;
}

function safetyAnnotations(
  args: readonly unknown[],
): Record<string, unknown> | undefined {
  for (const value of args) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const direct = candidate;
    const nested =
      candidate.annotations &&
      typeof candidate.annotations === "object" &&
      !Array.isArray(candidate.annotations)
        ? (candidate.annotations as Record<string, unknown>)
        : undefined;
    for (const annotations of [direct, nested]) {
      if (
        annotations &&
        typeof annotations.readOnlyHint === "boolean" &&
        typeof annotations.destructiveHint === "boolean" &&
        typeof annotations.idempotentHint === "boolean" &&
        typeof annotations.openWorldHint === "boolean"
      ) {
        return annotations;
      }
    }
  }
  return undefined;
}

function lastFunctionIndex(values: readonly unknown[]): number {
  for (let index = values.length - 1; index > 0; index -= 1) {
    if (typeof values[index] === "function") return index;
  }
  return -1;
}

function hiddenToolHandle(): Record<string, unknown> {
  const noop = () => undefined;
  return {
    enabled: false,
    enable: noop,
    disable: noop,
    update: noop,
    remove: noop,
  };
}

function addSurfaceToRuntimeStatus(
  result: unknown,
  server: object,
): unknown {
  if (!result || typeof result !== "object") return result;
  const response = result as {
    content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  if (!Array.isArray(response.content)) return result;
  const state = getToolSurfaceState(server);
  const content = response.content.map((item) => {
    if (item.type !== "text" || typeof item.text !== "string") return item;
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      return {
        ...item,
        text: JSON.stringify(
          {
            ...parsed,
            toolSurface: {
              profile: state.profile,
              profileVersion: state.profileVersion,
              toolCount: state.exposed.length,
              fingerprint: state.fingerprint,
              legacyAliasesExposed: false,
            },
          },
          null,
          2,
        ),
      };
    } catch {
      return item;
    }
  });
  return { ...response, content };
}

function renderRoutingResource(server: object): string {
  const state = getToolSurfaceState(server);
  const names = new Set(state.exposed);
  const lines = [
    "# Optimike MCP tool routing",
    "",
    `Active tool profile: \`${state.profile}\` (contract ${state.profileVersion}).`,
    `Exposed tools: ${state.exposed.length}.`,
    `Surface fingerprint: \`${state.fingerprint}\`.`,
    "",
    "Use the narrowest exposed tool that owns the required guarantee. An absent",
    "tool is outside this session's contract and must not be emulated silently.",
    "",
    "## Canonical priorities",
    "",
  ];
  if (names.has("smart_semantic_search")) {
    lines.push(
      "- Semantic similarity: use `smart_semantic_search`. Optimike MCP 3.0 no longer exposes `smart_search` or `smart-search`.",
    );
  }
  if (names.has("operon_list_tasks")) {
    lines.push(
      "- Operon-managed tasks: use `operon_list_tasks` or `operon_query_tasks`; use the Tasks-compatible tools only for Markdown task inspection.",
    );
  }
  if (names.has("obsidian_note_replace_plan")) {
    lines.push(
      "- Complete note replacement: use `obsidian_note_replace_plan`, then its matching apply/status/recover lifecycle.",
    );
  }
  if (names.has("obsidian_frontmatter_patch_plan")) {
    lines.push(
      "- Top-level Frontmatter set/delete: use `obsidian_frontmatter_patch_plan` and its matching lifecycle.",
    );
  }
  if (names.has("bases_formula_patch_plan")) {
    lines.push(
      "- Named Base formula set/delete: use `bases_formula_patch_plan` and its matching lifecycle.",
    );
  }
  if (names.has("obsidian_canvas_patch_plan")) {
    lines.push(
      "- Existing Canvas graph mutation: use `obsidian_canvas_patch_plan` and its matching lifecycle.",
    );
  }
  lines.push(
    "",
    "## Governed sequence",
    "",
    "1. Plan once with a caller-owned idempotency key.",
    "2. Retain the opaque plan reference.",
    "3. Apply only that sealed plan.",
    "4. After timeout or transport loss, call status first.",
    "5. Recover only when the durable receipt authorizes that exact plan.",
    "",
  );
  return lines.join("\n");
}

function finalize(server: object): void {
  const state = mutableState(server);
  if (state.finalized) return;
  validateToolBundles(state.exposed);
  const compiled = compileToolSurface(state.profile, state.attempted, {
    externalRootsConfigured: Boolean(process.env.MCP_EXTERNAL_ROOTS_FILE?.trim()),
  });
  const missing = [...compiled].filter((name) => !state.exposed.has(name));
  const extra = [...state.exposed].filter((name) => !compiled.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Compiled MCP tool surface diverged before connect; missing=${missing.sort().join(",")}; extra=${extra.sort().join(",")}.`,
    );
  }
  state.finalized = true;
}

export function installToolSurfaceRuntime(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  if (globalRecord[INSTALL_MARKER]) return;
  globalRecord[INSTALL_MARKER] = true;

  const prototype = McpServer.prototype as unknown as Record<string, unknown>;
  const originalTool = prototype.tool as (...args: unknown[]) => unknown;
  const originalRegisterTool = prototype.registerTool as (...args: unknown[]) => unknown;
  const originalConnect = prototype.connect as (...args: unknown[]) => unknown;
  const originalRegisterResource = prototype.registerResource as (
    ...args: unknown[]
  ) => unknown;

  if (
    typeof originalTool !== "function" ||
    typeof originalRegisterTool !== "function" ||
    typeof originalConnect !== "function" ||
    typeof originalRegisterResource !== "function"
  ) {
    throw new Error("Unsupported MCP SDK: required McpServer methods are absent.");
  }

  const registerVisibleTool = (
    server: object,
    args: unknown[],
    original: (...registrationArgs: unknown[]) => unknown,
  ): unknown => {
    const name = args[0];
    if (typeof name !== "string") {
      throw new Error("MCP tool registration requires a string name.");
    }
    const state = mutableState(server);

    if (REMOVED_V3_TOOL_NAMES.has(name)) {
      state.excluded.add(name);
      return hiddenToolHandle();
    }
    state.attempted.add(name);
    if (!TOOL_CATALOG.has(name)) {
      throw new Error(`MCP tool ${name} is absent from the V3 catalogue.`);
    }
    if (!safetyAnnotations(args)) {
      throw new Error(`MCP tool ${name} lacks complete safety annotations.`);
    }
    if (!shouldExpose(state, name)) {
      state.excluded.add(name);
      return hiddenToolHandle();
    }

    const nextArgs = [...args];
    const handlerIndex = lastFunctionIndex(nextArgs);
    if (name === "obsidian_runtime_status" && handlerIndex >= 0) {
      const handler = nextArgs[handlerIndex] as (...handlerArgs: unknown[]) => unknown;
      nextArgs[handlerIndex] = async (...handlerArgs: unknown[]) =>
        addSurfaceToRuntimeStatus(await handler(...handlerArgs), server);
    }

    const result = original.apply(server, nextArgs);
    state.exposed.add(name);
    return result;
  };

  prototype.tool = function patchedTool(this: object, ...args: unknown[]) {
    return registerVisibleTool(this, args, originalTool);
  };

  prototype.registerTool = function patchedRegisterTool(
    this: object,
    ...args: unknown[]
  ) {
    return registerVisibleTool(this, args, originalRegisterTool);
  };

  prototype.connect = async function patchedConnect(
    this: object,
    ...args: unknown[]
  ) {
    finalize(this);
    return await originalConnect.apply(this, args);
  };

  prototype.registerResource = function patchedRegisterResource(
    this: object,
    ...args: unknown[]
  ) {
    if (args[0] === "optimike-tool-routing") {
      const callbackIndex = lastFunctionIndex(args);
      if (callbackIndex >= 0) {
        const originalCallback = args[callbackIndex] as (
          ...callbackArgs: unknown[]
        ) => unknown;
        args[callbackIndex] = async (...callbackArgs: unknown[]) => {
          const originalResult = await originalCallback(...callbackArgs);
          if (!originalResult || typeof originalResult !== "object") {
            return originalResult;
          }
          const result = originalResult as {
            contents?: Array<Record<string, unknown>>;
            [key: string]: unknown;
          };
          if (!Array.isArray(result.contents)) return originalResult;
          return {
            ...result,
            contents: result.contents.map((content) => ({
              ...content,
              text: renderRoutingResource(this),
            })),
          };
        };
      }
    }
    return originalRegisterResource.apply(this, args);
  };
}

export function resolveProfileFromCli(
  argv: readonly string[],
  envValue: string | undefined,
  fallback: ToolSurfaceProfile = "standard",
): { profile: ToolSurfaceProfile; argv: string[] } {
  const remaining: string[] = [];
  let cliValue: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tool-profile") {
      if (cliValue !== undefined) {
        throw new Error("--tool-profile was provided more than once.");
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--tool-profile requires a value.");
      }
      cliValue = next;
      index += 1;
      continue;
    }
    if (argument.startsWith("--tool-profile=")) {
      if (cliValue !== undefined) {
        throw new Error("--tool-profile was provided more than once.");
      }
      cliValue = argument.slice("--tool-profile=".length);
      if (!cliValue) throw new Error("--tool-profile requires a value.");
      continue;
    }
    remaining.push(argument);
  }
  return {
    profile: parseToolSurfaceProfile(cliValue ?? envValue, fallback),
    argv: remaining,
  };
}
