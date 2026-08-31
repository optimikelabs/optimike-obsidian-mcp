import { config } from "../config/index.js";
import { getQueryEmbedder } from "../adapters/embed/index.js";
import {
  compileToolProfileNames,
  type ToolProfileId,
} from "../mcp-server/toolProfiles.js";
import { getToolSurfaceEntry } from "../mcp-server/toolSurfaceRegistry.js";
import type { ToolRegistrationMode } from "../mcp-server/toolSurfaceRegistry.js";
import { httpAdmissionController } from "../mcp-server/transports/httpBackpressure.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { requestContextService } from "../utils/index.js";
import type { ObsidianRestApiService } from "./obsidianRestAPI/service.js";
import type {
  AtomicWriteStatusResponse,
  BaseAtomicStatusResponse,
} from "./obsidianRestAPI/types.js";
import { OperonService } from "./operon/service.js";
import { getSemanticCacheService } from "./semanticCache.js";

export const CAPABILITY_MANIFEST_CONTRACT_VERSION = 1 as const;
export const CAPABILITY_PROBE_TIMEOUT_MS = 2_500;

export type CapabilityId =
  | "local-rest"
  | "vault-read"
  | "semantic-search"
  | "governed-note-write"
  | "governed-frontmatter-write"
  | "governed-canvas-write"
  | "governed-base-write"
  | "operon-read"
  | "operon-write";

export type CapabilityState =
  | "ready"
  | "degraded"
  | "blocked"
  | "unavailable"
  | "hidden";

export type CapabilityReasonCode =
  | "ready"
  | "profile_hidden"
  | "runtime_mode_unavailable"
  | "runtime_not_initialized"
  | "local_rest_not_configured"
  | "local_rest_unreachable"
  | "local_rest_unauthorized"
  | "cache_fallback"
  | "vault_backend_unavailable"
  | "semantic_search_disabled"
  | "semantic_query_embedding_disabled"
  | "semantic_index_unavailable"
  | "semantic_embedder_unavailable"
  | "bridge_unavailable"
  | "bridge_lifecycle_not_ready"
  | "bridge_contract_incompatible"
  | "bridge_write_disabled"
  | "operon_not_present"
  | "operon_incompatible"
  | "operon_index_not_ready"
  | "operon_duplicate_conflicts"
  | "operon_read_capability_missing"
  | "operon_write_capability_missing"
  | "operon_mutations_disabled"
  | "mcp_operon_mutations_disabled"
  | "write_policy_blocked"
  | "operation_policy_blocked"
  | "operon_capability_not_advertised"
  | "operon_partial_capabilities"
  | "operon_snapshot_fallback"
  | "operon_live_required";

export type CapabilityNextAction =
  | "none"
  | "switch_tool_profile"
  | "use_live_runtime"
  | "restart_mcp_runtime"
  | "configure_local_rest"
  | "start_obsidian_and_retry"
  | "verify_local_rest_credentials"
  | "refresh_vault_cache"
  | "enable_semantic_search"
  | "enable_query_embedding"
  | "refresh_semantic_index"
  | "configure_query_embedder"
  | "install_or_enable_bridge"
  | "wait_for_bridge"
  | "update_bridge_contract"
  | "enable_bridge_writes"
  | "load_or_update_operon"
  | "wait_for_operon_index"
  | "resolve_operon_duplicates"
  | "enable_operon_mutations"
  | "enable_mcp_operon_mutations"
  | "enable_write_policy"
  | "review_operation_policy"
  | "negotiate_exact_operon_capability";

export interface CapabilityManifestEntry {
  id: CapabilityId;
  discoverable: boolean;
  available: boolean;
  authorized: boolean;
  state: CapabilityState;
  reasonCode: CapabilityReasonCode;
  nextAction: CapabilityNextAction;
  preferredTools: readonly string[];
  operations?: readonly CapabilityOperationEntry[];
}

export interface CapabilityOperationEntry {
  id: string;
  tool: string;
  discoverable: boolean;
  available: boolean;
  authorized: boolean;
  reasonCode: CapabilityReasonCode;
  nextAction: CapabilityNextAction;
}

export interface CapabilityManifest {
  contractVersion: typeof CAPABILITY_MANIFEST_CONTRACT_VERSION;
  profile: ToolProfileId;
  registrationMode: ToolRegistrationMode;
  probeTimeoutMs: number;
  summary: {
    ready: number;
    degraded: number;
    blocked: number;
    unavailable: number;
    hidden: number;
  };
  admission: {
    transport: "stdio" | "http";
    state: "not-applicable" | "ready" | "pressured";
    inFlight: number;
    queued: number;
    rejectedQueueFull: number;
    rejectedIdentityQueueFull: number;
    timedOut: number;
    cancelled: number;
  };
  capabilities: readonly CapabilityManifestEntry[];
}

type NormalizedProbe<T> =
  | { state: "ready"; value: T }
  | { state: "unauthorized" }
  | { state: "unavailable" }
  | { state: "incompatible" };

export interface CapabilityManifestProjectionInput {
  profile: ToolProfileId;
  registrationMode: ToolRegistrationMode;
  profileToolNames: readonly string[];
  modeToolNames: readonly string[];
  visibleToolNames: readonly string[];
  transport: "stdio" | "http";
  cacheReady: boolean;
  semanticEnabled: boolean;
  queryEmbeddingEnabled: boolean;
  semanticIndex: NormalizedProbe<{
    vectorCount: number;
    embedderReady: boolean;
  }>;
  operonMutationsEnabled: boolean;
  writeMode: "readonly" | "guarded" | "full";
  operonAllowedPathPrefixesConfigured: boolean;
  localRest: NormalizedProbe<{ authenticated: boolean }>;
  atomicWrite: NormalizedProbe<AtomicWriteStatusResponse>;
  baseAtomicWrite: NormalizedProbe<BaseAtomicStatusResponse>;
  operon: NormalizedProbe<Record<string, unknown>>;
  admission: {
    inFlight: number;
    queued: number;
    rejectedQueueFull: number;
    rejectedIdentityQueueFull: number;
    timedOut: number;
    cancelled: number;
  };
}

export interface CapabilityProbeDependencies {
  localRest?: () => Promise<{ authenticated: boolean }>;
  semanticIndex?: () => Promise<{
    vectorCount: number;
    embedderReady: boolean;
  }>;
  atomicWrite?: () => Promise<AtomicWriteStatusResponse>;
  baseAtomicWrite?: () => Promise<BaseAtomicStatusResponse>;
  operon?: () => Promise<Record<string, unknown>>;
}

export interface GovernedRuntimeAvailability {
  note: boolean;
  canvas: boolean;
  base: boolean;
}

const TOOL_FAMILIES: Readonly<Record<CapabilityId, readonly string[]>> = {
  "local-rest": ["obsidian_runtime_status"],
  "vault-read": [
    "obsidian_read_note",
    "obsidian_list_notes",
    "obsidian_global_search",
  ],
  "semantic-search": ["smart_semantic_search"],
  "governed-note-write": [
    "obsidian_note_replace_plan",
    "obsidian_note_replace_apply",
    "obsidian_note_replace_status",
    "obsidian_note_replace_recover",
    "obsidian_text_patch_plan",
    "obsidian_text_patch_apply",
    "obsidian_text_patch_status",
    "obsidian_text_patch_recover",
  ],
  "governed-frontmatter-write": [
    "obsidian_frontmatter_patch_plan",
    "obsidian_frontmatter_patch_apply",
    "obsidian_frontmatter_patch_status",
    "obsidian_frontmatter_patch_recover",
  ],
  "governed-canvas-write": [
    "obsidian_canvas_patch_plan",
    "obsidian_canvas_patch_apply",
    "obsidian_canvas_patch_status",
    "obsidian_canvas_patch_recover",
  ],
  "governed-base-write": [
    "bases_formula_patch_plan",
    "bases_formula_patch_apply",
    "bases_formula_patch_status",
    "bases_formula_patch_recover",
  ],
  "operon-read": ["operon_status", "operon_get_task", "operon_query_tasks"],
  "operon-write": [
    "operon_adopt_task",
    "operon_create_periodic_task",
    "operon_update_periodic_scheduling",
    "operon_create_task",
    "operon_update_task",
    "operon_transition_task",
    "operon_relocate_task",
    "operon_set_relationships",
    "operon_update_recurrence",
    "operon_convert_task",
    "operon_recover_mutation",
  ],
};

const OPERON_WRITE_OPERATIONS = [
  ["adopt", "operon_adopt_task", "adopt"],
  ["periodic-create", "operon_create_periodic_task", "periodicCreate"],
  ["periodic-update", "operon_update_periodic_scheduling", "periodicUpdate"],
  ["create", "operon_create_task", "create"],
  ["update", "operon_update_task", "update"],
  ["transition", "operon_transition_task", "transition"],
  ["relocate", "operon_relocate_task", "relocate"],
  ["relationships", "operon_set_relationships", "relationshipMutation"],
  ["recurrence", "operon_update_recurrence", "recurrenceMutation"],
  ["convert", "operon_convert_task", "convert"],
  ["recovery", "operon_recover_mutation", "recovery"],
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolean(value: unknown): boolean {
  return value === true;
}

function visible(
  visibleToolNames: ReadonlySet<string>,
  capability: CapabilityId,
): boolean {
  const lifecycleFamilies = new Map<string, string[]>();
  for (const name of TOOL_FAMILIES[capability]) {
    const entry = getToolSurfaceEntry(name);
    if (!entry?.lifecycleRole) {
      if (visibleToolNames.has(name)) return true;
      continue;
    }
    const familyTools = lifecycleFamilies.get(entry.family) ?? [];
    familyTools.push(name);
    lifecycleFamilies.set(entry.family, familyTools);
  }
  return [...lifecycleFamilies.values()].some((familyTools) =>
    familyTools.every((name) => visibleToolNames.has(name)),
  );
}

function entry(
  input: CapabilityManifestProjectionInput,
  id: CapabilityId,
  available: boolean,
  authorized: boolean,
  reasonCode: CapabilityReasonCode,
  nextAction: CapabilityNextAction,
  degraded = false,
): CapabilityManifestEntry {
  const profileAllows = visible(new Set(input.profileToolNames), id);
  const modeAllows = visible(new Set(input.modeToolNames), id);
  const isDiscoverable = visible(new Set(input.visibleToolNames), id);
  if (!profileAllows) {
    return {
      id,
      discoverable: false,
      available,
      authorized,
      state: "hidden",
      reasonCode: "profile_hidden",
      nextAction: "switch_tool_profile",
      preferredTools: TOOL_FAMILIES[id],
    };
  }
  if (!modeAllows) {
    return {
      id,
      discoverable: false,
      available,
      authorized,
      state: "unavailable",
      reasonCode: "runtime_mode_unavailable",
      nextAction: "use_live_runtime",
      preferredTools: TOOL_FAMILIES[id],
    };
  }
  if (!isDiscoverable) {
    return {
      id,
      discoverable: false,
      available,
      authorized,
      state: "unavailable",
      reasonCode: "runtime_not_initialized",
      nextAction: "restart_mcp_runtime",
      preferredTools: TOOL_FAMILIES[id],
    };
  }
  return {
    id,
    discoverable: true,
    available,
    authorized,
    state: !available
      ? "unavailable"
      : !authorized
        ? "blocked"
        : degraded
          ? "degraded"
          : "ready",
    reasonCode,
    nextAction,
    preferredTools: TOOL_FAMILIES[id],
  };
}

function localRestCapability(
  input: CapabilityManifestProjectionInput,
): CapabilityManifestEntry {
  if (input.localRest.state === "ready") {
    const authenticated = boolean(record(input.localRest.value).authenticated);
    return entry(
      input,
      "local-rest",
      true,
      authenticated,
      authenticated ? "ready" : "local_rest_unauthorized",
      authenticated ? "none" : "verify_local_rest_credentials",
    );
  }
  if (input.localRest.state === "unauthorized") {
    return entry(
      input,
      "local-rest",
      true,
      false,
      "local_rest_unauthorized",
      "verify_local_rest_credentials",
    );
  }
  const configured =
    input.registrationMode !== "hybrid-degraded" &&
    !input.registrationMode.startsWith("headless-");
  return entry(
    input,
    "local-rest",
    false,
    false,
    configured ? "local_rest_unreachable" : "local_rest_not_configured",
    configured ? "start_obsidian_and_retry" : "configure_local_rest",
  );
}

function vaultReadCapability(
  input: CapabilityManifestProjectionInput,
): CapabilityManifestEntry {
  const restReady =
    input.localRest.state === "ready" &&
    input.localRest.value.authenticated === true;
  if (restReady) {
    return entry(input, "vault-read", true, true, "ready", "none");
  }
  if (input.cacheReady) {
    return entry(
      input,
      "vault-read",
      true,
      true,
      "cache_fallback",
      "refresh_vault_cache",
      true,
    );
  }
  return entry(
    input,
    "vault-read",
    false,
    false,
    "vault_backend_unavailable",
    "start_obsidian_and_retry",
  );
}

function semanticCapability(
  input: CapabilityManifestProjectionInput,
): CapabilityManifestEntry {
  if (!input.semanticEnabled) {
    return entry(
      input,
      "semantic-search",
      false,
      false,
      "semantic_search_disabled",
      "enable_semantic_search",
    );
  }
  if (!input.queryEmbeddingEnabled) {
    return entry(
      input,
      "semantic-search",
      false,
      false,
      "semantic_query_embedding_disabled",
      "enable_query_embedding",
    );
  }
  const validated =
    input.semanticIndex.state === "ready" &&
    Number.isFinite(input.semanticIndex.value.vectorCount) &&
    input.semanticIndex.value.vectorCount > 0;
  const embedderReady =
    input.semanticIndex.state === "ready" &&
    input.semanticIndex.value.embedderReady === true;
  return entry(
    input,
    "semantic-search",
    validated && embedderReady,
    validated && embedderReady,
    !validated
      ? "semantic_index_unavailable"
      : embedderReady
        ? "ready"
        : "semantic_embedder_unavailable",
    !validated
      ? "refresh_semantic_index"
      : embedderReady
        ? "none"
        : "configure_query_embedder",
  );
}

function atomicCapability(
  input: CapabilityManifestProjectionInput,
  id:
    | "governed-note-write"
    | "governed-frontmatter-write"
    | "governed-canvas-write",
): CapabilityManifestEntry {
  if (input.atomicWrite.state !== "ready") {
    const unauthorized = input.atomicWrite.state === "unauthorized";
    return entry(
      input,
      id,
      false,
      false,
      unauthorized
        ? "local_rest_unauthorized"
        : input.atomicWrite.state === "incompatible"
          ? "bridge_contract_incompatible"
          : "bridge_unavailable",
      unauthorized
        ? "verify_local_rest_credentials"
        : input.atomicWrite.state === "incompatible"
          ? "update_bridge_contract"
          : "install_or_enable_bridge",
    );
  }
  const status = record(input.atomicWrite.value);
  const backend = record(status.backend);
  const lifecycle = record(status.lifecycle);
  const lifecycleReady =
    lifecycle.state === undefined || lifecycle.state === "ready";
  const contractReady =
    status.ok === true &&
    status.contractVersion === 1 &&
    backend.atomicCas === true;
  const canvas = id === "governed-canvas-write";
  const available = canvas
    ? contractReady && lifecycleReady && backend.canvasAtomicCas === true
    : contractReady && lifecycleReady;
  const bridgeAuthorized = canvas
    ? backend.canvasWriteEnabled === true
    : backend.writeEnabled === true;
  const writePolicyAllows = input.writeMode !== "readonly";
  const authorized = bridgeAuthorized && writePolicyAllows;
  return entry(
    input,
    id,
    available,
    available && authorized,
    !lifecycleReady
      ? "bridge_lifecycle_not_ready"
      : !available
        ? "bridge_contract_incompatible"
        : !writePolicyAllows
          ? "write_policy_blocked"
          : bridgeAuthorized
            ? "ready"
            : "bridge_write_disabled",
    !lifecycleReady
      ? "wait_for_bridge"
      : !available
        ? "update_bridge_contract"
        : !writePolicyAllows
          ? "enable_write_policy"
          : bridgeAuthorized
            ? "none"
            : "enable_bridge_writes",
  );
}

function baseCapability(
  input: CapabilityManifestProjectionInput,
): CapabilityManifestEntry {
  if (input.baseAtomicWrite.state !== "ready") {
    const unauthorized = input.baseAtomicWrite.state === "unauthorized";
    return entry(
      input,
      "governed-base-write",
      false,
      false,
      unauthorized
        ? "local_rest_unauthorized"
        : input.baseAtomicWrite.state === "incompatible"
          ? "bridge_contract_incompatible"
          : "bridge_unavailable",
      unauthorized
        ? "verify_local_rest_credentials"
        : input.baseAtomicWrite.state === "incompatible"
          ? "update_bridge_contract"
          : "install_or_enable_bridge",
    );
  }
  const status = record(input.baseAtomicWrite.value);
  const backend = record(status.backend);
  const lifecycle = record(status.lifecycle);
  const lifecycleReady =
    lifecycle.state === undefined || lifecycle.state === "ready";
  const available =
    status.ok === true &&
    status.contractVersion === 1 &&
    backend.atomicCas === true &&
    lifecycleReady;
  const bridgeAuthorized = backend.writeEnabled === true;
  const writePolicyAllows = input.writeMode !== "readonly";
  const authorized = available && bridgeAuthorized && writePolicyAllows;
  return entry(
    input,
    "governed-base-write",
    available,
    authorized,
    !lifecycleReady
      ? "bridge_lifecycle_not_ready"
      : !available
        ? "bridge_contract_incompatible"
        : !writePolicyAllows
          ? "write_policy_blocked"
          : bridgeAuthorized
            ? "ready"
            : "bridge_write_disabled",
    !lifecycleReady
      ? "wait_for_bridge"
      : !available
        ? "update_bridge_contract"
        : !writePolicyAllows
          ? "enable_write_policy"
          : bridgeAuthorized
            ? "none"
            : "enable_bridge_writes",
  );
}

function unavailableOperonWrite(
  input: CapabilityManifestProjectionInput,
  reasonCode: CapabilityReasonCode,
  nextAction: CapabilityNextAction,
): CapabilityManifestEntry {
  const profileNames = new Set(input.profileToolNames);
  const modeNames = new Set(input.modeToolNames);
  const visibleNames = new Set(input.visibleToolNames);
  const projected = entry(
    input,
    "operon-write",
    false,
    false,
    reasonCode,
    nextAction,
  );
  projected.operations = OPERON_WRITE_OPERATIONS.map(([id, tool]) => ({
    id,
    tool,
    discoverable: visibleNames.has(tool),
    available: false,
    authorized: false,
    reasonCode: !profileNames.has(tool)
      ? "profile_hidden"
      : !modeNames.has(tool)
        ? "runtime_mode_unavailable"
        : !visibleNames.has(tool)
          ? "runtime_not_initialized"
          : reasonCode,
    nextAction: !profileNames.has(tool)
      ? "switch_tool_profile"
      : !modeNames.has(tool)
        ? "use_live_runtime"
        : !visibleNames.has(tool)
          ? "restart_mcp_runtime"
          : nextAction,
  }));
  return projected;
}

function operonCapabilities(input: CapabilityManifestProjectionInput): {
  read: CapabilityManifestEntry;
  write: CapabilityManifestEntry;
} {
  if (input.operon.state !== "ready") {
    const reason: CapabilityReasonCode =
      input.operon.state === "incompatible"
        ? "operon_incompatible"
        : "operon_not_present";
    const action: CapabilityNextAction =
      input.operon.state === "incompatible"
        ? "load_or_update_operon"
        : "install_or_enable_bridge";
    return {
      read: entry(input, "operon-read", false, false, reason, action),
      write: unavailableOperonWrite(input, reason, action),
    };
  }

  const envelope = input.operon.value;
  const live = record(envelope.live);
  const snapshot = record(envelope.snapshot);
  if (Object.keys(live).length === 0 && Object.keys(snapshot).length > 0) {
    const snapshotCapabilities = record(snapshot.capabilities);
    const snapshotReads =
      boolean(snapshotCapabilities.list) && boolean(snapshotCapabilities.query);
    return {
      read: entry(
        input,
        "operon-read",
        snapshotReads,
        snapshotReads,
        snapshotReads
          ? "operon_snapshot_fallback"
          : "operon_read_capability_missing",
        snapshotReads ? "start_obsidian_and_retry" : "load_or_update_operon",
        snapshotReads,
      ),
      write: unavailableOperonWrite(
        input,
        "operon_live_required",
        "start_obsidian_and_retry",
      ),
    };
  }
  const operon = record(live.operon);
  const index = record(live.index);
  const capabilities = record(live.capabilities);
  const bridge = record(live.bridge);
  const present = boolean(operon.present);
  const compatible = boolean(operon.compatible);
  const indexReady = boolean(index.ready);
  const duplicateConflictCount =
    typeof index.duplicateConflictCount === "number"
      ? index.duplicateConflictCount
      : 0;
  const reads = boolean(capabilities.list) && boolean(capabilities.query);
  const readAvailable =
    present &&
    compatible &&
    indexReady &&
    duplicateConflictCount === 0 &&
    reads;
  let readReason: CapabilityReasonCode = "ready";
  let readAction: CapabilityNextAction = "none";
  if (!present) {
    readReason = "operon_not_present";
    readAction = "load_or_update_operon";
  } else if (!compatible) {
    readReason = "operon_incompatible";
    readAction = "load_or_update_operon";
  } else if (!indexReady) {
    readReason = "operon_index_not_ready";
    readAction = "wait_for_operon_index";
  } else if (duplicateConflictCount > 0) {
    readReason = "operon_duplicate_conflicts";
    readAction = "resolve_operon_duplicates";
  } else if (!reads) {
    readReason = "operon_read_capability_missing";
    readAction = "load_or_update_operon";
  }

  const profileNames = new Set(input.profileToolNames);
  const modeNames = new Set(input.modeToolNames);
  const visibleNames = new Set(input.visibleToolNames);
  const mutationsEnabled = boolean(bridge.mutationsEnabled);
  const operations: CapabilityOperationEntry[] = OPERON_WRITE_OPERATIONS.map(
    ([id, tool, capabilityName]) => {
      const profileAllows = profileNames.has(tool);
      const modeAllows = modeNames.has(tool);
      const isDiscoverable = visibleNames.has(tool);
      const advertised = boolean(capabilities[capabilityName]);
      const guardedApplyAllowed =
        id === "recurrence" || id === "recovery"
          ? false
          : id === "periodic-create"
            ? !input.operonAllowedPathPrefixesConfigured
            : id === "convert"
              ? input.operonAllowedPathPrefixesConfigured
              : true;
      const writePolicyAllows =
        input.writeMode === "full" ||
        (input.writeMode === "guarded" && guardedApplyAllowed);
      const pathScopeAllows =
        !input.operonAllowedPathPrefixesConfigured ||
        (id !== "periodic-create" && id !== "recovery");
      const operationPolicyAllows = writePolicyAllows && pathScopeAllows;
      const reasonCode: CapabilityReasonCode = !profileAllows
        ? "profile_hidden"
        : !modeAllows
          ? "runtime_mode_unavailable"
          : !isDiscoverable
            ? "runtime_not_initialized"
            : !readAvailable
              ? readReason
              : !mutationsEnabled
                ? "operon_mutations_disabled"
                : !input.operonMutationsEnabled
                  ? "mcp_operon_mutations_disabled"
                  : input.writeMode === "readonly"
                    ? "write_policy_blocked"
                    : !operationPolicyAllows
                      ? "operation_policy_blocked"
                      : advertised
                        ? "ready"
                        : "operon_capability_not_advertised";
      const nextAction: CapabilityNextAction = !profileAllows
        ? "switch_tool_profile"
        : !modeAllows
          ? "use_live_runtime"
          : !isDiscoverable
            ? "restart_mcp_runtime"
            : !readAvailable
              ? readAction
              : !mutationsEnabled
                ? "enable_operon_mutations"
                : !input.operonMutationsEnabled
                  ? "enable_mcp_operon_mutations"
                  : input.writeMode === "readonly"
                    ? "enable_write_policy"
                    : !operationPolicyAllows
                      ? "review_operation_policy"
                      : advertised
                        ? "none"
                        : "negotiate_exact_operon_capability";
      return {
        id,
        tool,
        discoverable: isDiscoverable,
        available: readAvailable,
        authorized:
          readAvailable &&
          mutationsEnabled &&
          input.operonMutationsEnabled &&
          operationPolicyAllows &&
          advertised,
        reasonCode,
        nextAction,
      };
    },
  );
  const discoverableOperations = operations.filter(
    (operation) => operation.discoverable,
  );
  const authorizedWriteCount = discoverableOperations.filter(
    (operation) => operation.authorized,
  ).length;
  const writeAvailable = readAvailable;
  const writeAuthorized =
    discoverableOperations.length > 0 &&
    authorizedWriteCount === discoverableOperations.length;
  const writeReason: CapabilityReasonCode = !readAvailable
    ? readReason
    : !mutationsEnabled
      ? "operon_mutations_disabled"
      : !input.operonMutationsEnabled
        ? "mcp_operon_mutations_disabled"
        : input.writeMode === "readonly"
          ? "write_policy_blocked"
          : writeAuthorized
            ? "ready"
            : authorizedWriteCount > 0
              ? "operon_partial_capabilities"
              : "operon_capability_not_advertised";
  const writeAction: CapabilityNextAction = !readAvailable
    ? readAction
    : !mutationsEnabled
      ? "enable_operon_mutations"
      : !input.operonMutationsEnabled
        ? "enable_mcp_operon_mutations"
        : input.writeMode === "readonly"
          ? "enable_write_policy"
          : writeAuthorized
            ? "none"
            : "negotiate_exact_operon_capability";

  return {
    read: entry(
      input,
      "operon-read",
      readAvailable,
      readAvailable,
      readReason,
      readAction,
    ),
    write: (() => {
      const projected = entry(
        input,
        "operon-write",
        writeAvailable,
        writeAuthorized,
        writeReason,
        writeAction,
      );
      if (
        projected.state === "blocked" &&
        writeReason === "operon_partial_capabilities"
      ) {
        projected.state = "degraded";
      }
      projected.operations = operations;
      return projected;
    })(),
  };
}

export function projectCapabilityManifest(
  input: CapabilityManifestProjectionInput,
): CapabilityManifest {
  const operon = operonCapabilities(input);
  const capabilities: CapabilityManifestEntry[] = [
    localRestCapability(input),
    vaultReadCapability(input),
    semanticCapability(input),
    atomicCapability(input, "governed-note-write"),
    atomicCapability(input, "governed-frontmatter-write"),
    atomicCapability(input, "governed-canvas-write"),
    baseCapability(input),
    operon.read,
    operon.write,
  ];
  const summary = {
    ready: capabilities.filter((item) => item.state === "ready").length,
    degraded: capabilities.filter((item) => item.state === "degraded").length,
    blocked: capabilities.filter((item) => item.state === "blocked").length,
    unavailable: capabilities.filter((item) => item.state === "unavailable")
      .length,
    hidden: capabilities.filter((item) => item.state === "hidden").length,
  };
  const admissionPressured =
    input.admission.queued > 0 ||
    input.admission.rejectedQueueFull > 0 ||
    input.admission.rejectedIdentityQueueFull > 0 ||
    input.admission.timedOut > 0 ||
    input.admission.cancelled > 0;
  return {
    contractVersion: CAPABILITY_MANIFEST_CONTRACT_VERSION,
    profile: input.profile,
    registrationMode: input.registrationMode,
    probeTimeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    summary,
    admission: {
      transport: input.transport,
      state:
        input.transport === "stdio"
          ? "not-applicable"
          : admissionPressured
            ? "pressured"
            : "ready",
      ...input.admission,
    },
    capabilities,
  };
}

function normalizeProbeError<T>(error: unknown): NormalizedProbe<T> {
  if (
    error instanceof McpError &&
    (error.code === BaseErrorCode.UNAUTHORIZED ||
      error.code === BaseErrorCode.FORBIDDEN)
  ) {
    return { state: "unauthorized" };
  }
  if (
    error instanceof McpError &&
    (error.code === BaseErrorCode.PARSING_ERROR ||
      error.code === BaseErrorCode.VALIDATION_ERROR)
  ) {
    return { state: "incompatible" };
  }
  return { state: "unavailable" };
}

async function probe<T>(
  operation: () => Promise<T>,
): Promise<NormalizedProbe<T>> {
  let timeout: NodeJS.Timeout | undefined;
  const bounded = new Promise<NormalizedProbe<T>>((resolve) => {
    timeout = setTimeout(
      () => resolve({ state: "unavailable" }),
      CAPABILITY_PROBE_TIMEOUT_MS,
    );
    timeout.unref();
  });
  const attempted = Promise.resolve()
    .then(operation)
    .then<NormalizedProbe<T>>((value) => ({ state: "ready", value }))
    .catch((error: unknown) => normalizeProbeError<T>(error));
  try {
    return await Promise.race([attempted, bounded]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runtimeBoolean(
  runtimeStatus: unknown,
  section: string,
  property: string,
): boolean {
  return boolean(record(record(runtimeStatus)[section])[property]);
}

export function resolveToolRegistrationMode(
  obsidianService: ObsidianRestApiService | undefined,
): ToolRegistrationMode {
  if (config.obsidianRuntimeMode === "live") return "live";
  if (config.obsidianRuntimeMode === "hybrid") {
    return obsidianService ? "hybrid-live" : "hybrid-degraded";
  }
  return config.obsidianRuntimeMode;
}

export async function collectCapabilityManifest(options: {
  profile: ToolProfileId;
  registrationMode: ToolRegistrationMode;
  runtimeStatus: unknown;
  obsidianService: ObsidianRestApiService | undefined;
  vaultCacheAvailable: boolean;
  probes?: CapabilityProbeDependencies;
  governedRuntimes: GovernedRuntimeAvailability;
}): Promise<CapabilityManifest> {
  const context = requestContextService.createRequestContext({
    operation: "collectCapabilityManifest",
  });
  const operonService = new OperonService();
  const staticRequirements = options.vaultCacheAvailable
    ? (["vault-cache"] as const)
    : [];
  const profileToolNames = compileToolProfileNames({
    profile: options.profile,
    registrationMode: "live",
    availableStaticRequirements: staticRequirements,
  });
  const modeToolNames = compileToolProfileNames({
    profile: options.profile,
    registrationMode: options.registrationMode,
    availableStaticRequirements: staticRequirements,
  });
  const semanticEnabled = runtimeBoolean(
    options.runtimeStatus,
    "semanticCache",
    "enabled",
  );
  const localRestProbe =
    options.probes?.localRest ??
    (options.obsidianService
      ? () =>
          options.obsidianService!.checkStatus(
            context,
            CAPABILITY_PROBE_TIMEOUT_MS,
          )
      : undefined);
  const atomicWriteProbe =
    options.probes?.atomicWrite ??
    (options.obsidianService
      ? () =>
          options.obsidianService!.getAtomicWriteStatus(
            context,
            CAPABILITY_PROBE_TIMEOUT_MS,
          )
      : undefined);
  const baseAtomicWriteProbe =
    options.probes?.baseAtomicWrite ??
    (options.obsidianService
      ? () =>
          options.obsidianService!.getBaseAtomicStatus(
            context,
            CAPABILITY_PROBE_TIMEOUT_MS,
          )
      : undefined);
  const operonProbe =
    options.probes?.operon ??
    (() => operonService.status(false, CAPABILITY_PROBE_TIMEOUT_MS));
  const semanticIndexProbe =
    semanticEnabled &&
    config.enableQueryEmbedding &&
    modeToolNames.includes("smart_semantic_search")
      ? (options.probes?.semanticIndex ??
        (async () => {
          const readiness = await getSemanticCacheService().probeReadiness();
          try {
            await getQueryEmbedder({
              provider: config.queryEmbedder,
              modelHint: config.queryEmbedderModelHint,
              model: config.queryEmbedderModel,
              vaultModel: readiness.dominantModel,
              dimension: readiness.dominantDimension,
              ollamaBaseUrl: config.ollamaBaseUrl,
              openaiApiKey: config.openaiApiKey,
              openaiBaseUrl: config.openaiBaseUrl,
              openaiDimensions: Number.isFinite(
                Number(config.openaiEmbeddingDimensions),
              )
                ? Number(config.openaiEmbeddingDimensions)
                : undefined,
            });
            return { ...readiness, embedderReady: true };
          } catch {
            return { ...readiness, embedderReady: false };
          }
        }))
      : undefined;
  const unavailable = Promise.resolve<NormalizedProbe<never>>({
    state: "unavailable",
  });
  const [localRest, semanticIndex, atomicWrite, baseAtomicWrite, operon] =
    await Promise.all([
      localRestProbe ? probe(localRestProbe) : unavailable,
      semanticIndexProbe ? probe(semanticIndexProbe) : unavailable,
      atomicWriteProbe ? probe(atomicWriteProbe) : unavailable,
      baseAtomicWriteProbe ? probe(baseAtomicWriteProbe) : unavailable,
      probe(operonProbe),
    ]);
  const unavailableGovernedNames = new Set<string>([
    ...(!options.governedRuntimes.note
      ? [
          ...TOOL_FAMILIES["governed-note-write"],
          ...TOOL_FAMILIES["governed-frontmatter-write"],
        ]
      : []),
    ...(!options.governedRuntimes.canvas
      ? TOOL_FAMILIES["governed-canvas-write"]
      : []),
    ...(!options.governedRuntimes.base
      ? TOOL_FAMILIES["governed-base-write"]
      : []),
  ]);
  const visibleToolNames = modeToolNames.filter(
    (name) => !unavailableGovernedNames.has(name),
  );
  const admission = httpAdmissionController.getSnapshot();
  return projectCapabilityManifest({
    profile: options.profile,
    registrationMode: options.registrationMode,
    profileToolNames,
    modeToolNames,
    visibleToolNames,
    transport: config.mcpTransportType,
    cacheReady: runtimeBoolean(options.runtimeStatus, "sharedCache", "ready"),
    semanticEnabled,
    queryEmbeddingEnabled: config.enableQueryEmbedding,
    semanticIndex,
    operonMutationsEnabled: config.operonMutationsEnabled,
    writeMode: config.mcpWriteMode,
    operonAllowedPathPrefixesConfigured:
      config.operonMutationAllowedPathPrefixes.length > 0,
    localRest,
    atomicWrite,
    baseAtomicWrite,
    operon,
    admission: {
      inFlight: admission.inFlight,
      queued: admission.queued,
      rejectedQueueFull: admission.rejectedQueueFull,
      rejectedIdentityQueueFull: admission.rejectedIdentityQueueFull,
      timedOut: admission.timedOut,
      cancelled: admission.cancelled,
    },
  });
}
