/**
 * @module ObsidianRestApiTypes
 * @description
 * Type definitions for interacting with the Obsidian Local REST API,
 * based on its OpenAPI specification.
 */

import { AxiosRequestConfig } from "axios";
import { RequestContext } from "../../utils/index.js";

/**
 * Defines the signature for the internal request function passed to method implementations.
 * This function is bound to the `ObsidianRestApiService` instance and handles the core
 * logic of making an HTTP request, including authentication, error handling, and logging.
 *
 * @template T The expected return type of the API call.
 * @param config The Axios request configuration.
 * @param context The request context for logging and correlation.
 * @param operationName A descriptive name for the operation being performed, used for logging.
 * @returns A promise that resolves with the data of type `T`.
 */
export type RequestFunction = <T = any>(
  config: AxiosRequestConfig,
  context: RequestContext,
  operationName: string,
) => Promise<T>;

export type AtomicWriteReadRequest = {
  contractVersion: 1;
  path: string;
};

export type AtomicWriteCasRequest = AtomicWriteReadRequest & {
  bindingFingerprint: string;
  expectedSha256: string;
  nextContent: string;
};

export type AtomicWriteStatusResponse = {
  ok: true;
  contractVersion: 1;
  plugin: { id: string; version: string };
  backend: {
    kind: "obsidian-vault-process";
    bindingFingerprint: string;
    atomicCas: true;
    writeEnabled: boolean;
  };
  limits: { markdownOnly: true };
  settlement?: {
    contractVersion: 1;
    modifiedTimeFrontmatter: {
      integrations: Array<{
        pluginId:
          | "update-time-on-edit"
          | "frontmatter-date-manager"
          | "update-time";
        propertyName: string;
        settlementObservationDelayMs?: number;
      }>;
      utcOffsetMinutes: number;
    };
  };
  protection?: {
    contractVersion: 1;
    frontmatterDateProperties: {
      integrations: Array<{
        pluginId:
          | "update-time-on-edit"
          | "frontmatter-date-manager"
          | "update-time";
        createdPropertyName?: string;
        modifiedPropertyName?: string;
        viewedPropertyName?: string;
      }>;
      unsupportedIntegrations?: Array<{
        pluginId:
          | "update-time-on-edit"
          | "frontmatter-date-manager"
          | "update-time";
        activeRoles: Array<"created" | "modified" | "viewed">;
      }>;
    };
  };
};

export type AtomicWriteReadResponse = {
  ok: true;
  contractVersion: 1;
  path: string;
  content: string;
  sha256: string;
  size: number;
  bindingFingerprint: string;
};

export type AtomicWriteCasResponse = {
  ok: true;
  contractVersion: 1;
  path: string;
  beforeSha256: string;
  afterSha256: string;
  size: number;
  bindingFingerprint: string;
};

export type BaseAtomicReadRequest = {
  contractVersion: 1;
  path: string;
};

export type BaseAtomicCasRequest = BaseAtomicReadRequest & {
  bindingFingerprint: string;
  expectedSha256: string;
  nextYaml: string;
};

export type BaseAtomicStatusResponse = {
  ok: true;
  contractVersion: 1;
  plugin: { id: string; version: string };
  backend: {
    kind: "obsidian-vault-process-base";
    bindingFingerprint: string;
    atomicCas: true;
    writeEnabled: boolean;
  };
  limits: { baseOnly: true; sourcePreservingCompilerRequired: true };
  migration: { legacyConfigWritesEnabled: boolean };
};

export type BaseAtomicReadResponse = {
  ok: true;
  contractVersion: 1;
  path: string;
  yaml: string;
  sha256: string;
  size: number;
  bindingFingerprint: string;
};

export type BaseAtomicCasResponse = {
  ok: true;
  contractVersion: 1;
  path: string;
  beforeSha256: string;
  afterSha256: string;
  size: number;
  bindingFingerprint: string;
};

/**
 * Filesystem metadata for a note.
 */
export interface NoteStat {
  ctime: number; // Creation time (Unix timestamp)
  mtime: number; // Modification time (Unix timestamp)
  size: number; // File size in bytes
}

/**
 * JSON representation of an Obsidian note.
 * Returned when requesting with Accept: application/vnd.olrapi.note+json
 */
export interface NoteJson {
  content: string;
  frontmatter: Record<string, any>; // Parsed YAML frontmatter
  path: string; // Vault-relative path
  stat: NoteStat;
  tags: string[]; // Tags found in the note (including frontmatter)
}

/**
 * Response structure for listing files in a directory.
 */
export interface FileListResponse {
  files: string[]; // List of file/directory names (directories end with '/')
}

/**
 * Match details within a simple search result.
 */
export interface SimpleSearchMatchDetail {
  start: number; // Start index of the match
  end: number; // End index of the match
}

/**
 * Contextual match information for simple search.
 */
export interface SimpleSearchMatch {
  context: string; // Text surrounding the match
  match: SimpleSearchMatchDetail;
}

/**
 * Result item for a simple text search.
 */
export interface SimpleSearchResult {
  filename: string; // Path to the matching file
  matches: SimpleSearchMatch[];
  score: number; // Relevance score
}

/**
 * Result item for a complex (Dataview/JsonLogic) search.
 */
export interface ComplexSearchResult {
  filename: string; // Path to the matching file
  result: any; // The result returned by the query logic for this file
}

/**
 * Structure for an available Obsidian command.
 */
export interface ObsidianCommand {
  id: string;
  name: string;
}

/**
 * Response structure for listing available commands.
 */
export interface CommandListResponse {
  commands: ObsidianCommand[];
}

/**
 * Basic status response from the API root.
 */
export interface ApiStatusResponse {
  authenticated: boolean;
  ok: string; // Should be "OK"
  service: string; // Should be "Obsidian Local REST API"
  versions: {
    obsidian: string; // Obsidian API version
    self: string; // Plugin version
  };
}

/**
 * Standard error response structure from the API.
 */
export interface ApiError {
  errorCode: number; // e.g., 40149
  message: string; // e.g., "A brief description of the error."
}

/**
 * Summary information for a Base definition discovered in the vault.
 */
export interface BaseSummary {
  id: string;
  name: string;
  path: string;
}

/**
 * Response returned by the bridge when listing bases.
 */
export interface BasesListResponse {
  bases: BaseSummary[];
}

/**
 * Property description inside a base schema.
 */
export interface BaseSchemaProperty {
  key: string;
  kind: "note" | "file" | "formula" | "unknown";
  displayName?: string;
  valueType?: string;
}

/**
 * View description exposed by a base schema.
 */
export interface BaseSchemaView {
  name: string;
  type: string;
  limit?: number;
  order?: string[];
  filters?: Record<string, unknown> | string[] | undefined;
  description?: string;
}

/**
 * Detailed schema information for a given base.
 */
export interface BaseSchemaResponse {
  id: string;
  path: string;
  name?: string;
  properties: BaseSchemaProperty[];
  formulas?: Record<string, unknown>;
  views: BaseSchemaView[];
  filters?: Record<string, unknown>;
}

/**
 * Request payload accepted by the query endpoint.
 */
export interface BaseQueryRequest {
  view?: string;
  filter?: Record<string, unknown>;
  sort?: Array<{
    prop: string;
    dir?: "asc" | "desc";
  }>;
  limit?: number;
  page?: number;
  evaluate?: boolean;
}

/**
 * Structure of a row returned by the query endpoint.
 */
export interface BaseQueryRow {
  file: {
    path: string;
    name: string;
  };
  props: Record<string, unknown>;
  computed?: Record<string, unknown>;
}

/**
 * Response payload emitted by the query endpoint.
 */
export interface BaseQueryResponse {
  total: number;
  page: number;
  rows: BaseQueryRow[];
  evaluate?: boolean;
  source?: "engine" | "fallback" | "local-fallback";
  limitations?: string[];
}

/**
 * Operation accepted by the upsert endpoint.
 */
export interface BaseUpsertOperation {
  file: string;
  set?: Record<string, unknown>;
  unset?: string[];
  expected_mtime?: number;
}

/**
 * Request payload accepted by the upsert endpoint.
 */
export interface BaseUpsertRequest {
  operations: BaseUpsertOperation[];
  continueOnError?: boolean;
  dryRun?: boolean;
  requestTimeoutMs?: number;
}

/**
 * Result for a single upsert operation.
 */
export interface BaseUpsertResult {
  file: string;
  mtime: number;
  attempts?: number;
  changed?: {
    keys: string[];
    unset?: string[];
  };
  warnings?: string[];
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Response payload emitted by the upsert endpoint.
 */
export interface BaseUpsertResponse {
  ok: boolean;
  results: BaseUpsertResult[];
  summary?: {
    total_count: number;
    changed_count: number;
    failed_count: number;
    skipped_count?: number;
    retryable_error_count?: number;
    retried_count?: number;
    dry_run?: boolean;
    failed_operations?: Array<{
      file: string;
      code: string;
      message: string;
      retryable?: boolean;
      attempts?: number;
    }>;
  };
  diagnostics?: {
    source: "bases-bridge-rest" | "preflight" | "request-failed";
    base_id?: string;
    phase?: string;
    message?: string;
    recommendation?: string;
  };
}

/**
 * Request payload used to create a new base file.
 */
export interface BaseCreateRequest {
  path: string;
  spec: Record<string, unknown>;
  overwrite?: boolean;
  validateOnly?: boolean;
}

/**
 * Response payload when creating a new base.
 */
export interface BaseCreateResponse {
  ok: boolean;
  id: string;
  warnings?: string[];
}

/**
 * Response when fetching a base configuration as YAML/JSON.
 */
export interface BaseConfigResponse {
  id: string;
  yaml: string;
  json?: Record<string, unknown>;
}

/**
 * Request payload for updating/replacing a base configuration.
 */
export interface BaseConfigUpsertRequest {
  yaml?: string;
  json?: Record<string, unknown>;
  validateOnly?: boolean;
}

/**
 * Response payload from updating/replacing a base configuration.
 */
export interface BaseConfigUpsertResponse {
  ok: boolean;
  id: string;
  warnings?: string[];
}

/**
 * Values accepted by the JSON-native markdown-patch 2.x contract.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Destination used when moving a heading (`scope: "parent"`).
 */
export interface PatchDestination {
  parent: string[] | null;
  place:
    | "first"
    | "last"
    | { before: string[] | null }
    | { after: string[] | null };
}

/**
 * Payload supplied to a markdown-patch 2.x instruction.
 *
 * The request builder maps it to `content`, `value`, or `destination` from the
 * target type and scope. `undefined` is valid only for a delete instruction.
 */
export type PatchPayload = JsonValue | PatchDestination | undefined;

interface PatchOptionsBase {
  operation: "append" | "prepend" | "replace" | "delete";
  scope?: "content" | "marker" | "markerAndContent" | "parent";
  /**
   * Optimistic-concurrency token returned as `version` by a document map.
   */
  ifMatch?: string;
  createTargetIfMissing?: boolean;
  rejectIfContentPreexists?: boolean;
}

/**
 * Options for a JSON-native markdown-patch 2.x operation.
 *
 * Heading targets are addressed by an array from the top-level heading to the
 * target. `null` or an empty array addresses the document root. Block and
 * frontmatter targets remain scalar identifiers.
 */
export type PatchOptions =
  | (PatchOptionsBase & {
      targetType: "heading";
      target: string[] | null;
      within?: number;
    })
  | (PatchOptionsBase & {
      targetType: "block" | "frontmatter";
      target: string;
      within?: never;
    });
